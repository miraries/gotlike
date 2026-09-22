---
name: nock-shim
description: The nock-compatible mocking shim in src/nock.ts — every translation from nock semantics onto undici MockAgent, and the ones that silently fall through to the real network when written wrong. Read before changing src/nock.ts, src/nock.spec.ts, src/nock-default.spec.ts, or any nock parity scenario.
---

# Mocking (src/nock.ts)

`nock.ts` calls `setGlobalDispatcher(new MockAgent())` at import time (skipped when `NOCK_OFF=true`). Because
the client resolves the global dispatcher per request, import order no longer matters. Instances built with
their own agent still bypass the mock — `retry` no longer does, since it is an interceptor rather than a
separate `RetryAgent`.

The shim is a translation layer over `MockAgent`, and the translations that are easy to get wrong:

- **A regex origin is keyed by its pattern, not by the RegExp object.** undici keys a non-string origin by object
  identity, so `nock(/api\.test/)` written twice — two RegExp objects — registered two mock pools. undici resolves
  a concrete origin against the *first* regex pool it finds and caches that pool's dispatch list under the origin,
  so everything on the second pool was invisible and those requests went out to the **real network**. `poolKey`
  canonicalises the pattern so one pool backs every scope written with it. Real nock matches both; measured
  against nock 14.
- **`cleanAll()` empties a pool's dispatch array in place rather than calling `cleanMocks()`** — which assigns a
  *new* array, while the concrete-origin pool undici derived from a regex one still holds the old one. That left a
  regex origin working exactly once per host per process: everything registered after the first `cleanAll()`
  landed on an array nothing was reading, and fell through to the network. The array is reached by looking
  undici's `dispatches` symbol up by description, since its mock symbols are module-local; if a future undici
  moves it, `dispatchesOf` returns nothing and `cleanAll` falls back to `cleanMocks()`. Regex entries stay in the
  `pools` map across a clean for the same reason — handing back a *different* pool is what breaks the derived
  ones.
- **A `Scope` reused after a `cleanAll()` puts its entry back in the `pools` map.** String origins are dropped by
  `cleanAll` so the map doesn't just grow, and `Scope#verb` only ever re-activated an entry that was still *in*
  it — so a scope captured once and reused across a clean (`const scope = nock(host)` at the top of a file with
  `cleanAll()` in a `beforeEach`) went on registering interceptors that matched, while `hasMockedOrigin` no
  longer knew the origin was ours. Anything that *missed* those interceptors then fell through to the real
  network instead of failing closed — a live outbound request, silently, which is the one thing owning an origin
  exists to prevent. Covered in `nock-default.spec.ts`, since `nock.spec.ts` calls `disableNetConnect()` up front
  and so can never see a fall-through at all.
- **Two scopes on one origin share an `isDone()` answer**, regex or string: a pending interceptor reports the
  origin it was registered under and nothing finer. nock answers per scope. So does the shim's limit on
  *different* patterns matching one host — undici consults only the first — both documented in the README rather
  than worked around.
- **Base paths.** `nock('https://host/base')` is legal; `mockAgent.get()` only takes an origin. `splitOrigin`
  separates them and every interceptor path gets the prefix folded in.
- **String paths match the full request path including its query**, which is also nock's behaviour. `.query(true)`
  therefore has to become a *function* path matcher that strips the query before comparing.
- **`QueryMatcher` is `true`, not `boolean`.** Real nock throws `Argument Error: false` for `.query(false)` —
  verified against nock 14 — so accepting one here took a call nock rejects outright and silently applied no
  query expectation at all. nock's "must carry no query" is `.query({})`. (A regex path with no `.query()` is
  matched against the path *including* its query, in the shim and in nock alike; that one was checked too.)
- **Object queries must NOT use a function matcher.** undici folds `query` into the interceptor's stored path
  string (`serializePathWithQuery`) and compares strings; a function matcher silently defeats that and matches
  every query. This was a real bug — the test `query(object) matches only those params` guards it.
- **A non-string path can't carry an object query either.** undici only folds `query` into the stored path when
  that path is a string, so behind the function matcher a regex or function path uses for `.query({...})` the
  constraint was dropped entirely and every query matched. `queryMatches` checks it inside the matcher instead;
  `options.query` is only handed to undici when undici is the one that can apply it.
- **A query *value* may be a RegExp, a predicate or an array.** All three went through `String(value)`, which
  turns a RegExp into the literal `"/bar/"` and an array into `"1,2"` — neither of which any real query string
  can equal, so those interceptors silently never matched. `queryValueMatches` handles each shape, and
  `isSerialisableQuery` keeps a RegExp or predicate value away from undici, which would serialise it into its
  stored path. The entry count is compared against the flattened expectation, so a repeated key is only
  satisfied by an array of the same length. **The RegExp and the array are nock's; the predicate is not** — this
  said "as it may in nock" and the nock parity suite measured otherwise. nock 14 compares a query value as a
  string or a RegExp only, so a function value there matches nothing and the request goes to the real network.
  The shim is deliberately more permissive, which is its own hazard: a mock written this way passes here and
  fails on a move back to nock. `.query(fn)` over the whole query *is* nock's, and is the portable form.
- **A RegExp or predicate *inside* an array counts too**, on both sides of that. The array branch compared
  `values[i] === String(item)`, and `isSerialisableQuery` only looked at top-level values — so `{tags: [/news/,
  'updates']}` was both matched by stringifying the regex and handed to undici to stringify again.
  `queryLeafMatches` is the one place a single expected value is applied, shared by the array and scalar branches.
- **`.query(fn)` is a predicate over the whole parsed query**, repeated keys as arrays, and decides exactness for
  itself. nock has this form; it used to be neither typed nor applied, so the function went to undici as if it
  were an expectation object, serialised into the stored path, and matched nothing — which means the request went
  to the real network. `isSerialisableQuery` rejects a function outright, which is what routes it to
  `queryMatches`. A predicate is consulted more than once per dispatch, since undici applies a path matcher
  several times; nock's are pure questions, so that is left alone.
- **An expected body field has to be *present*, not merely read back equal.** `bodyValueMatches` compared
  `expected[key]` with `actual[key]` behind a key-count check, so `{a: undefined}` matched a body of `{b: 'foo'}`:
  the counts agreed and an absent property reads as `undefined` just as the expectation did. `Object.hasOwn`
  guards it now.
- **An object/array body matcher has to become a function matcher.** undici compares a non-RegExp, non-function
  `body` with `===`, so nock's most common form — `nock(host).post('/p', {a: 1})` — never matched anything, and
  because an unmatched interceptor falls through to the *real network*, a test written that way quietly made a
  live outbound request. `toBodyMatcher` JSON-parses the request body and `bodyValueMatches` deep-compares it,
  with nock's leaf matchers (a RegExp tests the value, a function is asked about it) and nock's exactness (every
  field named, nothing besides).
- **An object reply body is labelled `application/json`** (`replyOptions`). nock sets that header; undici's
  MockAgent serialises the body but sets no content-type at all, so anything under test that branches on the
  response's content-type behaved differently against the mock than against the real server — which is the one
  thing a mocking shim must not do. An explicit content-type is left alone.
- **A repeated key in a `URLSearchParams` query has to survive as an array.** `Object.fromEntries` keeps only the
  last, so `.query(new URLSearchParams('a=1&a=2'))` quietly became `{a: '2'}` and matched the wrong requests.
- **A bare host is accepted**, as it is in nock: `nock('mock.test')` threw `ERR_INVALID_URL` out of `new URL`.
  Only a target with no scheme gets `http://` put in front of it.
- **`reply(200, null)` means a body of `null`.** `body ?? ''` coerced it to an empty string, which then failed
  to parse as json.
- **`responseOptions` must always be an object**, never `undefined`, or undici throws `UND_ERR_INVALID_ARG`.
- **`persist()`, `done()` and `isDone()` live on the `Scope`**, which is where nock's docs put them —
  `nock(host).persist().get('/')` and `scope.done()`. `isDone()` filters `pendingInterceptors()` by the scope's
  origin; it used to ask about every origin at once, so an unrelated scope's pending mock made it answer `false`.
- **Reply callbacks** are translated from undici's `(opts) => {statusCode, data, responseOptions}` to nock's
  `function (uri, requestBody) => [status, body, headers]` with `this.req.headers`. The request body is
  JSON-parsed when the content-type says so, as nock does — and a `Buffer`/`Uint8Array` body is decoded to text
  first. nock stringifies the body before the callback ever sees it, so `post(url, {body: Buffer.from(json)})`
  handed the callback a raw `Buffer` here where nock gives the parsed object, and a callback reading
  `requestBody.id` got `undefined` against the mock and the right answer against the server.
- **A streamed upload is drained for the callback, never tee'd.** A `stream.post()` body, or a `FormData` one,
  reaches the mock as a live `Readable` when no composed interceptor implements `onBodySent`/`onRequestSent`
  (`decompress` does and is on by default, so this is the `decompress: false` shape). `resolveRequestBody` used
  to pipe it into two `PassThrough`s — one to read, one put back on `opts.body` for a later read by undici that
  never comes: `dispatchRequestBody` runs *before* `sendReply()` and is the only thing that ever touches the
  body. Nothing drained the second one, so past its 16KB high-water mark `pipe` paused the source, the half
  being read stopped receiving, and the callback's own `await` never resolved. Measured: a 200KB upload never
  settled and the reply callback was never called at all, while a few hundred bytes fit in the buffer and always
  worked — which is why the tests needed a real payload to catch it. The bytes are collected and written back
  onto `opts.body` as a `Buffer`, which is replayable, so a reader appearing later still finds the body.
- **`restore()` puts the previous global dispatcher back**, not just a deactivated mock. `deactivate()` alone
  makes the mock pass requests through, which looks like a restore until the caller had set a dispatcher of their
  own — a proxy agent, or a pool tuned for their workload. That one stayed replaced for the lifetime of the
  process, because the dispatcher that was global before the import was never kept. `originalDispatcher` captures
  it at module load; `activate()` re-installs the mock.
- `cleanAll()` needs the `pools` map — `MockAgent` has no global clear, only `cleanMocks()` per pool. It clears the
  map afterwards as well, so it doesn't just grow for the lifetime of a suite; `Scope` re-fetches from the agent.
  undici's own client map is *not* cleared by this and keeps one `MockClient` per origin ever mocked — measured, 50
  origins leaves 50 behind a `cleanAll()`. Only `mockAgent.close()` empties it, which would end mocking altogether,
  and the map is behind a private symbol. Left alone deliberately: it is a test-time retention with no effect on
  matching, and reaching into undici's internals to fix it costs more than it buys.

`src/nock.spec.ts` covers all of this, with the aggregator's actual patterns (pragmatic's base path + regex,
amigo's `.query(true)`, spribe's capture-via-`reply(function)`) as named tests.

---
name: nock-shim
description: The nock-compatible mocking shim in src/nock.ts — every translation from nock semantics onto undici MockAgent, and the ones that silently fall through to the real network when written wrong. Read before changing src/nock.ts, src/nock.spec.ts, src/nock-default.spec.ts, or any nock parity scenario.
---

# Mocking (src/nock.ts)

`nock.ts` calls `setGlobalDispatcher(new MockAgent())` at import time (skipped when `NOCK_OFF=true`). Because
the client resolves the global dispatcher per request, import order no longer matters. Instances built with
their own agent are routed through it too (`OwnAgentRoute`): they used to bypass the mock outright, so a
`connections`-tuned client skipped every interceptor and ignored `disableNetConnect()` — a live request from a test
that looked mocked. A request goes to the mock for a mocked origin or one net connect closes, and through the
client's own agent otherwise, as nock would; `netConnectAllows` applies nock's own host matching for that (see the net-connect bullet below). A caller's
own `MockAgent` is never rerouted. Covered in `nock-default.spec.ts`.

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
- **Each scope answers `isDone()`/`pendingMocks()`/`activeMocks()` for itself**, as nock's do. undici's pending
  list reports only the origin a dispatch was registered under, so two scopes on one origin used to share an
  answer. Every scope now keeps the dispatch objects it registered (`scopeDispatches`, filled in
  `#applyScopeOptions`, which finds the new one as its pool's last); one `cleanAll()` removed is recognised by no
  longer being in its pool. The same list is how **`persist()` reaches interceptors already registered** - it sets
  undici's own `persist` flag on them, as `MockScope.persist()` does - since `.reply(200).persist()` is a common
  nock spelling and used to answer once. The shim's limit on *different* patterns matching one host (undici
  consults only the first) is still documented in the README rather than worked around.
- **`pendingMocks()`/`activeMocks()` are nock's strings** (`GET http://host:80/base/path`, built by
  `Interceptor#key` from the scope's `keyPrefix`), stored on undici's dispatch under a symbol, which survives the
  spread `pendingInterceptors()` copies it with. `optionally()` is a second symbol, which `pendingDispatches`
  leaves out. Both are read from each pool's own list rather than `pendingInterceptors()`, which repeats a regex
  origin's dispatches once per concrete origin undici derived from it.
- **`enableNetConnect()`/`disableNetConnect()` only govern *unmocked* hosts.** An origin with a scope fails closed
  on a miss whatever they say, as in nock. Both used to switch the per-origin check off for the rest of the
  process, so after the ordinary teardown `nock.enableNetConnect()` a typo'd path on a mocked host became a live
  request — in every mocha file that ran afterwards. They now only record `netConnectPolicy`; the dispatch wrapper
  applies "closed" for a mocked origin and the policy for any other. Covered in `nock-default.spec.ts`.
- **`enableNetConnect(host)` is nock's, not undici's.** It used to be handed to MockAgent's own
  `enableNetConnect(host)`, which differs from nock 14 (`lib/intercept.js`) three ways: a string is compared
  exactly where nock builds a `RegExp` from it, the host loses a default port where nock tests
  `hostname:port` with 80/443 filled in, and each call *adds* to an allow-list where nock's *replaces* the
  matcher. The last failed open — `enableNetConnect('a')` then `enableNetConnect('b')` kept `a` reachable,
  a live request nock would have refused — and the first two failed closed (`enableNetConnect('127.0.0.1')`
  blocked `127.0.0.1:3000`). The dispatch wrapper now makes the whole decision itself from the full origin
  (`netConnectAllows`) and only flips MockAgent open or closed. Pinned against real nock in
  `nock-parity.spec.ts`, including the host string a function matcher is handed.
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
- **A function body matcher is handed the parsed body, not undici's.** undici passes the matcher the body as it
  arrived - a `Buffer`, or `undefined` for none - so `(body) => body.method === 'x'`, the aggregator's way of telling
  JSON-RPC calls on one path apart, never matched. `predicateBody` gives it what nock's `lib/match_body.js` does: the
  JSON-parsed body if it parses, else the text, `''` for none. **Whatever it computes must not depend on the moment
  of the call**: undici applies a body matcher once to find the interceptor inside `dispatch()` and again *after* it
  returns (`matchKey`, from `deleteMockDispatch`) to consume it, so a predicate that answers differently the second
  time matches and then stays pending forever. That is why nock's urlencoded case - parse a form body when the
  content-type says so - is not reproduced: the headers never reach the matcher, and stashing the content-type
  around `mockDispatch` (tried) only covers the first call. Pinned as a divergence in `nock-parity.spec.ts`.
- **`nock(host, options)` applies its options to every interceptor on the scope.** The second argument used to
  be dropped, and three of nock's scope options fail *open* when dropped - the interceptor matched what nock
  would refuse. `scopeHeaders` turns them into header matchers undici already knows how to apply:
  `reqheaders` as they are (an interceptor's own win), `badheaders` as a function that requires the value
  `undefined` (undici hands a function matcher the absent header as `undefined`), and `conditionally` as a
  function on a header name no request carries. `filteringScope` is accepted and not applied - it fails
  *closed* (a scope matches only its own host); throwing on it was tried and broke suites that only ever made
  matching requests.
- **`allowUnmocked` is recorded on the origin** (`PoolEntry.allowUnmocked`, set if *any* scope on it asked -
  nock's `interceptors.some(...)`), and `mockedOrigin` reports such an origin `'open'`, so the dispatch wrapper
  leaves MockAgent's net connect on and undici passes a miss through to the network - whatever
  `disableNetConnect()` says, as in nock, since the host has a scope. A regex entry survives `cleanAll()`, so the
  flag is reset there explicitly.
- **Header requirements reach undici as one function** (`Interceptor#headerMatcher`), evaluated at match time
  over the scope's matchers and the interceptor's own, so a `scope.matchHeader()` added after `reply()` still
  applies, as in nock. `.basicAuth()` is a `matchHeader('authorization', 'Basic ...')`.
- **Header matchers compare as nock's do** (`headerMatchers`, every one wrapped in a function before undici sees
  it). undici runs `re.test(value)` whether or not the header was sent and `/./.test(undefined)` is `true`, so
  `.matchHeader('x-key', /./)` matched a request with no `x-key` at all; a string or RegExp now only matches a
  header that is there. An array header is joined as node joins it (`a, b`), a number compared as its text,
  and a `host` requirement skipped when the request set no `host` (undici derives it rather than carrying
  one). The last three surfaced the moment scope-level `reqheaders` stopped being dropped.
- **An object body matcher also matches an urlencoded form body.** nock parses a form before comparing, so
  `.post('/login', {user: 'a'})` matches `form: {user: 'a'}`; here only JSON was parsed and every such
  interceptor missed. When the body is not JSON, `formBody` parses it as a form (repeated keys as arrays) and the
  matcher's scalar leaves are compared as strings, which is all a form carries. It decides by the body alone,
  not the content-type as nock does, because a body matcher never sees headers and must answer the same on both
  of undici's calls (see the function-matcher bullet below). Nested `qs` keys (`a[b]=1`) are not expanded.
- **A boolean or number reply body is sent as its text** (`replyData`). undici sends a falsy one as an empty
  body, so `reply(200, false)` answered `''` where nock answers `false`.
- **A miss is reported in nock's words** (`asNockError`, applied by `NockErrorHandler` around every dispatch).
  undici's `MockNotMatchedError` (`UND_MOCK_ERR_MOCK_NOT_MATCHED`) becomes nock's `Nock: No match for request {...}`
  with `ERR_NOCK_NO_MATCH` on a mocked origin, and `NetConnectNotAllowedError` / `ENETUNREACH` / `Nock: Disallowed
  net connect for "host:port/path"` on an unmocked one net connect refuses - the spellings suites written against
  nock assert on. undici's error stays on `cause`. It has to be the handler, not a `try` around `dispatch()`:
  undici's dispatcher catches the mock pool's throw and delivers it to the handler.
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
  `nock(host).persist().get('/')` and `scope.done()`. `done()` throws nock's `Mocks not yet satisfied:` message.
- **Reply callbacks** are translated from undici's `(opts) => {statusCode, data, responseOptions}` to nock's
  `function (uri, requestBody) => [status, body, headers]` with `this.req.headers`. `uri` is the request's
  **whole** path — base path and query included, as nock 14 passes it; it used to be stripped of the scope's base
  path, which made a signature check over the path (the aggregator's Spribe suite) compare the wrong string. The request body is
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

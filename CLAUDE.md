# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`gotlike` — a barebones [got](https://github.com/sindresorhus/got)-like HTTP client for Node.js built on
[undici](https://github.com/nodejs/undici), plus a nock-like mocking shim (real nock doesn't intercept undici).
The goal is to be a drop-in replacement for `got` + `nock` in the common cases while being significantly faster;
only the features actually needed are implemented, and it deliberately trades safety/completeness for speed
(no options validation, partial retry/timings support).

Ships ESM (`type: "module"`, `module: "nodenext"`), targets Node >= 22.12, `strict` TS. There is no
`require` condition in `exports` and none is needed: node supports `require()` of ESM from 22.12, which
is what keeps CommonJS consumers like the aggregator working.

The consumer this package exists to serve is `../igd-aggregator-api`, which currently uses
`got-cjs@12` + `nock@14`. Feature decisions are scoped to what that repo actually uses, not to got
parity. Where got's design costs per-request work (deep option merging especially), performance
wins over an exact signature match, as long as the aggregator can still express the same thing.

## Commands

```bash
npm test                 # node --test over src/**/*.spec.ts, via native type stripping
npm run test:watch
npm run typecheck        # tsc --noEmit
npm run build            # tsc -> dist/ (specs are excluded from the build)

# single test file / single test
node --test src/index.spec.ts
node --test --test-name-pattern 'extend client with hook' src/index.spec.ts
```

Type stripping erases types without checking them, so **type errors only surface from `npm run typecheck` or
`npm run build`, never from `npm test`**. CI runs both, on node 22, 24 and 26.

Benchmarks live in `benchmark/` as a separate npm project with its own `package.json`/`node_modules`. See the
Benchmark section below before trusting any number out of it.

## Architecture

Three source files, all in `src/`:

- `index.ts` — the `Gotlike` class and the exported singletons.
- `nock.ts` — nock-compatible façade over undici's `MockAgent`.
- `index.spec.ts` — all tests.

### Request pipeline

`get`/`post`/`put`/`patch`/`delete`/`stream` are thin wrappers that set `url`/`method` and call `handle()`.

`handle()` calls `formOptions()` — one spread of `{...baseOptions, ...options}` into a **fresh** object, with
`headers` and `context` merged one level deep — then either runs the handler chain or goes straight to `call()`.
Handlers are got-style middleware: `iterateHandlers` walks `options.handlers` in order with `this.call` bound as
the terminal `next`.

Two invariants worth preserving here:
- **Never mutate the caller's options.** The verb methods pass `url`/`method` to `handle()` as arguments rather
  than assigning them onto the options object, and `formOptions` always allocates. Handlers and `beforeRequest`
  hooks *do* write to the formed options (the aggregator's handler sets `headers['X-Log-Id']`), so `headers` and
  `context` are always fresh objects — aliasing the instance defaults would leak writes across every request.
  `context` needs a copy even when only one side supplied one; a plain spread aliases whichever object that was.
- **Header names are folded to lower case at every merge point.** The instance defaults are lower-cased once in
  the constructor and per-call/extend/retry names go in through `mergeHeaders`, so a per-call `Authorization`
  *replaces* an instance `authorization`. Merging by exact key kept both, undici sent both, and the server
  picked one — usually the stale one. Only the override side is walked on the hot path; the defaults are
  already normalised.
- **Everything that would need deep merging is resolved at create/extend time** (`hooks`, `handlers`, `retry`,
  `agent`). That's what makes a shallow spread sufficient. `formOptions` costs ~46ns; a request costs ~60µs.

`options.context` defaults to a shared frozen empty object so `options.context.foo` reads as `undefined` without
allocating per request, and a stray write fails loudly instead of leaking. When a context *is* set, the request
gets its own shallow copy of it.

**`defaultOptions` is applied by the constructor, not by the exported singleton.** It used to be passed only to
`createClient(defaultOptions)`, which meant a hand-built `new Gotlike(...)` or `createClient(...)` silently had
`throwHttpErrors: undefined` (every 4xx/5xx resolving as a success) and no `responseType` (falling through to
`buffer` instead of `text`) — while `FormedOptions` declares both as required. Every construction path now starts
from the same defaults. `formOptions` still fills in `method: 'GET'` as a backstop, since `call()` routes the two
stream paths on it.

**`json`/`body`/`form` are per-request only, and `formOptions` strips them off the instance defaults.** A body
belongs to one request; a client built with `json` was otherwise sending it on every call, GETs included. The
`baseHasBody` flag is computed once in the constructor so the hot path pays one boolean test rather than three
property reads.

`call()` does the actual undici request, in this order: resolve the URL (`resolveUrl` joins `prefixUrl` without
doubling slashes and writes the result back to `options.url`), serialize `json` into `options.body`, run
`beforeRequest` hooks, `undici.request` (or `undici.pipeline` when `isStream`), read/parse by `responseType`,
build the response, run `afterResponse` hooks, apply `throwHttpErrors`, then `resolveBodyOnly`.

**`afterResponse` runs before `throwHttpErrors` on purpose** — got-style token-refresh hooks have to see the 401
that triggers them. Reordering these breaks every provider auth flow in the aggregator.

The URL is resolved and written back *before* hooks run because request signing needs the full URL
(`igd-aggregator-api`'s N2d provider signs `options.url`).

Every failure is normalized into a `RequestError` carrying `options` and the undici response, with `code` one of
`ETIMEDOUT` (headers/body timeout), `ERR_BODY_PARSE_FAILURE` (JSON parse — the raw text is attached to
`response.body` so callers can inspect it), `ERR_HTTP_ERROR` (non-2xx/3xx), or `ERR_REQUEST_ERROR`. Timeout and
retry errors are detected with the public `errors` export from undici 8 (undici 6/7 had no types for these, so
older code reached into `undici/lib/core/errors` — that internal import is gone).

`RequestError.response` is a full gotlike `Response` (parsed `body`, `timings`, `request.options`), not the raw
undici response — the aggregator's error handling reads all three. It is `undefined` only when the failure
happened before a response arrived. The originating error is passed through as `cause`.

JSON is parsed outside of undici (`body.text()` then `JSON.parse`) specifically so the unparsed body survives into
the error.

### Dispatcher / agent

undici 8 moved redirect and retry out of the per-request options and into **dispatcher interceptors**, so
they must be composed onto a dispatcher up front. The `agent` getter does this:

- the base dispatcher is `ownAgent` (set when the constructor got `agent`, or any Agent-level option:
  `http2`, `pipelining`, `dnsLookup`, `connections`, `keepAliveTimeout`, `keepAliveMaxTimeout`,
  `connectTimeout`) or else `getGlobalDispatcher()`, resolved **lazily on every request**;
- interceptors are composed **only when their option is set**. `compose()` wraps in array order, so the
  **last entry is outermost**: the array `[dns, redirect, dedupe, cache, decompress, retry]` puts retry
  outermost (it re-runs the whole chain) and dns innermost (resolving right before the connection is made).
  Getting this backwards silently reorders behaviour — there's a probe in the git history if you need to
  re-verify;
- `redirect` is composed **only on an explicit `followRedirect: true`** — this is opt-in, and a documented
  divergence from got. undici allocates a `RedirectHandler` per request once the interceptor is in the chain
  (~1.4µs vs ~0.2µs for `maxRedirections: 0`), which measured at ~80% of the client's total overhead.
  `Gotlike.followsRedirects` records the decision, and `formOptions` rejects a per-request
  `followRedirect: true` rather than ignoring it — composing the interceptor is a create/extend-time
  decision, so a per-request opt-in could never work. Per-request `false` is fine and just sets
  `maxRedirections: 0`. **`dispatchOptions` gates `maxRedirections` on `this.followsRedirects`, not on
  `options.followRedirect` alone** — undici rejects `maxRedirections` outright when the interceptor isn't in
  the chain, so with `validate: false` a per-request `true` used to slip past the ValidationError and fail
  every request with an opaque `UND_ERR_INVALID_ARG`;
- when nothing needs composing, `agent` returns the base dispatcher untouched;
- the composition is memoised against the base dispatcher's identity (`#composedFrom`), so the chain is built
  once per dispatcher rather than once per request.

HTTP/2 works over TLS via `allowH2`; cleartext h2c needs the caller to pass `agent: new H2CClient(origin)`,
since `H2CClient` is single-origin and can't back a general-purpose client.

**HTTP/3 is blocked upstream, not by us.** Verified: `node:quic` is not a builtin even behind
`--experimental-quic`; undici has no h3; and the npm ecosystem has no usable h3 client (`@matrixai/quic` is
QUIC transport only — h3 also needs framing and QPACK — and everything else is abandoned). Don't accept a PR
that "adds HTTP/3" without a real h3 dispatcher behind it.

The `agent` option is the transport seam: gotlike never inspects a dispatcher and composes its interceptors
on top of whatever is passed, so a future h3 dispatcher plugs in with no changes here. There's a test
(*an arbitrary custom dispatcher can back the client*) that locks that seam open.

Resolving lazily is what lets a `setGlobalDispatcher` call made *after* the client was constructed take effect —
which is exactly what `./nock` does, and why import order no longer matters (there's a regression test for it).

Both interceptors read per-request overrides off the dispatch options at runtime (`maxRedirections`,
`retryOptions` — see `lib/interceptor/{redirect,retry}.js`) even though undici's typings don't declare them;
`InterceptorOptions` in `index.ts` re-adds them. That's what keeps `followRedirect` a per-request option without
rebuilding a dispatcher per call.

Retry support is whatever undici's `RetryHandler` provides; got's `calculateDelay`/`noise` are not implemented,
and `maxRetryAfter` is degraded to a boolean `retryAfter`. `retryOptions.throwOnError` is forced to `false` so
that exhausted retries resolve to the last response (got's behaviour) instead of throwing `RequestRetryError`.

Two defaults are deliberately *not* undici's, because undici's diverge from got in ways nobody would go looking
for: `limit` defaults to **2** (undici's is 5, which triples the load a failing upstream sees), and `retryAfter`
defaults to **true**. Deriving `retryAfter` from `!!maxRetryAfter` turned honouring `Retry-After` *off* for every
caller who didn't set that option — so the client ignored an upstream's explicit backoff and hammered it on
undici's own schedule. The retried status codes and methods are still undici's; that is documented, not fixed.

### Hooks

Arrays, got's signatures, **read from instance options only** — a `hooks` object passed to a single call is
ignored. The constructor flattens each array onto the instance (`beforeRequestHooks` etc., `undefined` when
empty) so `call()` only checks for a truthy field per request. `extend()` concatenates them with the parent's,
like handlers.

`afterResponse` hooks get `(response, retryWithMergedOptions)`. `retryWithMergedOptions` merges over the options
the request was sent with and calls `call()` **directly, not `handle()`** — handlers already ran for this
request, and re-entering them would re-log and re-wrap a request the caller made once. It also clears
`prefixUrl`, since `options.url` was already resolved against it on the first attempt.

It **always reallocates `headers`**, even when the hook passed none. Aliasing the first attempt's header object
meant `call()`'s own writes on the retry — a `content-type` for a body the retry added — landed on the options
the *first* response reports having been sent with.

It is also **bounded** (`maxAfterResponseRetries`, 20), tracked through a symbol key on the options so option
spreads carry it while `for...in` validation and `Object.keys` never see it. A hook that always retries on a
status it never stops seeing — an auth refresh that silently fails — used to recurse until the process died;
it now fails with `ERR_TOO_MANY_RETRIES`.

`beforeError` hooks may return a replacement error; anything that isn't an `Error` is ignored. They run for
**every** failure path, streams included — see Streams — and for anything a `beforeRequest` hook throws.

**The pre-request work in `call()` has its own `try`.** The url resolution, body serialisation and the
`beforeRequest` hook loop all sit inside it, so a throwing hook (or a circular `json`) becomes a `RequestError`
with the hook's own message and runs the `beforeError` hooks. It used to reject with the raw error, which meant
a caller matching on `instanceof RequestError` missed it entirely.

### Bodyless responses and parse failures

`hasNoBody()` short-circuits parsing for `204`/`205`/`304` and `HEAD` — the body is `undefined` for `json`,
`''` for `text`, an empty `Buffer` otherwise. Without it every empty 204 became a failure.

Parse failures are flagged (`parseFailed`) at the `JSON.parse` call, **not recognised by message**. V8 words
them differently depending on input — "Unexpected end of JSON input" for an empty body versus "… is not valid
JSON" for garbage — and the old `message.endsWith('not valid JSON')` check misfiled empty bodies as
`ERR_REQUEST_ERROR`. Don't reintroduce message sniffing.

A signal reports its reason as a `DOMException`: `AbortError` from `abort()`, `TimeoutError` from
`AbortSignal.timeout()`. The first maps to `AbortError`/`ERR_ABORTED`, the second to `TimeoutError`/`ETIMEDOUT`
so that both kinds of timeout look the same to callers.

### Shared internals worth not re-duplicating

These exist because the same code was written out two or three times, and each copy was a place to
forget a field:

- **`dispatchOptions()`** — the options every dispatch shares. `call()`, `callBodylessStream()` and
  `callStream()` each built this literal by hand. It also owns the `redirects` and `attempts` holders, so no
  caller recomputes them — and, because it owns `attempts`, the stream paths get retry bookkeeping for free.
  They used to get none, which left `beforeRetry` silently unfired and `retryCount` pinned at 0 on a stream
  undici had in fact retried.
- **`trackDispatches(select, onRedispatch)`** + **`OutcomeHandler`** — one interceptor factory and one
  `DecoratorHandler` behind both `countAttempts` (retries) and `makeRedirectTracker` (redirects). They had
  separate, near-identical handler classes recording the same three fields.
- **`isOk()` / `isHttpError()`** — the status predicates were spelled out inline in four places, twice with
  subtly different boundaries.
- **`elapsedMs()`**, **`mergeRecords()`**, **`mergeHooks()`**, **`usedHooks()`** — small, but each replaced a
  repeated expression.
- **`GotlikeResponse` is constructed directly.** There used to be a `formResponse()` wrapper that took
  `(body, statusCode, headers, …)` and called the constructor as `(body, headers, statusCode, …)` — an
  invisible swap, one edit from a silent bug.

`formOptions()` deliberately still hand-rolls its merge rather than sharing one with `extend()` and
`retryWithMergedOptions()`: it is the hot path (~120ns including validation, measured), and the other two run
once per client or once per refresh.

`knownOptionMap` is `satisfies Record<keyof RequestOptions, true>`, so **adding an option to the type without
registering it is a compile error**. `clientOnlyOptions` is a `Set` because validation consults it per option
per request. Both were lists that could silently drift.

### retryCount and beforeRetry

undici exposes no retry counter — `response.context` is `null` after a retried request, and the
`retryOptions.retry` callback would mean reimplementing undici's default backoff to delegate to it. Instead
`countAttempts`, a plain interceptor composed **inside** the retry interceptor, sees every re-dispatch; the
count minus one is `retryCount`. `AttemptHandler` (a `DecoratorHandler`) records each attempt's status or
error so the next dispatch can report why it was retried. All public API.

`beforeRetry` fires from that interceptor and **cannot delay or cancel a retry** — undici decides to retry
inside a synchronous dispatch, so there is nothing to await on. It is for logging and metrics; this is a
documented divergence from got, not an oversight.

`attemptState()` builds the holder and `dispatchOptions()` hands it to every dispatch, so `retryCount` and
`beforeRetry` work identically for `call()` and for both stream paths (`StreamHead.retryCount`).

`beforeRedirect` uses the same shape: `makeRedirectTracker` is composed **inside** undici's redirect
interceptor, so it is re-entered per hop, and the hop's options are still mutable there — which is what lets
a hook put back an `authorization` header that undici stripped on a cross-origin redirect.

Two things that cost real debugging and are easy to undo:
- **The state holder must be handed in with the dispatch options, not attached on first entry.**
  `RedirectHandler` copies the options in its constructor — *before* hop 1 reaches the interceptor — and
  re-dispatches hops 2+ with that copy. State attached on hop 1 is invisible to hop 2, which silently loses
  the first hook call.
- **At a redirect hop `opts.headers` is undici's flat `[name, value, ...]` array**, not an object. A hook
  writing `headers.authorization` on that array achieves nothing, so `headersToObject` normalises it and the
  result is always assigned back.

`DecoratorHandler`'s `.d.ts` declares no members even though the runtime class has them, hence the
`DecoratorHandlerShape` declaration used to type the two methods we override.

### Bodies and decompression

`json` → `form` → `body` in precedence order; the first two set a `Content-Type` unless one is already present
(checked case-insensitively, because undici would otherwise send both and the server picks). `decompress` is
instance-level and drives two things that must agree: composing `interceptors.decompress()` and sending an
`accept-encoding` header. undici's interceptor decompresses based on the response only — it never asks for
compression — so without the header nothing upstream compresses in the first place.

`responseType: 'buffer'` returns a real Node `Buffer`, not the `ArrayBuffer` undici hands back. Callers feed
this to things like `sharp()` which reject anything else.

`acceptEncoding` is computed once at module load from what this runtime's `zlib` actually provides —
`createZstdDecompress` only exists from node 22.15 and `engines` allows 22.0, so a hardcoded header would
advertise an encoding we can't decode. undici degrades to *not* decompressing in that case rather than
throwing, which would hand callers compressed bytes silently.

`response.rawBody` is a lazy getter, not an eager field: text and JSON go through undici's optimised
`body.text()`, and materialising a Buffer per request just in case would cost more than it saves.

**It is the bytes that arrived, not a re-serialisation.** For `responseType: 'json'` the original text is carried
onto `GotlikeResponse` as a seventh constructor argument, because `JSON.stringify(parsedBody)` gave back
`{"a":1}` for a response that was on the wire as `{\n  "a"  :  1\n}` — which silently breaks any signature or
digest checked over `rawBody`.

### Streams

There are **two** stream paths, and which one runs depends on whether the request has a body:

- **no body, and a method that can't carry one** → `callBodylessStream`, via `undici.request`. Returns the
  response `Readable` unwrapped.
- **anything else** → `callStream`, via `undici.pipeline`, returning a `Duplex` whose writable half is the
  request body.

The split is on `bodyMethods` (`POST`/`PUT`/`PATCH`/`DELETE`), which `BodyMethod` is derived from so the list
and the type can't drift. It used to test `method === 'GET' || 'HEAD'`, which put every other bodyless method —
`OPTIONS`, and anything on a client with no `method` in its base options — on the pipeline path, where nothing
ends the writable half and `undici.pipeline` never sends the request at all. That hung forever.

The split exists because `undici.pipeline` makes the duplex's writable side the request body, and
`RedirectHandler` refuses to follow a redirect whose body it cannot replay — so a piped GET silently
returned the 302 itself with an empty body. That was a live bug: a download through a redirecting CDN got
an empty file and no error.

Returning the readable unwrapped rather than `Duplex.from({writable, readable})` is deliberate:
`Duplex.from` measured ~10% of stream throughput for a writable half that a GET cannot use. The `stream()`
overloads keep the type honest — a body-carrying `method` types as `GotlikeUploadStream` (a `Duplex`),
everything else as `GotlikeStream` (a `Readable`). `Duplex` extends `Readable`, so neither declaration lies.

**Errors are raised by the readable at read time**, not by destroying the duplex. Destroying has no good
moment: synchronously, the error is emitted before an awaiting caller attaches a listener; on a later tick,
a small body has already been consumed and the read finished cleanly. The `response` event goes out on
`setImmediate` for the same reason — a microtask queued before `await stream(...)` resolves fires first and
is missed.

`stream()` resolves to a `GotlikeStream` (a `Duplex`) rather than returning one synchronously as got does —
`beforeRequest` hooks are async and awaiting them is worth more than the sync return. The head arrives via
both a `response` event and a `response` promise hung off the duplex.

Two things that were wrong before and are easy to reintroduce:
- **`undici.pipeline` takes the request body from the duplex's writable side, not `opts.body`.** A body from
  the options has to be written with `duplex.end(body)`; passing it in the pipeline options sends nothing.
- **The writable side must be ended**, or the request never completes. GET/HEAD and option-supplied bodies are
  ended immediately; anything else is left open for the caller. The old code only ever ended for GET, so a
  POST hung.

`throwHttpErrors` on a stream is raised **by the readable at read time**, on both stream paths, rather than by
throwing from inside the pipeline handler. Throwing there was synchronous, which left no room to await the
`beforeError` hooks or to attach the response — so a streamed failure skipped the hooks entirely and arrived with
`error.response` undefined, which the documented contract says only happens when no response ever came. Both
paths now build the error through `toRequestError`. The `response` promise gets a `.catch(() => undefined)`
attached at creation — nothing is obliged to await it, and an unhandled rejection would take the process down.

`undici.pipeline` can also reject its arguments synchronously; that is caught and reported on the stream
(`failedUploadStream`) rather than by rejecting `stream()`, so both paths fail the same way.

### Timeouts

`timeout.request` sets undici's `headersTimeout` + `bodyTimeout` **and** an `AbortSignal.timeout` deadline
(`requestSignal`), combined with any caller `signal` via `AbortSignal.any`.

The deadline is what actually bounds the request, and it is not optional. undici's two timeouts are per-phase and
`bodyTimeout` **restarts on every chunk received**, so a response that trickles a byte at a time never trips
either one — a request under a 1.5s timeout was measured still running at 4.9s. undici also arms them on its
coarse timer wheel (`lib/util/timers.js`, `RESOLUTION_MS = 1000`), which used to round every sub-second timeout up
to roughly a second. Both are covered by tests (`/trickle`, and a 50ms timeout asserted to fire promptly).

undici's own timeout errors are still mapped, since they give the more specific message when they do fire first.
The deadline reports itself as a `TimeoutError` DOMException, which lands on the same `TimeoutError`/`ETIMEDOUT`
as everything else.

### extend()

`extend()` returns a **new** `Gotlike` built from `{...baseOptions, ...options}` with headers merged and handler
arrays concatenated. Because the constructor re-evaluates the agent options, extending with `retry`/`http2`/etc.
creates a fresh dispatcher.

### Mocking

`nock.ts` calls `setGlobalDispatcher(new MockAgent())` at import time (skipped when `NOCK_OFF=true`). Because
the client resolves the global dispatcher per request, import order no longer matters. Instances built with
their own agent still bypass the mock — `retry` no longer does, since it is an interceptor rather than a
separate `RetryAgent`.

The shim is a translation layer over `MockAgent`, and the translations that are easy to get wrong:

- **Base paths.** `nock('https://host/base')` is legal; `mockAgent.get()` only takes an origin. `splitOrigin`
  separates them and every interceptor path gets the prefix folded in.
- **String paths match the full request path including its query**, which is also nock's behaviour. `.query(true)`
  therefore has to become a *function* path matcher that strips the query before comparing.
- **Object queries must NOT use a function matcher.** undici folds `query` into the interceptor's stored path
  string (`serializePathWithQuery`) and compares strings; a function matcher silently defeats that and matches
  every query. This was a real bug — the test `query(object) matches only those params` guards it.
- **A non-string path can't carry an object query either.** undici only folds `query` into the stored path when
  that path is a string, so behind the function matcher a regex or function path uses for `.query({...})` the
  constraint was dropped entirely and every query matched. `queryMatches` checks it inside the matcher instead;
  `options.query` is only handed to undici when undici is the one that can apply it.
- **`responseOptions` must always be an object**, never `undefined`, or undici throws `UND_ERR_INVALID_ARG`.
- **`persist()`, `done()` and `isDone()` live on the `Scope`**, which is where nock's docs put them —
  `nock(host).persist().get('/')` and `scope.done()`. `isDone()` filters `pendingInterceptors()` by the scope's
  origin; it used to ask about every origin at once, so an unrelated scope's pending mock made it answer `false`.
- **Reply callbacks** are translated from undici's `(opts) => {statusCode, data, responseOptions}` to nock's
  `function (uri, requestBody) => [status, body, headers]` with `this.req.headers`. The request body is
  JSON-parsed when the content-type says so, as nock does.
- `cleanAll()` needs the `pools` map — `MockAgent` has no global clear, only `cleanMocks()` per pool.

`src/nock.spec.ts` covers all of this, with the aggregator's actual patterns (pragmatic's base path + regex,
amigo's `.query(true)`, spribe's capture-via-`reply(function)`) as named tests.

### Tests

`index.spec.ts` boots a real `http.createServer` on port 3000 in `test.before` with route-based behaviors
(`/json`, `/timeout`, `/stream`, `/headers`, `/status?code=`, `/redirect`, `/retry`). The `/retry` route counts
hits per `test-id` header — pass a unique `test-id` (e.g. `randomUUID()`) for retry tests so counters don't leak
between them. Uses `node:test` + `node:assert`, flat `test(...)` calls, no framework.

**Retry tests set `backoffLimit: 10`** unless the wait itself is what's under test. undici's
backoff is `min(minTimeout * factor ** n, maxTimeout)` — and `min(retryAfter, maxTimeout)` when the
server sent a `Retry-After` — so `backoffLimit` (which maps to `maxTimeout`) collapses both. Two
tests that forgot it cost 5.5s of a 9.5s suite. The exception is *retry honours Retry-After by
default*, where the wall clock is the assertion.

Don't reach for `node:test`'s `mock.timers` here. It does fast-forward undici's retry backoff
(measured 1500ms → 35ms), but it needs a tick-pump interleaved with real socket I/O, it would also
fast-forward undici's keep-alive timers and tear down the connection mid-test, and it **cannot
reach `AbortSignal.timeout`** — which is what `timeout.request` is built on — because that is a
native timer rather than `globalThis.setTimeout`. Verified, not assumed.

`assert.rejects` returns a promise: **always `await` it**. An un-awaited `assert.rejects` makes the test pass
unconditionally, which is how the timeout test sat green while asserting nothing.

## Benchmark

`benchmark/` is a separate npm project (ESM, its own `node_modules`). `npm run bench` from there builds the
parent and runs it; it imports `../dist`, so it measures the shipped artifact. Node's native type stripping
runs the `.ts` files directly — no ts-node.

`server.ts` serves pre-built response buffers over raw sockets, parsing only enough of each request to pick
one. A `node:http` server is measurable at these rates; `BENCH_SERVER=http` switches to one to check that the
raw server isn't distorting things.

**Methodology matters more than it looks here.** A single pass showed a ~25% swing purely from client
*order* — whoever runs first gets warm sockets and leaves a cold JIT for everyone else — which is larger than
most differences worth reporting. The runner therefore does several rounds, rotates who goes first, and scores
each client on its **median** round. Best-of was tried first and just traded position bias for whichever
client got the luckiest round.

Between-process variance is still ~15%, so **gotlike and raw `undici.request` should be read as at parity** —
gotlike is a thin wrapper and cannot genuinely be faster. If a change makes gotlike look like it beats raw
undici, that is a measurement artefact, not a result. Env knobs: `BENCH_DURATION`, `BENCH_ROUNDS`,
`BENCH_WARMUP`, `BENCH_CONCURRENCY`, `BENCH_SERVER`.

## Lint, format, typecheck

`npm run check` runs typecheck → lint → format check → tests, and is what CI runs.

- **oxlint** (`.oxlintrc.json`) with `correctness: error`, `suspicious`/`pedantic` as warnings. Rules turned
  off are listed with a reason where it isn't obvious — `unicorn/no-useless-undefined` in particular, because
  `undefined` carries meaning here (it is how "unset" reaches undici, and `.catch(() => undefined)` is a
  deliberate swallow).
- **oxfmt** (`.oxfmtrc.json`) with `bracketSpacing: false`, to match the brace style already in the repo
  rather than reformatting every line to a new one.
- **Two tsconfigs.** `tsconfig.json` is the *checking* config: `noEmit`, includes the spec files, and allows
  `.ts` import specifiers (which the specs use). `tsconfig.build.json` extends it to emit `dist/` and excludes
  the specs. **The specs were previously not type-checked at all** — the build config's `exclude` kept them
  out of `tsc`, and type stripping doesn't check — so 2000 lines of test code had no checking. Keep
  `npm run typecheck` pointed at the config that includes them.
- `erasableSyntaxOnly` is on, which enforces the type-stripping constraint at compile time rather than in
  prose. `noUncheckedIndexedAccess` is on. **`exactOptionalPropertyTypes` is deliberately off**: passing
  `undefined` through to undici is the idiom throughout, and satisfying the flag would mean building option
  objects conditionally — per-request work, against the whole point.

## Performance notes

Measured against a null dispatcher (median of 3 runs, **each in a fresh process** — comparing
dispatchers within one process poisons inline caches badly enough to invert results, and produced a
"both interceptors" number larger than the sum of its parts):

| | ns/request |
| --- | --- |
| raw `undici.request` | 2115 |
| gotlike default (no redirects) | 2588 |
| gotlike, `followRedirect: true` | 4569 |
| default + `decompress: false` | 2513 |

**~80% of gotlike's overhead is undici's redirect interceptor**, which allocates a `RedirectHandler`
per request (`maxRedirections: 10` ≈ 1.4µs vs ≈ 0.2µs for `0`) — which is why redirects are off by
default. Everything gotlike itself does — option forming, header merge, response construction,
validation — is under 500ns combined. Before optimising anything here, check the number is actually
ours.

Two non-obvious wins already taken, both worth keeping:
- **`Response` is a class, not an object literal.** A getter in an object literal is installed per
  object: ~190ns per response against ~7ns for a class with the getter on the prototype. Don't
  "simplify" `GotlikeResponse` back into a literal.
- **`accept-encoding` is folded into `defaultHeaders` at construction**, not set per request — it
  saves a case-insensitive header scan and an assignment. Per-call headers still win, because call
  options are spread over the defaults.

Rejected: reimplementing redirect handling to get the saving *while* following redirects. It would
buy ~2µs in exchange for owning method-rewriting and cross-origin header-stripping semantics. The
opt-in default already gets the whole saving with no correctness risk.

### Response body typing

`Response` can't be a tagged union over `responseType` — there is nothing on `Response<T>` to key it
on. Two things settle the body type instead, and both are needed:

- **The call**, through overloads on every verb, on `handle()` and on the callable form.
  `TextCall`/`BufferCall` resolve the body to `string`/`Buffer`, `BodyOnly`/`WholeResponse` choose
  between a bare `T` and a `Response<T>`, and an explicit `<T>` always wins — so `get<Thing>(url)`
  reads exactly as it does in got.
- **The client**, through `Gotlike<O extends ClientOptions>`, threaded by `extend()` via
  `MergeClientOptions<O, E>` and read by `ClientBody<O>` / `ClientResult<O, Body>`. got does the
  same thing (`DefaultResponseBodyType<U>` in its `types.d.ts`), and without it
  `extend({responseType: 'json'}).get(url)` claims `Response<string>` while handing back a parsed
  object. A client-level `resolveBodyOnly: true` is carried the same way.

`InheritCall` is the overload arm for a call that names no `responseType` — that is what defers to
the client. It has to be `{responseType?: undefined}` rather than an optional `'text'`: got's
equivalent arm accepts an absent-or-text `responseType`, which is why `jsonClient.get(url, {})`
loses the client's setting in got but not here.

`resolveBodyOnly` used to be typed as returning `Response<T>` while returning the body at runtime —
a straight lie in the types. The `BodyOnly` overloads are what fix it, which is why the
implementation signatures return `Promise<any>`.

The overload set is asserted at the bottom of `index.spec.ts` (`typeAssertions`), which is never
invoked — type stripping doesn't check types, so those assertions are enforced by
`npm run typecheck`, not by `npm test`. Keeping a generic `<T>(url, options?)` arm in the set is
what keeps an extended client assignable to a plain `Got`-typed field; drop it and
`const c: Got = gotlike.extend({responseType: 'json'})` stops compiling.

## Public API surface

`index.ts` exports the class plus pre-built singletons for drop-in replacement: `default`, `gotlike`, `got`
(all one `createClient()` — the defaults come from the constructor now, so passing `defaultOptions` here would be
redundant), and types `Got`, `ExtendOptions`, `RequestOptions`, `Response`,
`HandlerFunction`, `RequestError`. Keep all of these working when changing the entry point — the README documents
requiring/importing any of them.

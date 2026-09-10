# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`gotlike` — a barebones [got](https://github.com/sindresorhus/got)-like HTTP client for Node.js built on
[undici](https://github.com/nodejs/undici), plus a nock-like mocking shim (real nock doesn't intercept undici).
The goal is to be a drop-in replacement for `got` + `nock` in the common cases while being significantly faster;
only the features actually needed are implemented, and it deliberately trades safety/completeness for speed
(no options validation, partial retry/timings support).

Ships CommonJS (`type: "commonjs"`, `module: "commonjs"`), targets Node >= 22, `strict` TS.

The consumer this package exists to serve is `../igd-aggregator-api`, which currently uses
`got-cjs@12` + `nock@14`. Feature decisions are scoped to what that repo actually uses, not to got
parity. Where got's design costs per-request work (deep option merging especially), performance
wins over an exact signature match, as long as the aggregator can still express the same thing.

## Commands

```bash
npm test                 # node --test with ts-node/register over ./**/*.spec.ts
npm run test:watch
npm run build            # tsc -> dist/ (specs are excluded from the build)

# single test file / single test
node --test -r ts-node/register ./src/index.spec.ts
node --test -r ts-node/register --test-name-pattern 'extend client with hook' ./src/index.spec.ts
```

ts-node runs with the swc transform (`ts-node.swc` in tsconfig.json), so tests are transpile-only — type errors
surface from `npm run build`, not from `npm test`. CI (`.github/workflows`) runs `npm install && npm run test`
on Node 22 and 24.

Benchmarks live in `benchmark/` as a separate npm project with its own `package.json`/`node_modules` (ESM, compares
against got/axios/node-fetch/request/native fetch). Run `benchmark/server.ts` (self-signed HTTPS on :8080) first,
then `benchmark/index.ts`.

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
  hooks *do* write to the formed options (the aggregator's handler sets `headers['X-Log-Id']`), so `headers` is
  always a fresh object — aliasing the instance defaults would leak writes across every request.
- **Everything that would need deep merging is resolved at create/extend time** (`hooks`, `handlers`, `retry`,
  `agent`). That's what makes a shallow spread sufficient. `formOptions` costs ~46ns; a request costs ~60µs.

`options.context` defaults to a shared frozen empty object so `options.context.foo` reads as `undefined` without
allocating per request, and a stray write fails loudly instead of leaking.

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
- `redirect` is skipped when the client sets `followRedirect: false` — it rest-spreads the dispatch options
  on every request before it can bail out, so skipping it is a real saving for clients that never redirect;
- when nothing needs composing, `agent` returns the base dispatcher untouched;
- the composition is memoised against the base dispatcher's identity (`#composedFrom`), so the chain is built
  once per dispatcher rather than once per request.

**HTTP/3 is not possible** — undici has no QUIC support. HTTP/2 works over TLS via `allowH2`; cleartext h2c
needs the caller to pass `agent: new H2CClient(origin)`, since `H2CClient` is single-origin and can't back a
general-purpose client.

Resolving lazily is what lets a `setGlobalDispatcher` call made *after* the client was constructed take effect —
which is exactly what `./nock` does, and why import order no longer matters (there's a regression test for it).

Both interceptors read per-request overrides off the dispatch options at runtime (`maxRedirections`,
`retryOptions` — see `lib/interceptor/{redirect,retry}.js`) even though undici's typings don't declare them;
`InterceptorOptions` in `index.ts` re-adds them. That's what keeps `followRedirect` a per-request option without
rebuilding a dispatcher per call.

Retry support is whatever undici's `RetryHandler` provides; got's `calculateDelay`/`noise` are not implemented,
and `maxRetryAfter` is degraded to a boolean `retryAfter`. `retryOptions.throwOnError` is forced to `false` so
that exhausted retries resolve to the last response (got's behaviour) instead of throwing `RequestRetryError`.

### Hooks

Arrays, got's signatures, **read from instance options only** — a `hooks` object passed to a single call is
ignored. The constructor flattens each array onto the instance (`beforeRequestHooks` etc., `undefined` when
empty) so `call()` only checks for a truthy field per request. `extend()` concatenates them with the parent's,
like handlers.

`afterResponse` hooks get `(response, retryWithMergedOptions)`. `retryWithMergedOptions` merges over the options
the request was sent with and calls `call()` **directly, not `handle()`** — handlers already ran for this
request, and re-entering them would re-log and re-wrap a request the caller made once. It also clears
`prefixUrl`, since `options.url` was already resolved against it on the first attempt.

`beforeError` hooks may return a replacement error; anything that isn't an `Error` is ignored.

### retryCount and beforeRetry

undici exposes no retry counter — `response.context` is `null` after a retried request, and the
`retryOptions.retry` callback would mean reimplementing undici's default backoff to delegate to it. Instead
`countAttempts`, a plain interceptor composed **inside** the retry interceptor, sees every re-dispatch; the
count minus one is `retryCount`. `AttemptHandler` (a `DecoratorHandler`) records each attempt's status or
error so the next dispatch can report why it was retried. All public API.

`beforeRetry` fires from that interceptor and **cannot delay or cancel a retry** — undici decides to retry
inside a synchronous dispatch, so there is nothing to await on. It is for logging and metrics; this is a
documented divergence from got, not an oversight.

`beforeRedirect` is not implemented. undici's `RedirectHandler` takes no hook, so supporting it means
writing our own redirect handling. Worth knowing before someone "just adds it".

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

### Streams

`stream()` resolves to a `GotlikeStream` (a `Duplex`) rather than returning one synchronously as got does —
`beforeRequest` hooks are async and awaiting them is worth more than the sync return. The head arrives via
both a `response` event and a `response` promise hung off the duplex.

Two things that were wrong before and are easy to reintroduce:
- **`undici.pipeline` takes the request body from the duplex's writable side, not `opts.body`.** A body from
  the options has to be written with `duplex.end(body)`; passing it in the pipeline options sends nothing.
- **The writable side must be ended**, or the request never completes. GET/HEAD and option-supplied bodies are
  ended immediately; anything else is left open for the caller. The old code only ever ended for GET, so a
  POST hung.

`throwHttpErrors` is applied by throwing from inside the pipeline handler, which surfaces on the duplex's
`error` event. The `response` promise gets a `.catch(() => undefined)` attached at creation — nothing is
obliged to await it, and an unhandled rejection would take the process down.

### Timeouts

`timeout.request` maps to undici's `headersTimeout` + `bodyTimeout`. undici arms both on its coarse timer wheel
(`lib/util/timers.js`, `RESOLUTION_MS = 1000`), so **any timeout under ~1s effectively fires at ~1s**. A test
pins this down so it isn't rediscovered as a flake. Don't write tests whose server delay is under a second and
expect a sub-second timeout to beat it.

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
- **`responseOptions` must always be an object**, never `undefined`, or undici throws `UND_ERR_INVALID_ARG`.
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

## Public API surface

`index.ts` exports the class plus pre-built singletons for drop-in replacement: `default`, `gotlike`, `got`
(all `new Gotlike(defaultOptions)`), and types `Got`, `ExtendOptions`, `RequestOptions`, `Response`,
`HandlerFunction`, `RequestError`. Keep all of these working when changing the entry point — the README documents
requiring/importing any of them.

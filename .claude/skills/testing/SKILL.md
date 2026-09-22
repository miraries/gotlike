---
name: testing
description: How gotlike tests are written and why — the invariant-table style, the shared http server and its routes, retry-test pitfalls (backoffLimit, per-test-id counters, why mock.timers is unusable), and the coverage gate with its four deliberately-uncovered branches. Read before adding or changing a test in src/**/*.spec.ts, or before touching the coverage thresholds.
---

# Tests

**Several of these are invariant tests rather than scenarios, and that is the point.** Every error bug in this
repo's history has been *one uncovered path*, not a wrong answer on a covered one — so a table of paths beats a
test per path, because adding a path is an obvious edit and a missing one is a visible omission:

- *every failure path reports a RequestError or a ValidationError* — the whole error contract in one list:
  transport failures, timeouts, aborts, parse failures, all four hook kinds throwing, a hook that forgets to
  return, a hook handing back a response it built itself, and a bad option on each of the two routes into
  `call()`. Each row reports its own outcome rather than throwing, so a row that stops *failing* reads as a
  result instead of hiding every row after it.
- *an afterResponse retry normalises and validates the options it is given* — drives one table of bad options
  through `formOptions` **and** through the retry merge and requires the same answer from both. That is what
  makes "the retry path is a second `validate: false`" a failure rather than something to notice later.
- *an afterResponse retry ignores an option the hook names as undefined* — the same route, the other half of it.
  The table above can only express options that must be *rejected*; a key present with the value `undefined` is
  valid on both routes and used to produce a different request on one of them, which is a shape that table cannot
  reach. This one asserts the invariant instead: naming a key as `undefined` is indistinguishable from leaving it
  out, per key, against one baseline it also checks is the request the options describe.
- *a stream failure carries the response exactly when one had arrived* — every stream failure and whether a
  response had reached it, on both paths, against the one documented rule. `error.response` was populated on the
  status path and absent on every other, which is the "one uncovered path" shape again rather than a wrong answer.
- *a status listed in retry.statusCodes that undici will not retry keeps its deadline*, plus the unit test for
  `resume()` — the deadline can only be lost by a mispredicted pause, and both halves are pinned.
- *a hook writing through the formed options cannot reach the client or the caller* — one row per option whose
  value is a mutable object shared with the client, each driven from the client side, the call side and both.
  The third column is what makes it an invariant rather than three scenarios: the shallow spread only aliases a
  **one-sided** option, so a row written with both sides set passes vacuously — which is exactly how
  `searchParams` hid, since the two-sided case has always gone through `mergeSearchParams` and allocated. Adding
  an option that carries an object means adding a row; forgetting to is a visible omission. **Every row runs
  once per *route* as well** — a hook's write, and a write through `response.request.options` on a client with no
  hooks and no handlers at all. That second route is how the `sharesOptions` gate hid: a row driven only through
  a hook passes vacuously on the exact shape whose copies were being skipped.
- *stream emits response before any body reaches a `<consumer>` consumer* — three tests rather than a table,
  because the consumers (`pipe`, `on('data')`, `for await`) each start the flow by a different route and the
  route is what used to decide the answer.

`index.spec.ts` boots a real `http.createServer` on port 3000 in `test.before` with route-based behaviors
(`/json`, `/timeout`, `/stream`, `/headers`, `/status?code=`, `/redirect`, `/retry`, `/truncate`). The `/retry`
route counts hits per `test-id` header — pass a unique `test-id` (e.g. `randomUUID()`) for retry tests so counters
don't leak between them. `/truncate` announces a `content-length` of 1000, writes 7 bytes and then destroys the
socket: that is how the mid-body stream failures are provoked, since the response *head* has to arrive normally
for the failure to land where `normaliseStreamErrors` has to catch it. Uses `node:test` + `node:assert`, flat
`test(...)` calls, no framework.

Connection-failure tests point at `http://127.0.0.1:1`, not an unroutable address — a refused connection is
immediate, whereas a blackholed one waits out the connect timeout.

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
unconditionally, which is how the timeout test sat green while asserting nothing. `npm run lint` catches this
now — `typescript/no-floating-promises` is on, with `node:test`'s own `test`/`describe`/`before`/… allowlisted so
the ~330 test cases don't bury the one report that matters.

# Coverage

`npm run coverage` runs the suite with coverage on and **fails below 99.8% lines / 96% branches / 98%
functions**. `npm run check` runs it in place of `npm test`, so CI enforces it with no workflow change.
`npm test` stays the plain runner for local work.

The gate exists because an untested branch is where every bug in this repo's history has lived — the
uncovered list *is* the bug surface, written out. It went in alongside a pass that closed most of it:
`index.ts` from 93.56% to 95.69% branches, `nock.ts` from 92.20% to 96.23% and from 86.08% to **100%**
functions. What that pass turned up is worth knowing, because it was all public API nobody had called:
`put`/`patch`/`delete` on the client and five of the eight verbs on a nock `Scope` had no test at all,
nor did `once`/`twice`/`thrice`, `delay`, `abortPendingRequests`, or `enableNetConnect`.

**Four uncovered branches remain, and all four are deliberate.** They are listed here so nobody has to work
out a second time whether they matter:

| where | why it is uncovered |
| --- | --- |
| `index.ts` `headersToObject`, non-array arm | One call site, and undici always hands it the flat array form at a redirect hop. Defensive. |
| `index.ts` redirect tracker, `lastStatusCode === undefined` | Unreachable in practice — `countAttempts` resets `redirects.count` to 0 on a retry, so a retried attempt's first hop never reaches the callback. **Not removable:** it is also the narrowing that makes `lastStatusCode` a `number` for the hook call below it, and deleting it is a type error rather than a no-op. |
| `index.ts` `callStream` http-error readable, `raised` guard | Needs undici's duplex to pull twice before the queued destroy lands — a race, not a behaviour. Any test for it would be flaky. |
| `nock.ts` `cleanAll`'s `cleanMocks()` fallback | Only runs if undici moves its `dispatches` symbol, which is the future it exists for. |

A fifth used to be here and is now gone: `callStream`'s `else if (!isBodyMethod(...))` arm was **dead**, since
its only call site already gates on `isBodyMethod`. It was deleted, and the comment in its place records what
has to come back if that routing is ever widened — without an `end()` for the bodyless case `undici.pipeline`
never sends the request and the caller waits forever.

**Don't chase 100%.** The number is a means of finding untested behaviour, and the four above have been looked
at. Raising the threshold past what they allow buys a test for a race and a test for a type narrowing.

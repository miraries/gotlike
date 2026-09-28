# src/ — implementation notes

Everything in this file is about `src/index.ts`: the request pipeline, the hook contracts, the dispatcher
composition, streams, timeouts and `extend()`. It loads whenever you work under `src/`.

Most of it is a record of behaviour that was **silently wrong once**. A paragraph that explains why something
is the way it is is a paragraph documenting a bug that shipped — treat the reasoning as the specification, not
as background. See the root `CLAUDE.md` for what this package is and who consumes it.

# Request pipeline

`get`/`post`/`put`/`patch`/`delete`/`head`/`query`/`stream` are thin wrappers that set `url`/`method` and call `handle()`.

**`handle()` unwraps `resolveBodyOnly` from the options that reached `call()`, not the ones the caller passed**,
and reads them after the chain resolves — a handler may await something of its own, so the decision isn't
settled synchronously. A handler turning `resolveBodyOnly` on used to be ignored. The handler index also travels
with the call instead of living in one shared counter, so a handler calling `next` twice no longer skips the
handler after it.

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
  **`searchParams`, `timeout` and `handlers` need the same copy, and for a long time did not get it.** The rule is
  not "copy `headers` and `context`" — it is *every option whose value is a mutable object shared with the client*,
  and the shallow spread aliases each of them whenever only one side carries it (`mergeSearchParams` allocates only
  when both do, and `formed.timeout = base.timeout` was an outright assignment). Measured: a `beforeRequest` hook
  adding one query parameter put it on **every later request the client made**, and `options.timeout.request = 5`
  for a single request moved the client's deadline permanently, so everything it sent afterwards timed out. When the
  option came from the *call*, the same write mutated the caller's own literal, which accumulates across calls that
  reuse it. `handlers` is the quiet third: a push through `options.handlers` lengthens the chain of every later
  request. **The copies are unconditional**, and they used to sit behind a `sharesOptions` flag — true when the
  client had a handler or a `beforeRequest`/`afterResponse`/`beforeError` hook, on the reasoning that a client with
  none of those has nothing that could write. That premise was wrong, and the hole it left is the same bug one
  level out: the formed options are handed to **every** caller, as `response.request.options` and `error.options`,
  both of which the README documents. Measured on a client with no hooks and no handlers,
  `response.request.options.timeout === client.baseOptions.timeout` and the same for `searchParams` — so a caller,
  or any logging or retry wrapper that normalises what it is shown, moved the client's deadline for good. The flag
  is gone; each copy is guarded by the option being set at all, so a request that carries neither pays two property
  reads. `retryWithMergedOptions` applies the same rule, since it runs once per refresh rather than per request.
  The invariant test drives every row through **both** routes — a hook's write and a write through
  `response.request.options` — because a row driven only through a hook passes vacuously on the shape that was
  broken. `retry` and `hooks` are still aliased and deliberately not copied: both are consumed at construction
  (`retryOptions`, the flattened `beforeRequestHooks` and friends), so a write through them cannot change the
  client that produced the response, and copying `hooks` per request would mean copying five arrays.
  **That premise only holds because the constructor snapshots what it consumes, and for a long time it did not.**
  `usedHooks` handed the array straight back, so `client.baseOptions.hooks.beforeRequest` *was*
  `client.beforeRequestHooks` — and with `hooks` aliased onto the formed options, the live chain was reachable
  from `response.request.options.hooks` and `error.options.hooks`, both of which this package documents. Measured:
  a `push` through either added a hook to the client permanently, and since `call()` walks the array with
  `for...of`, one made during the loop also ran in the request that made it. `retry` had the identical hole by the
  identical route — `mergeRecords` copies the `retry` object but not the arrays inside it, so
  `retryOptions.statusCodes` was the parent's array as well as the child's, and a push through
  `response.request.options.retry.statusCodes` widened what an already-built client and everything derived from it
  retried. `resolveErrorCodes` had been copying `errorCodes` for exactly this reason, and the other two arrays were
  simply never given the same treatment. Both are copied at construction now; each costs one small array per
  client, and the per-request aliasing — which is what the hot path cares about — is unchanged.
- **Header names are folded to lower case at every merge point.** The instance defaults are lower-cased once in
  the constructor and per-call/extend/retry names go in through `mergeHeaders`, so a per-call `Authorization`
  *replaces* an instance `authorization`. Merging by exact key kept both, undici sent both, and the server
  picked one — usually the stale one. Only the override side is walked on the hot path; the defaults are
  already normalised.
- **A `url` is the first argument, never an option** - as in got 16. **Since got 15 a `url` key in an options
  object is rejected outright** — `assertNoUrlInOptionsObject` in `create.js` throws
  `TypeError: The \`url\` option is not supported in options objects. Pass it as the first argument instead.`
  for a request's options, for `extend()` and for `paginate()`, with or without an argument beside it. got 12
  and 14 accepted the option and rejected only the combination (measured on 14.6.6). It is `url` as an *input
  key* that is gone; a hook can still read and write `options.url`, and `retryWithMergedOptions({url})` is still
  how a retry goes somewhere else. `validateOptions` refuses it with got's message on every input route - request,
  callable, stream, `extend()`, constructor - and lets it through only for a retry (`isRetry`). The type follows:
  `RequestOptions` has no `url`; `FormedOptions`, `RequestError#options` and the retry's argument do.
  **This used to be kept for `igd-aggregator-api`, which was on `got-cjs@12`, and that was wrong**: it made a
  call that works here and throws under got. The target is got 16; a consumer on an older got moves to it.
  Don't reintroduce an older got's behaviour as a divergence.
- **Everything that would need deep merging is resolved at create/extend time** (`hooks`, `handlers`, `retry`,
  `agent`). That's what makes a shallow spread sufficient. `formOptions` costs ~46ns; a request costs ~60µs.
- **`searchParams` and `timeout` are the two exceptions, and both are guarded by a property read.** A per-call
  `searchParams` replaced the client's outright, so a client carrying an api key, a tenant id or a version flag
  lost it the moment a call named a parameter of its own — silently, and on the wire rather than at the call
  site. got merges them (`Options.searchParams` under `_merging`): a key the override names replaces every
  occurrence of that key, one it doesn't is kept, and one it names as `undefined` is dropped. Measured against
  got 16, including the ordering — a replaced key moves to the end. `mergeSearchParams` only runs when *both*
  sides carry one (~105ns when it does; nothing when it doesn't, and the spread has already picked the right
  side). `timeout` needs no allocation at all: only `request` is supported, so replacing the object is the same
  as merging it *except* when the override names no `request` — `{}`, or the `{request: config.timeout}` of a
  config that didn't set one, which used to drop the client's deadline and leave the request unbounded.

**A string `searchParams` is re-encoded, never concatenated as written** (`stringifyQuery`). `resolveUrl` appends
the serialised query straight onto the url, so every character of the caller's string landed in the url as a *url*
character: the first `#` opened a fragment, a fragment is never sent, and every parameter after it vanished off the
wire with no error — `searchParams: 'next=/home#top&b=2'` reached the server as `?next=/home`. That is the same
failure `withoutQuery` fixed for the joined url, never fixed for the query being appended to it. It was also
inconsistent with itself, which is worse to debug than being wrong: `mergeSearchParams` round-trips a string through
`URLSearchParams`, so the two-sided case encoded correctly while the one-sided case — the common one — did not.
Running it through `URLSearchParams` is what got does too, so `a=1;b=2` and `q=a b` now encode as got encodes them.
The constructor strips a leading `?` itself. Object and `URLSearchParams` inputs were always correct.

**`null` and `undefined` are not one value** (`appendQuery`). They were treated as one and both dropped, which
lost a parameter off the wire: `searchParams: {a: null, b: 1}` went out as `?b=1` where got sends `?a=&b=1`, so
an upstream that tells "absent" from "present and empty" — a filter being cleared, a tri-state flag, anything
signing over the canonical query — saw a different request, silently. got's rule is the one now implemented:
`null` appends an empty value, `undefined` is skipped (`Options.set searchParams`). Applied per item inside an
array too, since that is how a key is repeated. The prose here used to assert the opposite — "`null` or
`undefined` are dropped … got does the same" — which was true of one of them and false of the other, and
nothing ran to contradict it; it is pinned against real got now, and the property generator's `query()` was
widened to `nullableQuery()` so the *shape of a value* is reachable, the same blind spot the string-vs-object
shape of `searchParams` had.

**`form` shares the serialiser, and diverges from got on those two values by design.** got builds a form
body with `new URLSearchParams(form)`, which stringifies both into the literal text `a=null` and `b=undefined`.
That is a serialisation artefact rather than an intent — it is not what got itself does with the same values in
`searchParams`, and no server wants the four characters `null` in a form field — so one rule is applied to both
options and the difference is recorded, in the README's table and as a pinned `divergence` in the parity suite.
The key survives either way, which is what the old drop-everything behaviour actually lost.

**An *array* value is the third place the two disagree, and it went unrecorded for a long time.** The same
`new URLSearchParams(form)` stringifies `{a: [1, 2]}` into the single value `a=1%2C2`, where this repeats the key
(`a=1&a=2`) — a silent wire difference for an identical call, which is exactly what the divergence inventory
exists to make visible. On `searchParams` the disagreement runs the other way: got **rejects** an array outright
(its `searchParams` takes one string, number, boolean or `null` per key and validates the value), so there this is
simply more permissive and nothing breaks moving *to* gotlike. Both halves are pinned as `divergence` scenarios
now, and both are in the README's table. The generators could not have found either: `query()`/`nullableQuery()`
build one value per key, and widening them to emit arrays would only manufacture divergences — see the note on
`scalar()` in `property.spec.ts`, which is how the *scalar* shapes (number, boolean) became reachable instead.

Header names written by a handler or a `beforeRequest` hook are folded again at dispatch, but only for clients that
have one (`mayRewriteHeaders`) and only when a scan (`hasUnfoldedName`, which allocates nothing) actually finds an
upper-case name. A hook writing `headers.Authorization` over an existing `authorization` otherwise left undici sending
both.

`options.context` defaults to a shared frozen empty object so `options.context.foo` reads as `undefined` without
allocating per request, and a stray write fails loudly instead of leaking. When a context *is* set, the request
gets its own shallow copy of it.

**An unknown key inside `retry` or `hooks` is rejected, and a got option we simply don't implement says so.**
`retry: {limt: 0}` used to be accepted outright and silently leave the *default* two retries in place; a misspelled
hook name was accepted and never fired. But `retry.calculateDelay`, `retry.noise` and `hooks.init` are real got
options that got 16 accepts, so reporting them as "Unknown option" told a caller migrating from `got-cjs@12` that
they had made a typo. `unimplementedOptions` names each one and why it is missing. Still a hard failure rather than
an ignore — a `calculateDelay` that silently never runs is the exact failure the check exists to stop — and it is
in the README's divergence table, because "the client will not construct" is a different migration story from "that
option does nothing".

**Option validation walks own properties only.** `for...in` climbs the prototype chain, so any library that put an
enumerable property on `Object.prototype` made every request fail with `Unknown option`.

**A bad `searchParams`/`form` *value* is a `ValidationError` too, on every route.** `validateOptions` checks the
container's shape; the values are `queryValue`'s job, and it only sees them when the query is serialised — inside
`call()`'s pre-request `try`, which wrapped the `ValidationError` into a `RequestError`. The message and the code
survived, the class did not, so `searchParams: {a: {}}` reported itself as a transport failure (`beforeError`
hooks and all) where the identical mistake one option along threw. The pre-request catch now rethrows a
`ValidationError` untouched, exactly as the `afterResponse` catch already did and for the same reason — the two
classes are the whole error contract and the distinction is pinned in the parity suite. `validateQueryValues`
closes the other half: on a *client* the bad value was not rejected at all, so the client constructed and then
every request it ever made failed. It runs at create/extend only (`atCreation`), which is what keeps the walk off
the hot path; a per-request value is still caught lazily and reports the same message.

**`defaultOptions` is applied by the constructor, not by the exported singleton.** It used to be passed only to
`createClient(defaultOptions)`, which meant a hand-built `new Gotlike(...)` or `createClient(...)` silently had
`throwHttpErrors: undefined` (every 4xx/5xx resolving as a success) and no `responseType` (falling through to
`buffer` instead of `text`) — while `FormedOptions` declares both as required. Every construction path now starts
from the same defaults. `formOptions` still fills in `method: 'GET'` as a backstop, since `call()` routes the two
stream paths on it.

**`defaultOptions.headers` is copied, not adopted.** The spread handed *the same module-level `{}`* to every
client built without headers of its own — `createClient().baseOptions.headers` was one object for the whole
process, so a single write through that public field would have shown up on every client created afterwards.
It goes through `mergeRecords` alongside `context`/`timeout`/`retry`, which also closes the ordinary half: a
caller's own object stayed live on `baseOptions`, and `extend()` reads `base.headers`.

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

**It is a `URL`, as got's is (`asUrl`), and handlers get it too.** It used to be the raw string: a hook signing it
signed `/a b/ü` while undici put `/a%20b/%C3%BC` on the wire (got's `URL` prints the encoded form, so the signature
matched there and silently didn't here), the aggregator's `(options.url as URL).href` was `undefined`, and a got-style
`options.url.searchParams.set('sig', …)` threw. And handlers ran before `call()` resolved anything: a handler read
the bare `'items'` before `next` and the full url after it, because `call()` resolves onto the same object.
`handle()` now resolves before the handler chain when there is one, and `call()` always parses a *fresh* `URL`, so a hook rewriting it in place can never reach a
`URL` the caller passed in. Internally everything works on `url`, the local string, and a hook's rewrite is
detected by **value** (`String(options.url) !== url`) - an in-place mutation keeps the object's identity, so the
old identity check would have missed it. The edges that hand a url outward (`response.url`, `StreamHead.url`, the
undici calls) take `String()` of it, so `response.url` stays a string, as got's is. `asUrl` is lenient - a url
`new URL` rejects stays a string so it fails where it always did (the dispatch, or the stand-in stream). ~300ns a
request, paid on every client so `options.url` doesn't change type with the hook set.

**`call()` resolving a second time is only idempotent if no handler touched the url, and it used to assume it
always was.** With `searchParams` set, the second resolve laid them over the query a handler had just built, so
`options.url.searchParams.set('sig', …)` in a handler — the got way to sign — silently never reached the wire
(got 16 sends both), while the identical handler worked on a request without `searchParams`. `handle()` now
records the url it resolved on a symbol (`resolvedForHandlers`, same trick as `retryDepth`); `call()` reads it,
clears it so a retry's spread cannot inherit it, and applies the `beforeRequest` rule: a url rewritten to an
absolute one is taken as written, a relative one is resolved again. A handler that only changed `searchParams`
leaves the url equal and gets the ordinary resolve, so that still wins.

**And read back *after* they run.** The dispatch used a local captured before the hook loop, so a hook that
rewrote `options.url` - which is what signing a url into the path looks like - was read by nothing and the
original url went out anyway. A url the hook leaves absolute is taken verbatim: re-resolving it would lay
`searchParams` back over the top and wipe the query it had just built. A relative one is resolved again, so a
hook can still rewrite the path under `prefixUrl`.

**A hook writing `options.searchParams`, `options.username` or `options.password` is read back too.** Both the url
and the Basic-auth header are derived *before* the hooks, and were only derived again when a hook rewrote
`options.url` — so `options.searchParams = {sig}`, `options.searchParams.set('sig', …)` and `options.username = 'u'`
all reached nothing, silently, where got 12 reads each of them off its request url. `withQuery` compares the
serialised `searchParams` against the query the url already carries (an in-place `.set()` is invisible to any
accessor) and rebuilds it only when they differ; a hook that rewrote `options.url` still wins over it.
`applyHookCredentials` re-derives the header when the credentials changed, but only over the header derived from
the old ones — an `authorization` set explicitly, by the caller or the hook, still wins, as node's `auth` does.

Four things `resolveUrl` has to get right, each of which was silently wrong:
- **An empty `url` resolves to the prefix *with* its trailing slash.** got normalises `prefixUrl` to end in `/`
  and resolves `''` against it, so `client.get('')` — the collection root — requests the directory form.
  Handing the prefix back verbatim put a different path on the wire, `GET /api` against got's `GET /api/`,
  which a server is free to answer with a 301 (not followed by default here, so it surfaces as the redirect
  itself) or a 404. It only ever differed for a `prefixUrl` written *without* a trailing slash — which is the
  form the README's own examples use, and the reason the parity scenario drives both spellings: with one, the
  two agreed, so a test written that way would have passed throughout. The `url === ''` special case is gone;
  `'' .replace(leadingSlashes, '')` is `''`, so the ordinary join produces exactly this.
- **The fragment comes off before the query is located.** `joined.indexOf('?')` alone appended `searchParams`
  *inside* a fragment: `http://h/p#frag` became `http://h/p#frag?a=1`, the fragment took the query with it (a
  fragment is never sent), and the server received a bare `/p`. The params vanished off the wire with no error at
  all. The fragment is dropped rather than preserved, which is what got's `URL`-based handling ends up doing too.
- **Every leading slash is stripped from `url`, not just the first** (`leadingSlashes`). `url = '//x'` joined as
  `prefix//x` — exactly the doubled slash the join exists to prevent.
- **A `prefixUrl` carrying a `?` or `#` is a `ValidationError`.** The prefix is concatenated, so a query on it
  landed mid-url (`http://h/base?x=1` + `p` → `http://h/base?x=1/p`), and adding `searchParams` then cut
  everything from the `?` onwards and dropped the path segment entirely. Rejected rather than mangled.

**Credentials in the url become Basic auth** (`splitUserinfo`). got keeps `username`/`password` on a `URL` and
node's `urlToHttpOptions` turns those into the `Authorization` header; undici does no such thing, so
`http://user:pass@host/` went out anonymous and all the caller saw was a 401. The userinfo is stripped off
`options.url` before hooks see it, and percent-decoded first so a credential containing `@` or `:` round-trips
as got's does. Explicit `username`/`password` options win. It scans for the authority by index rather than
parsing, so a url with an `@` in its *path* (`/users/@me`) costs two `indexOf`s and allocates nothing.

**That scan has to stop exactly where WHATWG URL stops, and `\` is one of the places it does.** For the special
schemes this client ever sends, a backslash is a path separator — `http://allowed.host\@attacker.host/p` is host
`allowed.host` with the path `/@attacker.host/p` to `new URL`, to undici and to got. Stopping only at `/`, `?`
and `#` ran the authority all the way to the `/`, found the `@` inside it, and **rewrote `options.url` to
`http://attacker.host/p`** — the request, and an `Authorization` minted out of the fake userinfo, went to a host
no parser had ever named. That is an SSRF filter walking straight through: an application allowlists
`new URL(input).hostname`, passes the string on, and the request lands somewhere else. Only reachable with
`parseUserinfo` on, which is the default, so the default was the unsafe setting. `isAuthorityEnd` is the one
place that answers "where does the authority stop", shared with `authorityEnd`/`sameOrigin` so the two cannot
drift; it is pinned in `index.spec.ts` against `new URL` rather than against a literal, and in the parity suite
against got. ASCII tab, LF and CR go the same way — WHATWG strips them before parsing, so they can never reach
`URL.username`, and `urlWhitespace` takes them out of the extracted userinfo. They cannot move the *host*, since
undici re-parses the url this hands back and strips them itself.

**Empty credentials are not credentials** (`hasCredentials`). got keeps them on a `URL` and node's
`urlToHttpOptions` derives `auth` only when `url.username || url.password`, so `{username: ''}` and
`http://@host/` both go out anonymous there. Testing `!== undefined` sent `Authorization: Basic Og==` for both —
an anonymous credential an upstream is free to reject or log, off the back of a `{username: config.user ?? ''}`
that meant "no credentials at all". The userinfo still comes off the url either way, which is what every parser
does with it. A password with no username *is* a credential and still authenticates. On the retry path an
explicit `username`/`password` is still tested for *presence* rather than for credentials, because
`retry({username: ''})` is an instruction: got sends no header for it, so the stale one has to go.

Even that bounded scan showed up under profiling (`benchmark/profile.ts`) as the second-largest cost in
gotlike's own code, after `call()` itself — ~300-400ns per request, run unconditionally even though almost no
real url carries credentials. `parseUserinfo: false` (client-only, same reasoning as `validate`) skips the call
to `splitUserinfo` entirely for a client that never sees one. Explicit `username`/`password` options are
unaffected, since they don't go through it.

Every failure is normalized into a `RequestError` carrying `options` and the undici response, with `code` either
one of the codes the class decides — `ETIMEDOUT` (headers/body timeout), `ERR_BODY_PARSE_FAILURE` (JSON parse —
the raw text is attached to `response.body` so callers can inspect it), `ERR_HTTP_ERROR`, `ERR_ABORTED` — or,
for anything generic, **the underlying error's own `code` via `codeOf()`**, with `ERR_REQUEST_ERROR` as the
fallback.

**That passthrough is what makes `err.code === 'ECONNREFUSED'` work, which is how got callers write it.** got's
`RequestError` takes `error.code ?? 'ERR_GOT_REQUEST_ERROR'`; every generic failure here was flattened to
`ERR_REQUEST_ERROR` instead, with the real code reachable only through `cause` — so a connection refused, a DNS
failure and a malformed url were indistinguishable to anything matching on `code`, exactly as they had been on
`message` before `messageOf`. Measured against got 16: `ECONNREFUSED` and `ENOTFOUND` on both. Whatever undici
raised is passed through as it stands, so parity is exact for the errno codes it surfaces from the socket and
undici's own where it describes the failure itself (`UND_ERR_SOCKET` for a body cut short, where got says
`ECONNRESET`) — the README says so rather than pretending otherwise. `codeOf` requires a **string**: a
`DOMException`'s `code` is a legacy number (23 for a timeout) that no caller matching on the documented codes
wants, and those paths assign their own code anyway.

**`isHttpError` takes whether the request was following redirects.** A 3xx is an error only when it was: reaching
the caller then means undici gave up on a chain longer than `maxRedirections`, and that used to resolve as a
*success* whose body was the redirect page. got draws the line in the same place (`limitStatusCode` is 299 when
following, 399 when not), 304 excepted. `follows(options)` is the one place that answers "is this request
following redirects", and `dispatchOptions` gates `maxRedirections` on it too. Timeout and
retry errors are detected with the public `errors` export from undici 8 (undici 6/7 had no types for these, so
older code reached into `undici/lib/core/errors` — that internal import is gone).

**The message is the underlying error's, via `messageOf()` — not a generic label.** `ERR_REQUEST_ERROR` used to
be raised with the literal string `'Request error'`, so a connection refused, a DNS failure and a malformed URL
were indistinguishable in any log line or APM grouping; the real reason was only on `cause`, which almost nothing
reads. got reports the underlying message, and the pre-request catch in the same function always did. `messageOf`
falls back to the generic label only for an error with no message, or a non-`Error` thrown value.

`RequestError.response` is a full gotlike `Response` (parsed `body`, `timings`, `request.options`), not the raw
undici response — the aggregator's error handling reads all three. It is `undefined` only when the failure
happened before a response arrived. The originating error is passed through as `cause`.

JSON is parsed outside of undici (`body.text()` then `JSON.parse`) specifically so the unparsed body survives into
the error.

# Dispatcher / agent

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
- **`dedupe` is wrapped by `isolateDedupedAborts`**, one interceptor either side of it. undici's deduplicate
  interceptor sends the first of a group and parks the rest on it, and only that first caller controls the shared
  dispatch: its `abort` tore the request down and the reason was handed to every parked request. Every request
  here with a `timeout.request` or a `signal` aborts through its own controller, so — measured — one caller's
  `abort()` failed an unrelated caller with `AbortError`, and a 20ms deadline failed a request that had asked
  for 5s. The outer interceptor hands each caller its own `IsolatedController`: an abort fails that caller alone
  and leaves the dispatch running (resuming it if that caller had paused it) *while something is parked on it*,
  and aborts it for real otherwise, exactly as before. A parked request's controller is dedupe's per-waiter one,
  so its abort never needs isolating. A consumer destroying a response body goes through the same `abort`.
  **"Something is parked on it" is counted through dedupe itself, not guessed from a key.** The inner
  interceptor sees the `DeduplicationHandler` dedupe wraps a group's first request in (the outer one names which
  request that is, via a variable set around its synchronous dispatch), and `lead()` wraps that handler's
  `addWaitingHandler` to count each request it actually parks. The count used to be by origin, method and path —
  coarser than dedupe's key, which also compares headers, and blind to dedupe sending a request on its own once
  the first one's body has started. Two concurrent GETs with different `authorization` counted 2, so aborting
  one detached instead of aborting, and the real request kept its socket, draining a body nobody read, until
  undici's 300s default without a `timeout.request`. If undici renames `addWaitingHandler` nothing is counted,
  which degrades to the original shared-abort bug rather than a leak — the dedupe tests fail on it;

**undici follows a `300`, and got 15 stopped.** `redirectableStatusCodes` in undici's
`lib/handler/redirect-handler.js` includes 300, so a client with `followRedirect: true` follows a
`300 Multiple Choices` carrying a `Location` where got hands the 300 back (RFC 9110 makes it a SHOULD
for user agents, not a MUST). Changing it would mean owning redirect handling, which the performance
note further down rules out; it is in the README's "Forced by undici" table instead. 304 is followed
by neither.

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

**An `ownAgent` is routed through the mock while `./nock` is the global dispatcher.** It used to bypass it
entirely, so a `connections`-tuned client ignored every interceptor and `disableNetConnect()`, and a test that
looked mocked went live — reproduced against a real server. The shim hangs a `routeOwnAgent` function on its
`MockAgent` under `Symbol.for('gotlike.nock.routeOwnAgent')`; the getter looks for it on the global dispatcher
and, when present, composes over the route it returns instead of over `ownAgent`. The route is memoised per agent,
so `#composedFrom` still matches from one request to the next. A registry symbol keeps this module from importing
the shim, and a client with no `ownAgent` pays nothing for it.

Both interceptors read per-request overrides off the dispatch options at runtime (`maxRedirections`,
`retryOptions` — see `lib/interceptor/{redirect,retry}.js`) even though undici's typings don't declare them;
`InterceptorOptions` in `index.ts` re-adds them. That's what keeps `followRedirect` a per-request option without
rebuilding a dispatcher per call.

Retry support is whatever undici's `RetryHandler` provides; got's `calculateDelay`/`noise` are not implemented,
and `maxRetryAfter` is degraded to a boolean `retryAfter`. `retryOptions.throwOnError` is forced to `false` so
that exhausted retries resolve to the last response (got's behaviour) instead of throwing `RequestRetryError`.

**Retrying at all is opt-in: a client without a `retry` object composes no retry interceptor and makes one
attempt**, where got retries twice by default. It is the `followRedirect` trade again — `countAttempts` and
undici's `RetryHandler` cost per request whether or not anything is retried — and `retry: {}` gets got's defaults.
The README used to say only "`limit` defaults to got's 2", which read as the client default and was only true inside
a `retry` object; it states the opt-in outright now. Everything below is about a client that has one.

Three defaults are deliberately *not* undici's, because undici's diverge from got in ways nobody would go looking
for: `limit` defaults to **2** (undici's is 5, which triples the load a failing upstream sees), `retryAfter`
defaults to **true**, and `errorCodes` defaults to undici's list **plus `UND_ERR_HEADERS_TIMEOUT` and
`UND_ERR_BODY_TIMEOUT`**. Deriving `retryAfter` from `!!maxRetryAfter` turned honouring `Retry-After` *off* for
every caller who didn't set that option — so the client ignored an upstream's explicit backoff and hammered it on
undici's own schedule. The retried status codes and methods are still undici's; that is documented, not fixed.

**`errorCodes` is the third because got retries a timeout by default and undici does not.** A client configured
`{retry: {limit: n}, timeout: {request: ms}}` — the ordinary shape for a flaky upstream — got no retries at all
for the one failure it was most likely configured for. Measured against got 16: an upstream that never answers
ran four attempts there and one here. The list has to be spelled out to add to it (`defaultRetryErrorCodes`),
which means owning a copy of undici's; the rest of it is verbatim. **A caller's own `errorCodes` is translated,
not passed through** (`resolveErrorCodes`): got spells this failure `ETIMEDOUT`, which is the name a got call
site already carries, and undici raises neither of its own codes under that name — so `retry: {errorCodes:
['ETIMEDOUT', ...]}` was accepted, validated, and then matched nothing. Both spellings end up in the list.
Making the codes retryable is only half of it; `requestSignal` is the other half — see Timeouts.

# Hooks

Arrays, got's signatures, **read from instance options only** — a `hooks` object passed to a single call is
ignored. The constructor flattens each array onto the instance (`beforeRequestHooks` etc., `undefined` when
empty) so `call()` only checks for a truthy field per request. `extend()` concatenates them with the parent's,
like handlers.

`afterResponse` hooks get `(response, retryWithMergedOptions)`. `retryWithMergedOptions` merges over the options
the request was sent with and calls `call()` **directly, not `handle()`** — handlers already ran for this
request, and re-entering them would re-log and re-wrap a request the caller made once. It also clears
`prefixUrl`, since `options.url` was already resolved against it on the first attempt.

**Going straight to `call()` means skipping `formOptions`, so the retry has to redo its three jobs itself.** It
validates the hook's options (`validateRequest(newOptions, this.followsRedirects)`, gated on `this.validate`
exactly as `formOptions` gates its own), folds the method's case (`normaliseMethod`), and **merges through
`mergeOptions` rather than a plain spread**. Without the first two this was a second, permanent `validate: false`
that no caller could turn on: `retry({method: 'post'})` put the literal `post` on the
request line and the server answered 400 where got normalises it and succeeds, `retry({responseType: 'jsn'})` fell
past the `json`/`text` arms and handed back a `Buffer` where the identical typo on the original call throws, and
`retry({timeout: {request: 0}})` and `retry({prefixUrl: 'http://h?q=1'})` slipped past the checks written
specifically to reject them. A `ValidationError` raised here is rethrown untouched by the `afterResponse` catch
rather than wrapped in a `RequestError`, so the same bad option reports itself the same way on both routes — the
class is a pinned divergence from got and has to stay distinct.

**The third job was the one that stayed missing longest, and it is the same `undefined` trap `mergeOptions`
exists for.** A key present with the value `undefined` wins a spread, and a refresh hook writes that shape
constantly — `retry({headers, method: req.method, throwHttpErrors: cfg.throwHttpErrors})`, forwarded from
somewhere any of those can be absent. Measured: `retry({method: undefined})` replayed a POST as a **GET**,
`retry({throwHttpErrors: undefined})` resolved the 401 that triggered the retry as a success,
`retry({responseType: undefined})` handed back a `Buffer` while still sending `accept: application/json`, and
`retry({url: undefined})` killed the dispatch with `UND_ERR_INVALID_ARG`. got's `Options.merge` — which its own
`retryWithMergedOptions` goes through — `continue`s on `value === undefined`, and so does every other route into
`call()` here. Pinned by *an afterResponse retry ignores an option the hook names as undefined*, which asserts
that a key named as `undefined` is indistinguishable from one left out, rather than listing outcomes per option.

**`validateRequest` is shared by the two routes for the same reason.** `formOptions` and the retry each spelled
the per-request check out, and the retry's copy was missing the `followRedirect: true` half — so a hook asking for
redirects was ignored where the identical option on the call that triggered it is a `ValidationError`. One
function, so a rule added to one route cannot go missing from the other; the `followRedirect` row in the
retry/`formOptions` invariant table is what holds it there.

**A retry may hand back the request's own options** — `retry(response.request.options)`, or a spread of them —
because got documents exactly that. Formed options carry the client's `hooks`, `retry`, `handlers` and the other
create/extend-only options, so validating them as a per-request call made every such retry a `ValidationError` on
any client with an `afterResponse` hook, i.e. on every client that could call it. `withoutInheritedClientOptions`
drops a create/extend-only key whose value is *identical* to the one the request already carries before the check
runs; a hook naming a different `hooks` or `retry` is still refused. Found by got's own suite
(`infinite-loop-issue.ts`, and the `reusing request options` rows of `hooks.ts`).

**The retried request runs only the hooks *before* the one that retried** (`afterResponseLimit`, a symbol on the
options, same trick as `retryDepth`). Re-running the whole array meant a refreshed request re-fired every earlier
hook and let the retrying hook see its own retry. got does `hooks.afterResponse.slice(0, index)` for the same
reason — measured against got-cjs: `[h1, h2]` with `h2` retrying gives `h1, h2, h1`. **The hooks *after* the
retrying one never run, on either response**: got's retry throws a `RetryError` that abandons the loop, so the
outer loop here stops once a hook has called `retryWithMergedOptions` (the `retried` flag). Carrying on ran them on
the retried response — `[h1, h2, h3]` gave `h1, h2, h1, h3` against got's `h1, h2, h1`. A side effect worth knowing:
each retry has strictly fewer hooks left than the last, so the chain is bounded by the array's own length and
`ERR_TOO_MANY_RETRIES` is now unreachable through the hook path. `maxAfterResponseRetries` is kept as a guard on
`retryWithMergedOptions` being driven directly.

**The hook loop has its own `try`, like the pre-request work.** A hook that threw — or one that simply forgot to
`return response`, which failed with `Cannot read properties of undefined (reading 'statusCode')` — escaped as a
raw error, skipping the `RequestError` wrapper and the `beforeError` hooks, so a caller matching on
`instanceof RequestError` missed it. The hook's return value is checked (`isResponseLike`) the way got checks it,
on `statusCode` only: got also requires a non-null `body`, which here would reject the legitimate `undefined`
body of a 204 read as json. An error already in `normalisedErrors` is rethrown untouched so the hooks don't fire
twice for one failure.

**Which means a hook may hand back a response it built itself, and `throwHttpErrors` has to cope.** The decision
reads `response.request.options` rather than the outer `options`, because a hook that *retried* replaced the
response with one the nested `call()` already judged under its own url and flag — but a hand-made
`{statusCode, body}` carries no `request` at all, and reading straight through it threw a bare
`Cannot read properties of undefined (reading 'options')` from **outside** the hook loop's `try`. That was the
last place a raw error could still escape the `RequestError` wrapper and the `beforeError` hooks. It falls back
to `options` now, which is the right answer for a response that names none.

**`prefixUrl` comes back when the hook supplies a `url`.** It was cleared unconditionally, on the reasoning that
`options.url` had already been resolved against it - true, but a `url` the hook supplies has *not* been, so a
relative path was dispatched as-is and failed as an invalid url. An absolute one ignores the prefix anyway.

**And the first attempt's `searchParams` do not come with it.** `call()` lays `searchParams` over whatever query
the url carries, so `retry({url: 'https://h/p?token=new'})` after a call made with `searchParams: {a: 1}` put
`/p?a=1` on the wire — the new token dropped, and the refresh failing with the same 401 it was meant to fix. got's
`searchParams` is the url's own, so a new url replaces it (measured against got 16: `/p?token=new`, and a new url
with no query sends none). Only `searchParams` the hook names itself go over the new url; a retry naming no
`url` still merges its query into the first attempt's as before.

**New credentials on the retry drop the stale `authorization`.** `call()` only derives a Basic-auth header when
none is present yet, so the first attempt's header survived the merge and was read as "already set" — the hook's
credentials never left the process. That covers a `url` carrying userinfo as well as explicit
`username`/`password`, since `retry({url: 'http://user2:pass2@host/p'})` is the same intent by the other route, and
it is gated on `parseUserinfo`: with the scan off nothing would re-derive the header and the retry would go out
anonymous. A hook's own `authorization` header still wins. Measured against got 16, which uses a new url's
credentials and keeps the previous ones for a new url that carries none — so a url without userinfo deliberately
leaves the header alone.

It **always reallocates `headers`**, even when the hook passed none. Aliasing the first attempt's header object
meant `call()`'s own writes on the retry — a `content-type` for a body the retry added — landed on the options
the *first* response reports having been sent with.

**A body the hook supplies replaces the first attempt's, and takes its `content-type` with it.** `call()` resolves
`json` → `form` → `body` in that order, so a plain `{...options, ...newOptions}` let the first attempt's `json`
outrank a `body` or `form` the hook had just set: measured, a hook returning `retry({form: {q: 'x'}})` after a
`json: {a: 1}` first attempt re-sent `{"a":1}` labelled `application/json`, and the form never left the process.
So if `newOptions` names any of the three, the other two are cleared — the same mutual exclusion `formOptions`
applies to the client defaults via `baseHasBody` — and the stale `content-type` is dropped so `call()` re-derives
it, unless the hook set a `content-type` itself. A hook that names *no* body keeps the first attempt's body and
content-type, which is what a token refresh wants.

**An explicit `content-length` goes with it, for the same reason and under the same conditions.** It describes the
body being replaced just as `content-type` does, but fails louder: undici validates a caller-supplied
`content-length` against the body it is about to send (`strictContentLength`, on by default) and errors the
dispatch rather than recomputing it, so a first attempt that set one and a retry that swapped in a body of a
different length died as an opaque `ERR_REQUEST_ERROR` (`UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` on `cause`) whose
real cause was a header left over from the previous attempt. Dropped unless the hook set a `content-length`
itself. Note that undici's check applies to a `beforeRequest` hook rewriting `options.body` too — nothing here
re-derives a length the caller wrote by hand, and the README says so.

It is also **bounded** (`maxAfterResponseRetries`, 20), tracked through a symbol key on the options so option
spreads carry it while `for...in` validation and `Object.keys` never see it. A hook that always retries on a
status it never stops seeing — an auth refresh that silently fails — used to recurse until the process died.
Cutting the hook array at the retrying hook (above) is what actually rules that out now, since each retry has
strictly fewer hooks left to run; the depth bound stays as a guard for `retryWithMergedOptions` called directly.

**A hook that moves the request to another origin does not take the credentials with it.**
`authorization`, `cookie`, `cookie2`, `host` and `proxy-authorization` are dropped, along with the
body, when a `beforeRequest` hook rewrites `options.url` across an origin boundary or an
`afterResponse` retry names a url on another origin. A hook is exactly where a url arrives from
somewhere else — a signing service, a discovered endpoint, a redirect the caller resolves — and
every one of those used to carry the caller's token, their session cookie and the payload meant for
their own api to whatever host the hook named. undici already strips these when *it* follows a
cross-origin redirect (see the `beforeRedirect` note below); this is the same boundary reached by
the route the client controls, and got 16 fixed it there for the same reason.

What the hook sets *itself* survives — a header the hook **wrote**, assigned or deleted, is the hook
saying "these are the credentials for where I am sending this", and a body it replaced was built for
the new origin. An unchanged body goes, and takes `content-type` and
`content-length` with it (a stale `content-length` would fail the dispatch under undici's
`strictContentLength`). On the retry path the same test is "did `newOptions` name it", and
`username`/`password` are cleared too — otherwise `call()` derives the same `authorization` straight
back from the first attempt's credentials and undoes the strip. Userinfo on the *new* url is left
alone: those are credentials for the new origin, and got uses them too.

`sameOrigin` answers the question. The common case — a signing hook that rewrote the path or
appended to the query — is settled by comparing the authority text in place, which allocates
nothing and parses nothing; `URL` is only reached for when that text actually differs, and then it
is the right answer for a default port written out, a host in another case, or userinfo on one
side. **A url that cannot be parsed counts as a different origin**: this decides whether credentials
travel, so the unparseable case has to fail towards stripping them. The snapshot of what the
request carried before the hooks (`crossOriginState`) is one small object of booleans — *whether*
each header was set, never its value — taken only for a client that has `beforeRequest` hooks at
all; it has to be eager, since whether the origin moved is only known once the hooks have run. All
of it is measured against got 16 in the parity suite, including the cases where nothing is stripped.

**"Did a hook touch this" is tracked, not inferred from the value** (`trackHookWrites`). Comparing
values mistook a hook explicitly re-asserting the very same `authorization` string — or rebuilding a
body that happened to serialise identically — for one that had left it alone, and stripped it anyway,
which is the opposite of what the paragraph above promises. A `Proxy` over `options.headers` and an
accessor over `options.body` record the writes, the way got's own `trackStateMutations` does.
**Both come back off the moment the hook loop ends** (`writes.restore()`). They used to stay on all
the way to the dispatch, so undici read every header of every request through the `Proxy` — measured
at ~780ns a request against ~19ns for the plain object, on a client whose whole documented overhead
is under 500ns, and paid by exactly the clients that always have hooks. `Reflect.set` is called
without a `receiver` for the same reason: handing the `Proxy` back sends the write round through
`[[DefineOwnProperty]]` on it again for nothing. There is a test asserting the options the request
went out with carry neither.

**`restore()` is in a `finally`, because a hook that throws leaves the request just as instrumented as one that
returns.** It used to sit after the loop, so a throwing hook left the `Proxy` on `options.headers` and the
accessor on `options.body` — and *that* options object is exactly what the failure carries onwards, to the
`beforeError` hooks and out on `error.options`, where every header read went through a trap with no business
still being there.

**`delete options.body` counts as a write, and has to be detected in `restore()` rather than by the
accessor.** Deleting the property takes the accessor with it, so the setter never fires — and
`restore()` then re-defined `body` from the value it had held before the hooks ran, putting the body
the hook had just removed straight back on the wire. Only on a client that *has* `beforeRequest`
hooks, since one without them never installs the accessor and the delete works there: the identical
hook sent a body on one client and not on the other, and `options.body = undefined` (which goes
through the setter) always worked. `restore()` checks `Object.hasOwn(options, 'body')` and reads an
absent property as a write of `undefined` — the same thing a deleted *header* already means to the
`deleteProperty` trap, and for the same reason: both are the hook saying what the request carries.

**A header survives only when *both* signals say the hook left it alone**, and neither signal alone
is enough. The write set goes blind the moment a hook assigns a whole new headers object
(`options.headers = {authorization: ...}`), which throws the `Proxy` away along with everything it
recorded — measured, such a hook's freshly minted credentials for the *new* origin were deleted and
the request went out anonymous, where got 16 sends them and where the value comparison this replaced
had been right. So `stripCrossOrigin` asks for no recorded write **and** an unchanged value, and
`crossOriginState` keeps the values for that second half. The body needs only the write test: its
accessor sits on `options` itself, which a hook cannot replace the way it can replace
`options.headers`. Replacing the headers object wholesale is ordinary in a signing hook, and the
symptom was a 401 from the host the hook had just authenticated to.

`beforeError` hooks may return a replacement error; anything that isn't an `Error` is ignored. They run for
**every** failure path, streams included — see Streams — and for anything a `beforeRequest` or `afterResponse`
hook throws. The `afterResponse` loop was the last uncovered path; it has its own `try` now.

**`json`/`form` are serialised into `options.body` *before* the `beforeRequest` hooks run**, which is where got
does it too, so a hook that rewrites `options.json` is writing to something already consumed and the original body
goes out. Measured against got 16, which is *louder* about it rather than different: assigning `options.json` in a
got hook throws (``Expected value which is `undefined`, received value of type `string`.``), because got's `json` setter
asserts that `body` is still unset. **Write `options.body` instead** — that works here, and `content-length` is
re-derived from it (in got it is not, and the stale length gets the request rejected). Reordering the two to make
`options.json` writable would be a divergence from got, so it is documented rather than changed.

**The pre-request work in `call()` has its own `try`.** The url resolution, body serialisation and the
`beforeRequest` hook loop all sit inside it, so a throwing hook (or a circular `json`) becomes a `RequestError`
with the hook's own message and runs the `beforeError` hooks. It used to reject with the raw error, which meant
a caller matching on `instanceof RequestError` missed it entirely.

# got's spellings: error classes, codes and the promise shortcuts

All of this came out of running got's own suite (`conformance/`), where each was a mismatch a caller matching
on got's names would hit. None of it runs on a request that succeeds.

- **`transportFailure`** reports the generic failure: undici's `UND_ERR_SOCKET`/`other side closed` as
  `ECONNRESET` (what got reports and what callers and retry lists name), an `Invalid URL protocol` as
  `ERR_UNSUPPORTED_PROTOCOL`/`Unsupported protocol: ftp:`, and a call with no url and no `prefixUrl` (the formed
  url is `''`) as `Missing \`url\` property`. `timeoutMessage` gives `timeout.request` got's `Timeout awaiting
  'request' for 5000ms`; a caller's own `AbortSignal.timeout()` keeps its message. `abortMessage` gives got's
  `This operation was aborted.` - with the period - unless the caller aborted with a reason of their own.
  `call()` and `toStreamError` both go through them, so the two APIs cannot drift.
- **`ReadError`** is any failure once the head has arrived (`headArrived` in `call()`, a `response` in
  `toStreamError`): a reset mid-body, a truncated gzip stream. Code falls back to got's
  `ERR_READING_RESPONSE_STREAM` when the cause has none.
- **`MaxRedirectsError`** (`Redirected 10 times. Aborting.`, `ERR_TOO_MANY_REDIRECTS`) replaces the `HTTPError`
  for the 3xx undici gave up on - decided by the tracker's `redirects.count > maxRedirections`, so a 3xx undici
  declined for another reason (no `location`, a non-replayable body) is still an `HTTPError`. undici's `Redirect
  loop detected` gets the same class and code, and keeps its message.
- **`resumeFailure`**: with retries on, undici resumes a body cut off mid-way with a `Range` request, and a
  server that ignores it makes undici fail with `server does not support the range header ...`. The error
  reported is the reset that caused the resume (`retriedBy`, kept by `countAttempts` past the retry that clears
  `lastError`). got restarts the request instead; resuming is undici's retry handler and stays.
- **`response.requestUrl`, `redirectUrls`, `statusMessage`** are prototype getters, so a response that never
  reads them pays nothing. `redirectUrls` comes from the tracker's `urls` (replaced, never truncated, on a
  retry). `statusMessage` is node's standard phrase: a server's own reaches only a dispatch handler.
- **`.json()`/`.text()`/`.buffer()`** are attached by `withShortcuts` in `handleInput` - the one entry point
  the verbs and the callable form share, and skipped for streams. Three shared functions stored on the promise,
  not closures: measured against a null dispatcher, no difference beyond noise. `.json()` cannot add `accept`
  the way got's does - the request is already on its way - and hands back an empty body as `''`, as got's parser
  does. Every verb overload returns `ResponsePromise<X>`; add one and it must too.

# Bodyless responses and parse failures

`hasNoBody()` short-circuits parsing for `204`/`205`/`304` and `HEAD` — the body is `undefined` for `json`,
`''` for `text`, an empty `Buffer` otherwise. Without it every empty 204 became a failure.

**An empty body is never a parse failure, on *any* status.** `hasNoBody` covers only the statuses that cannot
carry one, so every other zero-length body fell into `JSON.parse('')` and came back out as a `ParseError` — a
`201 Created` with nothing in it, a `200` with `content-length: 0`, a `3xx` read with `followRedirect` off. All
three are ordinary responses, and a json-typed client rejected all three. got resolves them with `''`: its
`parseBody` tests `rawBody.length === 0` before it ever reaches the JSON codec, and the json branch in `call()`
now makes the same test one decoding later (`text !== ''`). `''` rather than `undefined`, because that is what
got hands back; the *bodyless* statuses keep their `undefined`, which stays a recorded divergence. Pinned by
*an empty body on a status that can carry one resolves rather than failing to parse*, which drives a table of
statuses rather than one — what was wrong here was a status **range**, so a scenario naming a single code could
pass while its neighbours failed.

**A parse failure on an error status is not a parse failure.** An upstream answering a 500 with an HTML error
page used to raise `ERR_BODY_PARSE_FAILURE` *before* the `afterResponse` hooks ran, so a refresh hook never saw
the status that triggers it. The body is left as the text that arrived, the hooks look at it, and
`throwHttpErrors` decides. Measured against got 16: the hooks run and `HTTPError` is thrown, and with
`throwHttpErrors: false` it *resolves* with the raw body - got never raises a parse error there. Only a parse
failure on an otherwise-ok status is a `ParseError`.

Parse failures are flagged (`parseFailed`) at the `JSON.parse` call, **not recognised by message**. V8 words
them differently depending on input — "Unexpected end of JSON input" for an empty body versus "… is not valid
JSON" for garbage — and the old `message.endsWith('not valid JSON')` check misfiled empty bodies as
`ERR_REQUEST_ERROR`. Don't reintroduce message sniffing.

A signal reports its reason as a `DOMException`: `AbortError` from `abort()`, `TimeoutError` from
`AbortSignal.timeout()`. The first maps to `AbortError`/`ERR_ABORTED`, the second to `TimeoutError`/`ETIMEDOUT`
so that both kinds of timeout look the same to callers.

**`abort(reason)` is the third case**, and the one the name test alone missed: undici rethrows the caller's
reason verbatim, so a deliberate `abort(new Error('cancelled'))` arrived as a plain `Error` and was reported as
a generic `ERR_REQUEST_ERROR`. `options.signal?.aborted` is consulted as well as the name. The timeout test
(`isTimeoutReason`, which looks at the signal's reason too) runs **first**, since the abort test is the broader
of the two and would otherwise swallow an `AbortSignal.timeout` the caller passed in.

# Shared internals worth not re-duplicating

These exist because the same code was written out two or three times, and each copy was a place to
forget a field:

- **`dispatchOptions()`** — the options every dispatch shares. `call()`, `callBodylessStream()` and
  `callStream()` each built this literal by hand. It also owns the `redirects` and `attempts` holders and the
  deadline's `release` (see Timeouts), so no caller recomputes them — and, because it owns `attempts`, the stream paths get retry bookkeeping for free.
  They used to get none, which left `beforeRetry` silently unfired and `retryCount` pinned at 0 on a stream
  undici had in fact retried.
- **`trackDispatches(select, onRedispatch)`** + **`OutcomeHandler`** — one interceptor factory and one
  `DecoratorHandler` behind both `countAttempts` (retries) and `makeRedirectTracker` (redirects). They had
  separate, near-identical handler classes recording the same three fields.
- **`normaliseStreamErrors()`** / **`normaliseBodyErrors()`** — one `_destroy` wrap behind both stream paths, so
  the upload path can't drift back into reporting undici's raw errors while the bodyless one normalises. See
  Streams.
- **`makeStreamHead()`** / **`streamResponse()`** / **`streamHttpError()`** — the response head, the response a
  stream *failure* carries, and the `throwHttpErrors` failure itself, which `callBodylessStream` and `callStream`
  each spelled out in full. Both copies had to remember that `url` is the
  url that *answered* rather than `options.url`, that `retryCount` comes off the shared attempt holder, and
  that the error carries a `GotlikeResponse` with no body (it has been dumped or resumed by then). The error
  helper deliberately does **not** await: the bodyless path awaits it, and the pipeline path needs the promise
  so its readable can raise at read time rather than throwing synchronously.
  `streamResponse` takes the whole `dispatch` rather than a url so that `redirects?.lastUrl` is read in **one**
  place: it is now reached from three call sites, and three copies of that optional chain is three places for a
  stream's error to start naming a url the response never came from. It is not a `formResponse()` in disguise —
  the wrapper this file warns against took `(body, statusCode, headers, …)` and called the constructor as
  `(body, headers, statusCode, …)`, while this reads every field off `head` by name and its three parameters have
  three unrelated types, so there is no positional list left to transpose.
- **`appendQuery()`** — the `searchParams` walk, behind both `stringifyQuery` (serialise one) and
  `mergeSearchParams` (merge two). Merging through a string round-trip on both sides cost ~300ns; walking the
  override directly is ~105ns and cannot drift from the rules serialising applies.
- **`messageOf()`** — the underlying error's message with a fallback, used by the two `ERR_REQUEST_ERROR` sites
  that had diverged (one reported the real message, the other a generic label).
- **`isOk()` / `isHttpError()`** — the status predicates were spelled out inline in four places, twice with
  subtly different boundaries.
- **`elapsedMs()`**, **`mergeRecords()`**, **`mergeHooks()`**, **`usedHooks()`** — small, but each replaced a
  repeated expression.
- **`GotlikeResponse` is constructed directly.** There used to be a `formResponse()` wrapper that took
  `(body, statusCode, headers, …)` and called the constructor as `(body, headers, statusCode, …)` — an
  invisible swap, one edit from a silent bug. Don't bring one back: the two remaining hand-written sites are
  both in `call()` (the success path and the catch), where they are three lines apart and the arguments are
  read from the same locals. `streamHttpError` is not a counter-example — it takes a `StreamHead` and reads
  the fields off it by name, so there is no positional list to transpose.

`formOptions()` deliberately still hand-rolls its merge rather than sharing one with `extend()` and
`retryWithMergedOptions()`: it is the hot path (~120ns including validation, measured), and the other two run
once per client or once per refresh.

`knownOptionMap` is `satisfies Record<keyof RequestOptions, true>`, so **adding an option to the type without
registering it is a compile error**. `clientOnlyOptions` is a `Set` because validation consults it per option
per request, and it **spreads `agentOptions` rather than relisting them**: every agent-level option is
client-only by definition, since it decides which dispatcher is built, and one missing from the set would be
accepted per request and then ignored. Both were lists that could silently drift.

`validateOptions` itself is **not exported**. It is reached only through the constructor, `formOptions` and
`extend`, and its `atCreation` flag is an internal distinction — exporting it would freeze that signature as
public API for no caller that exists.

# retryCount and beforeRetry

undici exposes no retry counter — `response.context` is `null` after a retried request, and the
`retryOptions.retry` callback would mean reimplementing undici's default backoff to delegate to it. Instead
`countAttempts`, a plain interceptor composed **inside** the retry interceptor, sees every re-dispatch; the
count minus one is `retryCount`. `OutcomeHandler` (a `DecoratorHandler`) records each attempt's status or
error so the next dispatch can report why it was retried. All public API.

**`onResponseError` clears the status as well as recording the error**, which `onResponseStart` has always done
in the other direction. An attempt that failed before its headers arrived produced no status at all, but the
previous attempt's survived on the shared holder — so a 503 followed by a socket reset told `beforeRetry` that
the reset had come with a 503, a response that attempt was never sent, and a hook branching on the status acted
on it. Exactly one of `error`/`statusCode` reaches the hook now; the redirect tracker reads the same field as its
"this hop is not a redirect" guard (`lastStatusCode === undefined`), so the two agree.

`beforeRetry` fires from that interceptor and **cannot delay or cancel a retry** — undici decides to retry
inside a synchronous dispatch, so there is nothing to await on. It is for logging and metrics; this is a
documented divergence from got, not an oversight.

`attemptState()` builds the holder and `dispatchOptions()` hands it to every dispatch, so `retryCount` and
`beforeRetry` work identically for `call()` and for both stream paths (`StreamHead.retryCount`).

**A hook-driven retry counts as one retry, and the count carries forward from the response the hook was handed.**
`retryWithMergedOptions` used to add its own `depth` — the *nesting* level of the call — to whatever the nested
`call()` reported, which is a count of nothing: two hooks each retrying once both ran at depth 1 and reported one
retry between them, while a retry nested inside another reported three for two. The number now comes from
`retriesSoFar`, captured per hook from `response.retryCount` (which already includes undici's own network
retries), plus one; `beforeRetry` is given the same value. Both shapes are pinned against the dispatches a
`beforeRequest` hook counts, which is the only unarguable number. `retryDepth` remains, but purely as the bound
`maxAfterResponseRetries` is checked against.

**`countAttempts` also starts the redirect chain over.** A retry is a fresh chain - undici's
`RedirectHandler` counts hops per attempt - but the redirect tracker's state holder travels with the dispatch
options and so survived the retry interceptor's re-dispatch. The retried attempt entered the tracker with the
previous attempt's hop count already on it, was treated as one more hop, and fired `beforeRedirect` telling
the hook that a `503` had redirected to the url the request started from - which is exactly the hook where
people re-add a stripped `authorization` header. `lastUrl` only came out right by accident, because that
bogus hop happened to overwrite it with the attempt's own url; it is cleared instead, so `response.url` falls
back to the url that was requested, which is where a retry that followed no redirects was in fact answered.
This works from `countAttempts` because it is composed *outside* the redirect interceptor and so runs before
the new attempt's first hop, and because the holder is the same object every hop sees.

**The redirect interceptor is gotlike's own (`redirectInterceptor`), wrapping a subclass of undici's
`RedirectHandler`**, for two differences from got that undici's interceptor has no option for. undici's loop
check compares urls only and records the current url *before* comparing, so Post/Redirect/Get to the same url
(`POST /orders` -> 303 -> `GET /orders`) was refused as `Redirect loop detected` every time;
`GotlikeRedirectHandler` shows the check a same-length history that can match nothing on a hop that turns the
request into a GET, so the redirect limit still counts it and a same-method loop is still caught. And a
cross-origin hop now strips `cookie2` as well (via undici's own `stripHeadersOnCrossOriginRedirect`), since got
strips all four credentials and undici only three. Both found by running got's own suite (`conformance/`). The
subclass reaches `history` and `opts`, which undici's typings don't declare - if an undici upgrade renames them,
the PRG test fails rather than anything silently changing.

`beforeRedirect` uses the same shape: `makeRedirectTracker` is composed **inside** undici's redirect
interceptor, so it is re-entered per hop, and the hop's options are still mutable there — which is what lets
a hook put back an `authorization` header that undici stripped on a cross-origin redirect.

**The tracker is composed whenever the client follows redirects, not only when it has hooks**, because it is also
what records `lastUrl`. undici follows a chain inside its own interceptor and never reports where it ended up, so
`response.url` named the url that *redirected* rather than the one that answered — wrong for anything resolving a
relative link or logging provenance, and got documents `response.url` as the final url. `GotlikeResponse` takes it
as an eighth constructor argument and the `url` getter prefers it; both stream paths put it on `StreamHead.url`.
`options.url` deliberately stays the url that was *requested*, so an `afterResponse` retry goes back through the
redirect rather than jumping to its destination.

Two things that cost real debugging and are easy to undo:
- **The state holder must be handed in with the dispatch options, not attached on first entry.**
  `RedirectHandler` copies the options in its constructor — *before* hop 1 reaches the interceptor — and
  re-dispatches hops 2+ with that copy. State attached on hop 1 is invisible to hop 2, which silently loses
  the first hook call.
- **At a redirect hop `opts.headers` is undici's flat `[name, value, ...]` array**, not an object. A hook
  writing `headers.authorization` on that array achieves nothing, so `headersToObject` normalises it and the
  result is always assigned back.
- **A multi-valued header has to survive that conversion as an array.** In the flat form a header's value may
  itself be an array, and `String(['one', 'two'])` flattened it to the single value `one,two` — so a request
  carrying `{'x-a': ['one', 'two']}` went out as two headers before a redirect and one after it. A name repeated
  across the flat array is collected the same way. Only clients with a `beforeRedirect` hook were affected, since
  nothing else reaches this conversion.

`DecoratorHandler`'s `.d.ts` declares no members even though the runtime class has them, hence the
`DecoratorHandlerShape` declaration used to type the two methods we override.

# Bodies and decompression

`json` → `form` → `body` in precedence order; the first two set a `Content-Type` unless one is already present
(checked case-insensitively, because undici would otherwise send both and the server picks). `decompress` is
instance-level and drives two things that must agree: composing `interceptors.decompress()` and sending an
`accept-encoding` header. undici's interceptor decompresses based on the response only — it never asks for
compression — so without the header nothing upstream compresses in the first place.

**A `FormData` body is encoded here, not passed through.** `undici.request()` does not accept one -
and does not reject it either: measured, the request simply never leaves and the caller waits
forever, which is the worst way to find out. got 15 made the `FormData` global the documented way to
send multipart, so a caller migrating writes exactly that. `new Response(form)` is the encoder node
already ships; it produces the multipart bytes and the `content-type` carrying the boundary, which
has to be the one that encoding generated. The body goes out as a `Readable` rather than a buffer,
so a large upload is not materialised - with the consequence, as in got, that it cannot be replayed
across a redirect or a retry. Encoded *after* the `beforeRequest` hooks, so a hook still sees the
`FormData` it was handed and can add a signed field to it. Byte-identical to got's encoding,
boundary aside, in the parity suite.

`responseType: 'buffer'` returns a real Node `Buffer`, not the `ArrayBuffer` undici hands back. Callers feed
this to things like `sharp()` which reject anything else. **got 15 moved the other way**, to a plain
`Uint8Array` for both `body` and `rawBody`. `Buffer` is a subclass of it, so gotlike's value satisfies
anything typed for a `Uint8Array` while keeping the methods those callers reach for; the difference is in
the README's divergence table rather than followed.

`acceptEncoding` is computed once at module load from what this runtime's `zlib` actually provides —
`createZstdDecompress` only exists from node 22.15 and `engines` allows 22.12, so a hardcoded header would
advertise an encoding we can't decode. undici degrades to *not* decompressing in that case rather than
throwing, which would hand callers compressed bytes silently.

**undici's decompress interceptor is still flagged experimental**, so because `decompress` defaults to `true`,
every consumer gets `ExperimentalWarning: DecompressInterceptor is experimental and subject to change` on stderr
once per process. Nothing we can suppress from inside a library without hiding the caller's own warnings, so it is
documented in the README (with `decompress: false` and `--disable-warning=ExperimentalWarning` as the outs) rather
than worked around. Worth re-checking whenever undici is bumped — if it graduates, the README note goes.

`response.rawBody` is a lazy getter, not an eager field: text and JSON go through undici's optimised
`body.text()`, and materialising a Buffer per request just in case would cost more than it saves.

**It is the bytes that arrived, not a re-serialisation.** For `responseType: 'json'` the original text is carried
onto `GotlikeResponse` as a seventh constructor argument, because `JSON.stringify(parsedBody)` gave back
`{"a":1}` for a response that was on the wire as `{\n  "a"  :  1\n}` — which silently breaks any signature or
digest checked over `rawBody`.

**The one limit on that, and it is deliberate:** on the `text`/`json` paths `rawBody` is a UTF-8 encoding of the
decoded text, so it is byte-exact only for UTF-8 — which JSON is by RFC 8259, and which `charset=utf-8` promises.
A response in another charset comes back through undici's `body.text()` already decoded lossily (`0xe9` → U+FFFD),
so `body` is mojibake and `rawBody` re-encodes the mojibake: measured, `63 61 66 e9` reads back as
`63 61 66 ef bf bd`. `responseType: 'buffer'` is exact and is the answer for those responses. Making the text path
exact would mean reading `bytes()` instead of `text()` on *every* response — undici's single-chunk `text()` decodes
in place with no copy, while `bytes()` copies the body first — measured at +160ns for 250 bytes, +2.2µs for 100KB,
paid by every caller to serve the few who read `rawBody` on a non-UTF-8 response. Don't make that trade without
a reason to.

The same `text()` call **strips a UTF-8 BOM**, where got 16 keeps it (`body` starts with U+FEFF, `rawBody` with
`ef bb bf`, and a BOM-prefixed JSON body is a `ParseError` there but parses here). Measured against got 16, and
kept for the same cost reason; it is a README divergence row, not a bug.

# Streams

**`stream` is a getter, not a method**, and hands back one memoised callable per client (`makeStreamClient`).
got hangs the verb helpers off it — `got.stream.post(url, options)` — and those have to be bound to the client,
which a prototype method shared by every instance has nowhere to put. Calling one used to be a `TypeError`, a
hard stop for anything migrating that writes it the got way, and it was undocumented besides. Built on first
read, so a client that never streams allocates nothing; `asCallable` already forwards prototype getters, so the
callable form gets it for free. The verbs are assigned through an index signature because
`stream[verb]` with `verb` a union of the eight names asks TypeScript to satisfy all eight return types with one
function — `StreamClient` is what keeps the call sites honest.

There are **two** stream paths, and which one runs depends on whether the request has a body:

- **a method that can't carry a body** → `callBodylessStream`, via `undici.request`. Returns the
  response `Readable` unwrapped. A body supplied in the *options* still goes out; undici sends one on a GET.
- **a `bodyMethods` method** → `callStream`, via `undici.pipeline`, returning a `Duplex` whose writable half is
  the request body.

The split is on `bodyMethods` (`POST`/`PUT`/`PATCH`/`DELETE`/`QUERY`), which `BodyMethod` is derived from so the list
and the type can't drift - **on the method alone, never on whether a body is present**. It used to route anything
carrying a body to the pipeline, which meant `stream(url, {body})` on a GET took the one path that cannot follow a
redirect (below) and resolved with the bare 302, whatever `followRedirect` said. The pipeline path exists so the
*caller* can write the body into the duplex; a body that arrived in the options needs none of that, and through
`undici.request` it is an ordinary replayable body that survives the hop. The `stream()` overloads key on `method`
too, so they had been promising a `Readable` for exactly the case that returned a `Duplex`. It used to test `method === 'GET' || 'HEAD'`, which put every other bodyless method —
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

**But `setImmediate` alone put the `response` event *after* the body**, and `announceHead` is what fixes it.
The head is already in hand when `stream()` resolves, so the deferral is unavoidable — and attaching a `data`
listener, which `pipe()`, `on('data')` and `for await` all do in the same synchronous block as the `response`
listener, starts the flow on a `process.nextTick`, which runs before any `setImmediate`. Measured against got 16
on the same server, the got-shaped proxy (`on('response', copyHead); pipe(res)`) saw `data` then `response` here
and `response` then `data` there — so a status and headers copied onto an outgoing response were written *after*
body bytes had already gone out on it. `announceHead` emits from a **`newListener` hook** as well, the same
technique `raiseWhenListening` uses below: it fires before the listener is registered and before `resume()` is
called, so the head goes in front of the first chunk for the very consumer about to start the flow. The
`setImmediate` remains the path for a caller that only awaits `stream.response` or listens for `response` alone.
Two things to keep: the hook only fires for `data`/`readable` (the two events that start a readable flowing),
and it emits **only when a `response` listener already exists** — emitting into an empty listener list would
throw the event away, so a caller that attached `data` first is left to the `setImmediate`, having already said
it wants data before the head. Only `asStream` (the bodyless path) needed this; `callStream` emits from inside
the `undici.pipeline` handler, which is already ahead of the body.

**Read time is not the only trigger, though: `raiseWhenListening` also raises it as soon as something listens
for `error`.** got emits a stream's failure whether or not the stream is ever read, and the pattern that
depends on that is ordinary — listen for `error` and `response`, pipe from inside the `response` handler. A
request that failed before any response never fires `response`, so nothing ever read the stream, so the error
was never raised and the caller waited forever on a request that had already failed. (`stream.response` did
reject throughout — the `.catch(noop)` on it only marks the rejection handled — so the failure was reachable,
just not where a got-shaped caller was looking.)

Destroying unconditionally is what can't be done, and is why this is gated on a listener existing rather than
done on the next tick: an `error` with no handler is an uncaught exception, and `await stream.response`
attaches no listener at all. So: a listener at `setImmediate` time gets the error then; one attached later
gets it via a one-shot `newListener` hook (on `setImmediate` again, since the listener being added isn't
registered until that handler returns); nothing listening leaves it at read time, as before. Armed *after*
the `response` emit is queued, so a caller listening for both sees the head first.

This applies to the two **synthetic** streams only — `asStream`'s error readable and `failedUploadStream`.
A failure undici itself reports arrives on a real stream that undici destroys, which emits to a listener
already: a POST to a refused port comes back as a genuine `undici.pipeline` duplex, not `failedUploadStream`,
which is only reached when `pipeline` rejects its arguments synchronously.

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

**`failedUploadStream`'s writable half fails the write** rather than accepting and discarding it. Swallowing writes
was deliberate once - a caller piping in shouldn't get a second, less useful error - but it made
`await pipeline(source, upload)` *resolve successfully* for a request that was never sent, which is a far worse way to
find out. (Note this only covers the synchronous-rejection path; for a real pipeline duplex, `pipeline()` can still
finish the writable side before a connection error arrives, so `await stream.response` remains the reliable check.)

`undici.pipeline` can also reject its arguments synchronously; that is caught and reported on the stream
(`failedUploadStream`) rather than by rejecting `stream()`, so both paths fail the same way.

#### Every stream failure goes through `normaliseStreamErrors`

`throwHttpErrors` was the *only* stream failure that was ever normalised. Everything else reached the caller as
undici's own error, with the `beforeError` hooks unrun — while the README promised the opposite. Measured, before
the fix: a connection refused arrived as a bare `Error`, a `timeout.request` as a **`DOMException` whose `code` is
the number 23** (so nothing matching on `'ETIMEDOUT'` could see it), and a socket reset part-way through a body as
a `SocketError`. The bodyless path normalised only its *pre-response* failures, in `callBodylessStream`'s catch;
the upload path normalised nothing at all, because `duplex.on('error', …)` just forwarded the raw error to
`rejectHead`.

`normaliseStreamErrors` (via `this.normaliseBodyErrors`) is applied to **both** streams undici hands back, and is
the only thing between the caller and those raw errors. It works by wrapping `_destroy`:

- **Node emits whatever error the `_destroy` callback is given**, not the one `_destroy` was called with, and that
  callback may be called asynchronously — which is what makes awaiting the async `beforeError` hooks possible.
  undici's own `_destroy` still runs first and does its cleanup (aborting the request, destroying `req`/`res`);
  only the error passed onwards is replaced. Verified against `for await`, an `error` listener, and
  `stream.pipeline` — all three report the normalised error.
- **`stream.errored` is put back in step too.** It is public API and Node latches it from the raw error *before*
  `_destroy` runs, so it would otherwise disagree with the error every listener just saw. This is the one place
  that touches `_readableState`/`_writableState`, and only ever replaces one `Error` with another.
- **`normalisedErrors` (a `WeakSet`, populated by `toRequestError`) stops double-wrapping.** The HTTP-error path
  already builds its error through `toRequestError` and destroys the readable with it; without the set that error
  would be wrapped again and the hooks fired twice. A `WeakSet` rather than a marker property on the error,
  because a `beforeError` hook may return any error it likes, including a frozen one.
- **The error carries the response when one had arrived.** `toStreamError` passed `undefined` for it on every
  branch, so a failure *after* the head — a truncated download, a socket reset mid-body — reported
  `error.response` as undefined where the identical failure on the promise API reported status, headers and
  `request.options`. `call()`'s catch has always built a response whenever `undiciResponse` exists, and the
  README says `response` is absent *only* for a failure that came before one. `normaliseBodyErrors` therefore
  takes a `respondedWith` callback rather than a value: the bodyless path has its head by then, the upload path
  installs the wrapper before its head exists and so answers `undefined` until the pipeline handler has run. It
  is a callback and not a value for the second reason, and lazy so the happy path allocates nothing.
- Installed immediately after `undici.pipeline` returns, which is safe because it returns synchronously and every
  failure it reports is asynchronous. The synchronous-argument-rejection case is the separate
  `failedUploadStream` path above.

**Only the *request's* failures, though — `isRequestFailure` is what decides.** Wrapping `_destroy` catches every
destroy, including the ones the **consumer** makes, and those were being reported as transport failures. Measured:
`pipeline(stream, destinationThatThrows)` ran the client's `beforeError` hooks with
`RequestError/ERR_REQUEST_ERROR: disk full`, and a plain `stream.destroy()` ran them with
`AbortError/ERR_ABORTED`. For anything proxying a download — which is the shape the README's own
`on('response'); pipe(res)` example documents — that is a `beforeError` hook firing on every client disconnect,
reporting an upstream failure that never happened, with `stream.errored` rewritten to match. The hooks are
`await`ed inside the destroy callback too, so a slow one delayed the teardown of a stream the caller had already
abandoned, and with it `releaseOnClose`'s cancellation of the deadline. Three questions, in order:
- **what `destroy()` was called with.** undici never destroys a stream of its own without an error, so a `null`
  is always the consumer letting go — a bare `destroy()`, a `for await` with a `break`, a `pipeline` that
  finished early. undici's own `_destroy` still runs and still manufactures a `RequestAbortedError` for the
  request it is tearing down, but that is a *consequence* of the destroy, not the reason for it, and raw undici
  reports it exactly the same way.
- **whether a response head has arrived.** Before one there is nothing for a consumer to have been reading, so
  every failure the stream can carry is the request's — including the raw system errors (`ECONNREFUSED`) the
  upload path surfaces through its duplex, which are not `UndiciError`s and would otherwise stop being
  normalised. `respondedWith` already answered this for `error.response`, so it answers it here too.
- **who raised it.** After the head, undici reports its own failures as `UndiciError`s — verified against undici
  8.10.2: a truncated `content-length` with the socket cut mid-body arrives as `SocketError`/`UND_ERR_SOCKET` —
  and a deadline or a caller abort arrives through the signal. Anything else reaching a stream that has already
  delivered its head came from downstream.

*a consumer destroying a stream is not a request failure* drives the three shapes a consumer actually produces
and then asserts the truncated-body case **still** fires the hooks, so the fix cannot decay into "stop
normalising".

There is a test for each combination — pre-response and mid-body, on each path — plus one asserting `errored` and
one asserting `stream.pipeline`. The mid-body ones use the `/truncate` route, which announces a `content-length`
of 1000 and then kills the socket.

**`afterResponse` hooks do not run for streams**, and that is deliberate rather than an oversight: there is no
parsed body to hand a hook, and a streamed request cannot be replayed, so `retryWithMergedOptions` would have
nothing to re-send. got scopes `afterResponse` to its promise API for the same reason. Every other hook does fire
for streams.

**Two stream behaviours follow got's, both found by its own suite (`conformance/`).** A status `throwHttpErrors`
refuses emits the `HTTPError` and **no `response` event** (`asStream`'s `statusRefused`, and the pipeline path only
emits `response` for an accepted status); `stream.response` still resolves with the head. And an **upload's `finish`
is held until the response head arrives** (`holdFinishForHead`): undici's pipeline duplex finishes once the body is
buffered, so `pipeline(source, upload)` resolved for an upload whose connection was then refused. It is the event
that is held, not a `final` added - undici ends the request body on `prefinish`, so a `final` waiting for the head
would wait on a server waiting for the body. A decompression failure after the head (`isDecompressionError`) is
also the request's, not the consumer's: it is not an `UndiciError`, so it used to come out raw.

# Timeouts

`timeout.request` sets undici's `headersTimeout` + `bodyTimeout` **and** a deadline signal (`requestSignal`),
combined with any caller `signal` via `AbortSignal.any`.

The deadline is what actually bounds the request, and it is not optional. undici's two timeouts are per-phase and
`bodyTimeout` **restarts on every chunk received**, so a response that trickles a byte at a time never trips
either one — a request under a 1.5s timeout was measured still running at 4.9s. undici also arms them on its
coarse timer wheel (`lib/util/timers.js`, `RESOLUTION_MS = 1000`), which used to round every sub-second timeout up
to roughly a second. Both are covered by tests (`/trickle`, and a 50ms timeout asserted to fire promptly).

**The deadline bounds an attempt, not the retry sequence.** One signal is handed to undici and spans every attempt
it makes, so the deadline was a cumulative budget: measured, a `timeout: {request: 400}` with `retry: {limit: 4}`
against an upstream answering in 150ms ran all five attempts in got 16 (1045ms) and gave up after three here
(404ms) - a client configured to retry was denied most of its retries, and the README claimed got's semantics
while not having them. `requestSignal` therefore hands back a `restart` alongside `release`, and `countAttempts`
calls it on every re-dispatch, which is after undici's backoff wait and so doesn't charge the wait to the attempt.
This is also what undici's own `headersTimeout`/`bodyTimeout` already did, so all three now agree. The restart
reaches the interceptor on the `attempts` holder (`AttemptState.restartDeadline`), which only exists for a client
that retries at all.

**The deadline also has to *lose* to undici's own timeout, or a timed-out attempt is never retried at all.**
Aborting through a signal is the one failure undici will never retry: `RetryHandler.onResponseError` propagates
outright when the connection's controller was aborted (`lib/handler/retry-handler.js`), and the signal stays
aborted for every later attempt anyway. The deadline is armed before the dispatch and undici arms its own
`headersTimeout` only once the request has been *sent*, so the deadline always won that race — and so a client
configured `{retry: {limit: n}, timeout: {request: ms}}` got **one attempt**, whatever `retry.errorCodes` said.
Measured against got 16: an upstream that never answers ran four attempts there and one here. Socket resets and
retryable statuses were retried throughout, which is why this went unnoticed; the one parity scenario combining
`timeout` and `retry` used an upstream that *answers* inside the deadline, so it exercised the restart above and
never this.

So `requestSignal` **defers the abort, once, for an attempt undici could still retry** — `attempts.canRetryError`
answers that, and `retryGrace` says for how long. Everything about the design is about keeping the cost on the
failure path only:
- **Nothing about a successful request changes.** The deferral only delays the *failure* of an attempt. The
  alternative considered was moving undici's `headersTimeout`/`bodyTimeout` *inside* the deadline instead
  (`timeout - 600`), which keeps the deadline exact but cuts up to 600ms off the window a slow response has to
  arrive in — a regression on the success path, which this is not.
- **The trickling body keeps its exact bound**, because `canRetryError` requires `lastStatusCode === undefined`.
  undici propagates rather than retries once a response head has been delivered, so there is nothing to wait for
  after the head — and that is precisely the case the deadline is the *only* bound for. `countAttempts` clears
  `lastStatusCode`/`lastHeaders`/`lastError` after firing `beforeRetry` for the same reason: the status of the
  attempt being retried would otherwise answer for the attempt about to run, so a 503 followed by a hang lost its
  retry.
- **Below undici's timer floor the deadline stays exact and the attempt is not retried.** undici cannot report a
  timeout of its own before ~1s however small `headersTimeout` is — measured against undici 8.10.2, values of
  100, 300 and 900 all fired at ~1000ms (the `delay <= RESOLUTION_MS` native branch in `timers.js` is not the
  whole story), and 1200 fired at ~1500. Waiting there would fail a `timeout: {request: 100}` at 1700ms, which is
  a worse trade than the missing retry. That threshold is a documented divergence from got, whose own timers make
  a sub-second timeout retryable.
- **A caller who narrowed `errorCodes` away from timeouts gets the exact deadline back** (`retriesTimeouts`), so
  nobody pays the grace for a retry undici would refuse anyway.

Five tests pin it, all through a `/hang` route that counts requests and never answers — the count is what tells
the two timeouts apart, since only undici's is retryable.

**Pausing that deadline is a prediction, and a prediction that misses must not cost the deadline.**
`OutcomeHandler` stops the timer when `willRetryStatus` says undici is about to retry, so the backoff isn't
charged to the attempt — but that re-implements a decision undici makes privately in `retry-handler.js`, and a
false positive used to leave the request running with *no* deadline at all, silently and without end. Measured:
a `retry: {statusCodes: [202]}` against a trickling body under `timeout: {request: 400}` was still reading at 4s,
while the same request one status code away gave up at 406ms. Two things fix it, and both are wanted:
- `willRetryStatus` mirrors undici's own gate — `RetryHandler.onResponseStart` only consults the retry policy
  for a **3xx and up**, so a `retry.statusCodes` naming a 2xx (a polling client listing `202`) is never retried
  there however the prediction answers;
- **`requestSignal.resume()` is the failsafe.** It re-arms a deadline a `pause` took away and no re-dispatch came
  for, and every path calls it the instant a response reaches the caller — `call()` after `undici.request`
  resolves, `callBodylessStream` after the head arrives, `callStream` inside the pipeline handler — which is the
  point at which nothing can be retrying it any more. A no-op unless a pause is outstanding, so the ordinary
  request pays one boolean read. Any future divergence from undici's internals therefore costs a restarted clock
  rather than the whole timeout. It is unit-tested through `dispatchOptions` directly: provoking a genuine
  mispredict over the wire would mean testing undici's retry handler rather than this.

undici's own timeout errors are still mapped, since they give the more specific message when they do fire first.
The deadline reports itself as a `TimeoutError` DOMException, which lands on the same `TimeoutError`/`ETIMEDOUT`
as everything else.

**The deadline is an `AbortController` plus a cancellable timer, not `AbortSignal.timeout`.** An
`AbortSignal.timeout` cannot be cancelled, so an abandoned one is retained until it fires: a request that finished
in 5ms under a 30s timeout held its signal for the remaining 29995ms. Measured at ~885 bytes apiece, which is
~265MB of uncollectable heap at 10k requests/second — and the longer the timeout, the worse it gets.
`dispatchOptions` therefore hands back a `release` alongside the signal, and every path calls it:

- `call()` in a `finally` around the dispatch and the body read. `afterResponse` hooks run *outside* it
  deliberately — they are the caller's own code and were never covered by `timeout.request`.
- both stream paths on the stream's `close`, not when the head arrives. A trickling or truncated body is exactly
  what the deadline is there to catch, so it has to outlive the response head; `close` rather than `end` so a
  failed download releases as surely as a completed one. An unconsumed stream never closes and keeps its
  deadline, which is correct — that request is still in flight.

The timer is `unref`'d, as `AbortSignal.timeout` is, so a pending deadline never holds the process open. It aborts
with the same `TimeoutError` DOMException and the same message, so `isTimeoutReason` and anything a caller matches
on are unchanged. `process.getActiveResourcesInfo()` cannot see an unref'd timer, so the tests patch the global
`setTimeout`/`clearTimeout` and count; they assert a deadline was *armed* as well as released, so reverting to
`AbortSignal.timeout` — which arms no global timer at all — fails them rather than passing vacuously.

**`AbortSignal.any` is the other half of that, and it leaked worse than the thing above.** A caller's own `signal`
used to be combined with the deadline's through `AbortSignal.any([options.signal, controller.signal])`. That
registers the composite in the **source** signal's internal dependant-signal set, and there is no API to take it
out again — `release` could cancel the timer but had nothing to detach. So every request made with both a `signal`
and a `timeout.request` left one unreclaimable entry on the caller's signal, for as long as that signal lived:
measured at **485 bytes a request** with nothing collectable after a forced GC, and 1971 entries still on the
signal after 2000 requests. The shape that hurts is the ordinary one — a process-lifetime "abort everything on
shutdown" controller shared across every call — where it grows without bound. The forwarding is an
`addEventListener('abort', …, {once: true})` now, with the `removeEventListener` hung off `release` alongside the
`clearTimeout`, which is what undici's own `addAbortListener` does with a signal it is handed. An
*already-aborted* signal has to be carried over by hand (`controller.abort(source.reason)`), since a listener
cannot fire for something that already has; the reason travels either way, so `isTimeoutReason` and
`options.signal?.aborted` are untouched. Node does not warn about listener counts on an `AbortSignal` (verified to
200), so a shared signal under concurrency costs nothing here. *a deadline does not accumulate on a caller's own
signal* pins it by patching `AbortSignal.any` and asserting it is never reached for — weighing the heap would be
flaky — and asserts the listener is present while the request is in flight, so dropping the caller's signal
altogether cannot pass it either.

**`timeout.request` must be finite and above zero**, not merely non-negative. The validator used to accept both
excluded values and each then misbehaved silently:
- `0` made `AbortSignal.timeout(0)` fire immediately and fail *every* request, while undici reads its own
  `bodyTimeout: 0` as **disabled** — one option meaning two opposite things, and a total outage for anyone writing
  `timeout: {request: config.timeout ?? 0}`.
- `Infinity` made the then-`AbortSignal.timeout` deadline throw a `RangeError` from inside `dispatchOptions`,
  which landed in the generic catch and surfaced as an opaque `ERR_REQUEST_ERROR`. The validator is what rules
  both out now, so neither reaches the timer.

Leaving the option off is how you get no timeout.

**Every other key in `timeout` is a `ValidationError`.** got's per-phase keys (`lookup`, `connect`,
`secureConnect`, `socket`, `send`, `response`, `read`) used to pass validation — only `request` was checked — and
then did nothing, since `request` is the only one read. The aggregator writes `extend({timeout: {response: n}})`,
and `extend()` is generic, so TypeScript's excess-property check never sees the literal. Those requests fell back
to the client's `timeout.request`, or to undici's 300s default. They are in `unimplementedOptions`, so the message
says "not implemented" and points at `timeout.request` (or `connectTimeout` for the connection phases); anything
else is "Unknown option", the same as `retry` and `hooks`.

# extend()

`extend()` returns a **new** `Gotlike` built from `{...baseOptions, ...options}` with headers merged and handler
arrays concatenated. A `retry` on either side rebuilds the interceptor chain, since `retryOptions` is derived in
the constructor.

**The child shares the parent's dispatcher unless the extension names one** (`rebuildsAgent`). The constructor
re-evaluates the agent options against the *merged* options, so a client built with any one of them —
`connections`, `keepAliveTimeout`, `http2`, `dnsLookup`, … — handed every client extended from it a brand new
`undici.Agent`, and so a brand new connection pool, however unrelated the extension. Parent and child then shared
no sockets, each held a pool of its own up to `connections`, and the Agents left behind were never closed — so
deriving a client per upstream, which is the pattern the README recommends, multiplied the process's connections
silently. An explicitly passed `agent` was inherited all along, so the two ways of configuring the transport
disagreed with each other. `extend()` now decides once: an extension naming `agent` or any `agentOptions` key
gets the dispatcher its own options describe, anything else inherits `this.ownAgent`. It is passed **explicitly**
rather than left to the spread, because `baseOptions` may already carry an inherited `agent` and a later
`extend({connections: 4})` has to be able to drop it and build the one it asked for.

**"Drop it" only ever means a dispatcher this class *built*** (`explicitAgent`). One the caller handed over cannot
be rebuilt from `connections` and friends — there is no way to ask a `ProxyAgent` or an `H2CClient` for a copy of
itself with one option changed — so replacing it with a plain `undici.Agent` was not a reconfiguration, it was
throwing the transport away: `extend({agent: new EnvHttpProxyAgent()}).extend({connections: 128})` sent every
request **direct, bypassing the proxy**, with no error and nothing on the wire to say so. Both halves of that
composition are straight out of the README. The combination is a `ValidationError` now, which is the same call
this file makes everywhere an option would otherwise be quietly dropped — and here the quiet outcome is traffic
leaving by a route the caller ruled out. `explicitAgent` cannot be derived from `ownAgent`, because the inherit
branch passes the parent's dispatcher back in as `agent` whether the parent built it or was given it; the
constructor sets it optimistically and `extend()` corrects it for that one branch. Without the correction a
single `extend({headers})` off a `connections`-tuned client made every client below it look explicitly-agented,
and the refusal would have fired on the `tuned.extend({connections: 4})` the README documents as working — which
is what the depth loop in *an auto-built dispatcher stays retunable however many times it is extended* pins.

**The same refusal applies when both are named in one call** (`validateAgentChoice`). `agent` short-circuited the
check above, so `{agent: new ProxyAgent(...), connections: 128}` accepted the agent option and did nothing
whatsoever with it — the dispatcher is used exactly as it stands. One rule, two halves, and the half that stayed
quiet is the one a caller writes by accident. It lives in `validateOptions` under `atCreation`, so every
construction path gets it: `new Gotlike`, `createClient` and `extend`. The object `extend()` synthesises
legitimately carries an inherited dispatcher *alongside the inherited agent options it was built from*, and the
constructor cannot tell that from a caller naming both — so `extend()` marks it with the **`inheritedAgent`**
symbol (invisible to `for...in` and `Object.keys`, like `retryDepth`) and the constructor deletes the marker
before it can travel into `baseOptions`. `extend()`'s own `validateOptions(options, true)` on the raw extension
is what catches the real mistake.

`retry` is shallow-merged rather than replaced: `extend({retry: {limit: 5}})` used to drop the parent's
`statusCodes`/`methods` with it, silently widening what got retried. `timeout` and `searchParams` are merged for
the same reason and by the same rules the per-request merge uses (see `formOptions` above) — `mergeTimeout` rather
than `mergeRecords`, because `{request: undefined}` is a key that is *present* and a plain spread clobbers the
parent's deadline with it.

**`extend()` validates its own argument, even though the constructor validates the merged result.** Folding a bad
`timeout` or `searchParams` into a well-formed one turns a `ValidationError` into a silently wrong client:
`extend({timeout: 1000})` spread into `{}` and stopped throwing. Create-time work, so the second pass costs
nothing that matters.

**The merge helpers always allocate, whichever side has a value — and so does the constructor.** `mergeRecords`,
`concatHooks` and `mergeHooks` used to return `base` unchanged when the override was absent, which handed the child
the parent's own `context` object, `handlers` array and `hooks` object — so a write through `child.baseOptions`
mutated the parent and every other client extended from it. The mirror image lasted longer and was easier to hit:
with no `base` they returned the *override* unchanged, which is what extending a hookless client does — the
exported singleton included — so the `hooks` object and array handed to `extend()` stayed live inside the client,
and a later `hooks.beforeRequest.push(...)` added a hook to a client that was already built. `usedHooks` doesn't
copy either, so there was nothing downstream to catch it. The constructor had the same hole by a different route,
since `{...defaultOptions, ...options}` is shallow; it now runs `hooks` and `handlers` through the same two helpers.
All of this happens once per client, so copying costs nothing; this is not the hot path, and `formOptions` is what
has to stay allocation-conscious.

**`context`, `timeout` and `retry` were the last three that spread aliased**, and the first two were not inert.
`formOptions` copies `context` per request — but it copies it *from* `baseOptions`, so a key added to the caller's
own object after `createClient({context})` returned reached every later request; `timeout` is handed over by
reference outright, so a deadline could be moved out from under a client that was already built (measured: a
`{request: 5000}` mutated to `{request: 1}` afterwards started timing requests out). `retry` is snapshotted into
`retryOptions` at construction, so it only travelled through `extend()`. All three go through `mergeRecords` now,
alongside `hooks`/`handlers`/`cloneSearchParams`. Shallow, as `mergeRecords` is everywhere else — it is the
key-level writes that were reaching through.


**`defaults.options.merge()` is `extend()` applied in place** (`#mergeDefaults`). It builds the child `extend()`
would and adopts the two fields that child derived for requests - `baseOptions` and `defaultHeaders` - so the
merge rules cannot drift from `extend()`'s and nothing is added to the request path, which already reads both.
That is only correct because **every other field a constructor derives comes from an option the merge refuses**
(`unmergeableDefaults`: the client-only set, `followRedirect`, the body options, `url`, `isStream`,
`responseType`, `resolveBodyOnly`). Adding a derived field that depends on a request-level option means adopting
it in `#mergeDefaults` as well, or the merge updates `baseOptions` and silently leaves the field stale. The
dispatcher needs nothing: `extend()` hands its own on, so the child shares it. `mutableDefaults` is cleared off
`baseOptions` in the constructor - assigned `undefined`, not `delete`d, since `baseOptions` is spread per request
and a delete can drop it out of V8's fast mode - which is also what makes it not inherited, as in got 16. got
ignores a merge into an immutable client silently; here it is a `ValidationError`, pinned as a divergence.

# Performance notes

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

# Response body typing

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
`npm run typecheck`, not by `npm test`.

**`Got` is any callable client, and that takes two things.** This used to claim the generic
`<T>(url, options?)` arm was enough for `const c: Got = gotlike.extend({responseType: 'json'})` to
compile. It didn't, and nothing asserted it: `Got` was `CallableClient<ClientOptions>`, and
`ClientBody` fell back to `string` for any `O` that wasn't json or buffer - so `Got` was the type of
a *text* client, a json client's quiet `delete()` (`Response<unknown>`) was not assignable to its
`Response<string>`, and the aggregator had to type its provider fields around it. Now:

- `ClientBody` answers `string` only when `responseType` is known to be text or absent, and
  `unknown` when it could be anything - which is exactly what `ClientOptions`, and so `Got`, says.
- The *default* client needs the opposite, so it gets its own options type, `NoClientOptions`, via a
  no-argument `createClient()` overload. It is an overload rather than a default for `O` because a
  default is also what TypeScript contextually types a callback from when every property of the
  argument is context-sensitive - an empty default left `hooks`/`handlers` parameters implicitly `any`.

A bare `new Gotlike()` can't be given the same treatment - a class type parameter has one default
for inference and annotations alike - so its quiet body is `unknown`. `typeAssertions` pins all of
it, including the assignments that were never checked.


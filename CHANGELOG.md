# Changelog

All notable changes to this project are documented here. This project adheres to
[semantic versioning](https://semver.org/spec/v2.0.0.html); while the major version is `0`, a
minor bump is where breaking changes land.

## 0.8.0 - 2026-09-28

### Added

- **`https` TLS options under got's names** - `rejectUnauthorized`, `certificateAuthority`, `key`,
  `certificate`, `passphrase`, `pfx`, `checkServerIdentity`, `serverName`, `ciphers`, `minVersion`,
  and the rest of got's list. They configure the client's dispatcher, so they are create/extend only;
  `extend()` merges them one level deep. `https.alpnProtocols` is refused by name: undici negotiates
  ALPN itself.
- **`followRedirect` as a function**, asked about each redirect with its status, headers and url. A
  `false` makes the redirect the response, a success rather than an `HTTPError`, as in got. It used
  to be accepted and never called, and no redirect was followed at all.
- **`client.defaults.options` reads the client's options back** - `prefixUrl`, `headers`, `timeout`,
  ... - live, so a `merge()` shows up. It held only `merge()`, so every read was a silent
  `undefined`. Writing through it is a `ValidationError`.
- **`hooks.init`**, as got calls it: on a copy of each call's options before they are validated, and
  on `extend()`'s, so a client can accept an option of its own.
- **A `beforeRequest` hook can answer the request** by returning `{statusCode, headers, body}`; the
  body is parsed by `responseType` and the `afterResponse` hooks and `throwHttpErrors` apply.
- **`parseJson` / `stringifyJson`**, used for `json` bodies, `json` responses and `.json()`.
- **`UploadError`** (`ERR_UPLOAD`) for a `body` stream that errors while it is sent.
- **nock shim**: `allowUnmocked` (a miss on that host goes to the real server), `nock.isDone()`,
  `nock.activeMocks()`, `scope.pendingMocks()`/`activeMocks()`, `.optionally()`, `.basicAuth()`,
  `scope.matchHeader()`, which also applies to interceptors added before it, and `persist(false)`.
- **Assigning through `client.defaults.options` on a `mutableDefaults` client** -
  `client.defaults.options.headers.authorization = token`, as got allows - is a `merge()` of that
  option.

### Changed

- **`nock.pendingMocks()` returns nock's strings** (`GET http://host:80/path`) rather than undici's
  interceptor objects, and a scope's `done()` throws nock's `Mocks not yet satisfied:` message.
- `RequestOptions['followRedirect']` and `FormedOptions['followRedirect']` are `boolean | function`.
- **A scope's `isDone()`/`done()` answer for that scope**, as nock's do, rather than for every scope
  on its origin.

### Fixed

- **`nock(host).get(path).reply(200).persist()` persists the interceptor**: `persist()` on a scope
  only reached interceptors added after it, so this common spelling answered once.

## 0.7.0 - 2026-09-28

### Added

- **got's promise shortcuts**: `client.get(url).json()`, `.text()` and `.buffer()`, on every verb and
  on the callable client. `.buffer()` is byte-exact; a shortcut's result has the shortcuts too, as
  got's does. `.json()` does not add `accept: application/json` - set `responseType: 'json'` for
  that. Measured against a null dispatcher, no cost beyond noise.
- **`response.requestUrl`, `response.redirectUrls` and `response.statusMessage`**, as in got.
  `statusMessage` is node's standard phrase for the status.
- **`ReadError`** for a failure reading or decompressing the body once the head has arrived, and
  **`MaxRedirectsError`** (`Redirected 10 times. Aborting.`, `ERR_TOO_MANY_REDIRECTS`) for a redirect
  chain past the limit - which used to be an `HTTPError` for the last 3xx.
- A README list of what is not implemented, built from running got's and nock's own suites.

### Changed

- **A `url` in an options object is refused, as in got 16.** `client({url})`, `client.get({url})`,
  `client.get(url, {url})`, `client.stream({url})`, `extend({url})` and `createClient({url})` are
  all a `ValidationError` with got's message, `The \`url\` option is not supported in options
  objects. Pass it as the first argument instead.` gotlike used to accept it because got 12 and 14
  did; that made a call that works here and throws under got 16. Pass the url as the first argument.
  `retryWithMergedOptions({url})` still takes one, as got's does. `RequestOptions` (and so
  `ExtendOptions`) no longer has a `url` key; `FormedOptions`, `RequestError#options` and the retry's
  argument still do, so code reading `response.request.options.url` should type it as
  `FormedOptions`.
- **Errors use got's wording and codes where callers match on them**: `timeout.request` is
  `Timeout awaiting 'request' for 5000ms`; an abort is `This operation was aborted.`; a connection
  the server reset is `ECONNRESET` (undici's `UND_ERR_SOCKET` stays on `cause`); an unsupported
  protocol is `ERR_UNSUPPORTED_PROTOCOL` / `Unsupported protocol: ftp:`; a call with no url is
  `Missing \`url\` property`. A body-read failure is now a `ReadError` (a `RequestError` subclass).
- **A redirect loop is followed to the limit**, as got does, and ends in `MaxRedirectsError`, rather
  than undici's `Redirect loop detected` on the first repeat.
- **The nock shim reports a miss as nock does**: `Nock: No match for request ...` with
  `ERR_NOCK_NO_MATCH`, or `Nock: Disallowed net connect for "host:port/path"` with `ENETUNREACH`,
  instead of undici's `UND_MOCK_ERR_MOCK_NOT_MATCHED`. A test matching the old code needs updating.

### Fixed

Everything here was found by running got's and nock's own test suites against gotlike
(`conformance/`).

- **Post/Redirect/Get to the same url is followed.** `POST /orders` -> `303` -> `GET /orders` failed
  with undici's `Redirect loop detected`, whose loop check compares urls and ignores that the method
  changed. A same-method redirect back to itself is still refused as a loop.
- **A cross-origin redirect drops `cookie2`** as well as `authorization`, `cookie` and
  `proxy-authorization`, as got does.
- **`retryWithMergedOptions(response.request.options)` works** - the form got documents. The formed
  options carry the client's `hooks`, `retry` and `handlers`, so on any client with an
  `afterResponse` hook the retry was a `ValidationError`. The client's own values are now let through;
  a *different* `hooks` or `retry` is still refused.
- **got's `agent: {http: new Agent()}` shape is a `ValidationError`** naming the problem, instead of
  every request failing with `base.compose is not a function`.
- **A body cut off mid-way reports the reset** (`UND_ERR_SOCKET`) when retries are on, rather than
  undici's `server does not support the range header and the payload was partially consumed` from its
  attempt to resume it.
- **`nock(host).get(path).reply()` with no arguments replies with an empty 200**, as nock does. It
  reached undici with no status code and failed every request it matched.
- **`nock(host, options)` applies its options.** The second argument was dropped, so scope-level
  `reqheaders`, `badheaders` and `conditionally` were ignored and interceptors matched requests nock
  would have refused. `allowUnmocked` and `filteringScope` are accepted but still not applied (both
  fail closed).
- **A RegExp header matcher only matches a header that was sent** - `/./` matched a request without
  the header, because undici tests `'undefined'`. Array and number header values, and a `host`
  requirement on a request that set no `host`, now compare as nock compares them.
- **An object body matcher matches an urlencoded form body**, as nock parses one; only JSON was
  parsed, so `nock(host).post('/login', {user: 'a'})` never matched `form: {user: 'a'}`.
- **`reply(200, false)` sends `false`** (and a number its text); a falsy body was sent empty.
- **A stream decompression failure is a `ReadError`** with the `beforeError` hooks applied; it reached
  the caller as the raw zlib `Error`.
- **An upload that never connects fails a `pipeline()` into it.** The upload stream finished as soon
  as its body was buffered, so `await pipeline(source, client.stream.put(url))` resolved for a
  request that was refused; `finish` now waits for the response head, as got's does.
- **A stream emits no `response` event for a status `throwHttpErrors` refuses**, as in got - only
  the `HTTPError`. `stream.response` still resolves with the head.

## 0.6.0 - 2026-09-27

### Fixed

- **Any callable client is now assignable to `Got`.** `Got` was typed as a *text* client, so
  `const c: Got = gotlike.extend({responseType: 'json'})` - and the same for a `buffer` client -
  did not compile: a json client's quiet `delete()` resolves to `Response<unknown>` and `Got`'s
  claimed `Response<string>`. The docs said it worked and nothing checked it. A quiet call through a
  `Got`-typed value now reads `unknown`, since it could be any client; a type argument or a per-call
  `responseType` still settles it. The default client and `createClient()` still read `string`.

### Changed

- A bare `new Gotlike()`, with no options, types a quiet call's body as `unknown` rather than
  `string` - its type parameter is the any-client one. Pass options, or use `createClient()`, to
  keep `string`. Runtime behaviour is unchanged.

## 0.5.0 - 2026-09-27

### Added

- **`mutableDefaults` and `client.defaults.options.merge()`**, as in got - for merging a refreshed
  credential into a client from a hook. Request-level options only; merging into a client without
  `mutableDefaults`, or merging an option the client consumed when it was built (`hooks`, `retry`,
  `agent`, ...), is a `ValidationError` where got silently does nothing. Not inherited by
  `extend()`, matching got. No per-request cost: measured against a null dispatcher, 3682ns before
  and 3659ns after (median of 15 interleaved runs).

### Fixed

- **A function body matcher is handed the parsed body, as nock hands it.** undici passes a body
  matcher the body as it arrived - a `Buffer`, or nothing at all - so a predicate reading a field,
  `nock(host).post('/rpc', (body) => body.method === 'games.list')`, read `undefined` and never
  matched. Since an unmatched interceptor on a mocked origin fails closed, that surfaced as a mock
  that looked right and a request that errored. The predicate now gets the body parsed as JSON when
  it parses, and the text otherwise (`''` for no body), which is nock 14's `lib/match_body.js`.
  nock's third case - an urlencoded body parsed into an object - is not reproduced and is pinned as a
  divergence: undici gives a body matcher no headers and applies it a second time after dispatch
  returns, so the content-type cannot be read consistently for both calls.

## 0.4.0 - 2026-09-27

### Security

- **A url is sent to the host its own parser names.** For the special schemes this client sends,
  WHATWG URL treats `\` as a path separator - so `http://allowed.host\@attacker.host/p` is host
  `allowed.host` with the path `/@attacker.host/p` to `new URL`, to undici and to got. The scan
  that pulls `user:pass@` out of a url stopped only at `/`, `?` and `#`, so it ran the authority
  past the backslash, found the `@` inside it, and **rewrote the url to `http://attacker.host/p`** -
  sending the request, and an `Authorization` header minted out of the fake userinfo, to a host no
  parser had ever named. An application that allowlists `new URL(input).hostname` and then passes
  the string to the client - which is how an SSRF filter is written - saw the allowed host and
  reached the other one. Only reachable with `parseUserinfo` on, which is the default. ASCII tab,
  LF and CR are now stripped out of the extracted credentials too, as the URL parser strips them
  out of a url before parsing it. Pinned against `new URL` in the spec and against got 16 in the
  parity suite.

### Fixed

- **A `timeout.request` no longer grows the heap for every request made with a shared `signal`.**
  A caller's own `signal` was combined with the request deadline's through
  `AbortSignal.any([options.signal, controller.signal])`, which registers the composite in the
  **source** signal's internal dependant-signal set - with no API to take it back out. So every
  request made with both a `signal` and a `timeout.request` left one unreclaimable entry behind
  on the caller's signal, for as long as that signal lived: measured at **485 bytes a request**,
  uncollectable after a forced GC, and 1971 entries still attached after 2000 requests. The
  pattern it punishes is the ordinary one - a process-lifetime "abort everything on shutdown"
  controller passed to every call - where it grows without bound. The deadline now forwards the
  caller's signal through an `abort` listener that `release` removes when the request settles,
  which is what undici does with a signal it is handed. Behaviour is unchanged: the abort reason
  travels as it did, and an already-aborted signal still fails the request immediately.

- **Destroying a stream yourself is no longer reported as a failed request.** Stream failures are
  normalised by wrapping `_destroy`, which Node calls for *every* destroy - so a consumer tearing
  the stream down ran the client's `beforeError` hooks with a `RequestError` describing something
  that never happened, and rewrote `stream.errored` to match. Measured:
  `pipeline(stream, destinationThatThrows)` reported `ERR_REQUEST_ERROR: disk full`, and a plain
  `stream.destroy()` reported `ERR_ABORTED`. For anything proxying a download that is a spurious
  error on every client disconnect, and the hooks were awaited inside the destroy callback, so a
  slow one delayed the teardown of a stream the caller had already abandoned. Only the request's
  own failures are normalised now - a destroy with no error, and any error reaching a stream that
  has already delivered its head and did not come from undici or the signal, is passed through
  untouched. Truncated bodies, socket resets, timeouts, aborts and pre-response failures are
  unchanged.

- **A hook or a retry status pushed through `response.request.options` no longer reconfigures the
  client.** `usedHooks` handed back the very array on `baseOptions`, so
  `client.baseOptions.hooks.beforeRequest` *was* `client.beforeRequestHooks` - and since `hooks`
  and `retry` are aliased onto the formed options by design, the live chain was reachable from
  `response.request.options.hooks` and `error.options.hooks`. A `push` through either added a hook
  to the client permanently, and one made during the hook loop ran in the request that made it.
  `retry.statusCodes`/`retry.methods` had the same hole by the same route, shared with every
  client `extend()`ed from the same parent, so a push there widened what an already-built client
  retried. Both are snapshotted at construction now, as `retry.errorCodes` already was.

- **A timed-out request is retried, as got retries one.** With `timeout.request` set, a client
  configured `{retry: {limit: n}, timeout: {request: ms}}` - the ordinary shape for a flaky
  upstream - made exactly **one attempt** for a hung or unresponsive server, whatever
  `retry.errorCodes` said. Two things caused it, and both are fixed. undici's default
  `errorCodes` do not cover a timeout at all (got's do), so the code is now in the default list,
  and got's own spelling `ETIMEDOUT` is translated to the two codes undici actually raises rather
  than silently matching nothing. And aborting through a signal is the one failure undici will
  never retry - its `RetryHandler` propagates outright when the connection was aborted - while
  the deadline signal, armed before the dispatch, always beat undici's own `headersTimeout`,
  armed once the request has been sent; the deadline now defers its abort once, by 700ms, for an
  attempt undici could still retry. Measured against got 16: an upstream that never answers ran
  four attempts there and one here. Socket resets and retryable statuses were retried throughout,
  which is why this went unnoticed. Nothing about a request that *succeeds* changes, a trickling
  body keeps its exact deadline (undici does not retry after a response head, so there is nothing
  to wait for), and a `timeout.request` under 1s keeps its exact deadline and is still not
  retried, because undici cannot report a timeout of its own any sooner - which is now in the
  README rather than left to be discovered.

### Documented

- **An array `form` or `searchParams` value is recorded as a divergence from got.** `form:
  {a: [1, 2]}` goes out as `a=1&a=2` here and as `a=1%2C2` in got - the same
  `new URLSearchParams(form)` artefact as the `null`/`undefined` rule already recorded - which is
  a silent wire difference for an identical call, so a `form` being ported that passes an array
  is worth checking. `searchParams: {a: [1, 2]}` diverges the other way: got rejects an array
  value outright, so this is more permissive rather than different on the wire. Both are now in
  the README's table and pinned as `divergence` scenarios in the parity suite, and the property
  generators reach `number` and `boolean` values (they built strings only), which is the shape
  blind spot that hid this.

- **The options a response reports being sent with no longer alias the client's own.**
  `response.request.options` and `error.options` hand every caller the options the request was
  formed with, and on a client with no hooks and no handlers those still shared the client's
  `timeout` and `searchParams` objects - so `response.request.options.timeout.request = 1`, or any
  logging or retry wrapper that normalises what it is shown, moved that client's deadline for
  every later request it made. The copies were gated on the client having something that could
  write (a handler, a `beforeRequest`/`afterResponse`/`beforeError` hook); they are unconditional
  now, guarded only by the option being set at all. The invariant test drives every option through
  both routes - a hook's write and a write through the response - because a row driven only
  through a hook passes vacuously on the shape that was broken.
- **An agent-level option named beside an `agent` is refused rather than ignored.**
  `{agent: new ProxyAgent(...), connections: 128}` accepted `connections` and did nothing with it:
  the dispatcher is used exactly as it stands, and there is no way to ask a `ProxyAgent` for a copy
  of itself with one option changed. The mirror image - an agent option on a client that was
  already handed a dispatcher - was already a `ValidationError`, so one rule had two halves and the
  quiet half is the one written by accident. Now a `ValidationError` on every construction path
  (`new Gotlike`, `createClient`, `extend`). Inheriting a dispatcher, retuning an auto-built one,
  and replacing one outright are unaffected.
- **Empty credentials send no `authorization` header.** `{username: ''}`, `{username: '',
  password: ''}` and `http://@host/` each sent `Authorization: Basic Og==` - an anonymous
  credential an upstream is free to reject or log - where got sends nothing at all, because node's
  `urlToHttpOptions` derives `auth` only from a non-empty username or password. A
  `{username: config.user ?? ''}` that meant "no credentials" now means it. The userinfo still
  comes off the url either way, and a password with no username still authenticates.
- **Clients no longer share one `headers` object.** Every client built without headers of its own
  took `defaultOptions.headers` by reference - one module-level `{}` for the whole process - so a
  write through `client.baseOptions.headers` would have shown up on every client created
  afterwards. A caller's own object is copied too, as `context`/`timeout`/`retry` already were,
  since `extend()` reads it back.
- **An empty response body is no longer a parse failure under `responseType: 'json'`.** Parsing was
  short-circuited only for the statuses that *cannot* carry a body - 204, 205, 304 and HEAD - so
  every other zero-length body fell into `JSON.parse('')` and came back out as a `ParseError`. All
  of these are ordinary responses, and a json-typed client rejected all of them: a `201 Created`
  with nothing in it, a `200` with `content-length: 0`, a `3xx` read with `followRedirect` off.
  Measured against got 16, which resolves each with `body: ''` - its `parseBody` tests
  `rawBody.length === 0` before it ever reaches the JSON codec. The bodyless statuses keep their
  `undefined`, which remains a recorded divergence. A body that is non-empty and unparseable is
  still a `ParseError`, and on an error status the status still wins.
- **`extend()` no longer discards a dispatcher you passed it.** An extension naming any agent-level
  option (`connections`, `keepAliveTimeout`, `http2`, `pipelining`, `dnsLookup`, `connectTimeout`)
  replaced the parent's `agent` with a freshly built `undici.Agent` - so
  `extend({agent: new EnvHttpProxyAgent()}).extend({connections: 128})` sent every request
  **direct, bypassing the proxy**, with no error and nothing on the wire to say so. Both halves of
  that composition are documented in the README. A caller-supplied dispatcher cannot be rebuilt
  from those options (there is no way to ask a `ProxyAgent` or an `H2CClient` for a copy of itself
  with one option changed), so the combination is now a `ValidationError` telling you to pass a new
  `agent` instead. Inheriting, retuning an auto-built dispatcher, and replacing one outright all
  behave as before.
- **`searchParams: {a: null}` is sent as `?a=` rather than dropped.** `null` and `undefined` were
  treated as one value and both discarded, which lost a parameter off the wire: got sends
  `?a=&b=1` for `{a: null, b: 1}` where this sent `?b=1`. Silent, and a real semantic change for
  an upstream that tells "absent" from "present and empty" - a filter being cleared, a tri-state
  flag, anything signing over the canonical query. got's rule is now implemented: `null` appends an
  empty value, `undefined` is skipped, per item inside an array too. `form` gets the same rule,
  which is a deliberate divergence from got there (it serialises a form with
  `new URLSearchParams(form)`, sending the literal text `a=null` and `b=undefined`) and is recorded
  in the README's divergence table and pinned in the parity suite.
- **An empty `url` under a `prefixUrl` keeps the prefix's trailing slash.** got normalises
  `prefixUrl` to end in `/` and resolves `''` against it, so `client.get('')` requests `/api/`;
  this handed back the prefix verbatim and requested `/api`, which a server is free to answer with
  a 301 - not followed by default here, so it surfaces as the redirect itself - or a 404. Only
  differed for a `prefixUrl` written without a trailing slash, which is the form the README's own
  examples use.
- **A hook or handler writing through `options.searchParams`, `options.timeout` or
  `options.handlers` no longer reaches the client, or the caller's own options object.**
  `formOptions` allocates `headers` and `context` per request for exactly this reason; these three
  were handed over by reference whenever a single side carried them, so the write landed on the
  object the client keeps. Measured: a `beforeRequest` hook adding one query parameter put it on
  **every later request the client made**, and `options.timeout.request = 5` for one request moved
  the client's deadline permanently, so everything it sent afterwards timed out. When the option
  came from the call rather than the client, the same write mutated the caller's own literal, which
  accumulates across calls that reuse it. Guarded by one boolean, so a client with neither handlers
  nor hooks - which has nothing that could write - allocates nothing extra.
- **A stream emits `response` before any of the body reaches the caller**, which is got's ordering
  and what the got-shaped proxy depends on: `stream.on('response', copyHead); stream.pipe(res)`.
  The emit was deferred to a `setImmediate` so that a caller could attach a listener after
  `await stream(...)` at all, but attaching a `data` listener - which `pipe()`, `on('data')` and
  `for await` all do, in the same synchronous block - starts the body flowing on a
  `process.nextTick`, which runs first. Measured against got 16 on the same server: `data` then
  `response` here against `response` then `data` there, so a status and headers copied onto an
  outgoing response landed *after* body bytes had already been written to it. The head is now
  announced from a `newListener` hook, which fires before the listener is registered and before the
  flow starts. Only the bodyless path was affected; the upload path already emitted in order.
- **An `afterResponse` retry ignores an option the hook names as `undefined`**, as every other
  route into a request already did. The retry merged with a plain spread, and a key that is
  *present* with the value `undefined` wins a spread - which is the shape a refresh hook writes
  constantly, forwarding `{headers, method: req.method, throwHttpErrors: cfg.throwHttpErrors}` from
  somewhere any of those can be absent. `retryWithMergedOptions({method: undefined})` replayed a
  POST as a **GET**, `{throwHttpErrors: undefined}` resolved the 401 that triggered the retry as a
  success, `{responseType: undefined}` handed back a `Buffer` instead of parsed json, and
  `{url: undefined}` failed the dispatch outright. got skips `undefined` when it merges, and so did
  `formOptions` here; the retry path is the one route that bypasses it and had not been given the
  same rule.
- **A stream failure carries `error.response` when a response had arrived.** Both stream paths
  reported `error.response` as `undefined` for a failure that happened *after* the head - a
  truncated download, a socket reset mid-body - where the identical failure on the promise API
  carried the status, headers and `request.options`. The documented contract is that `response` is
  absent only when the request failed before a response arrived, and the promise API always
  honoured it.
- **`retryWithMergedOptions({followRedirect: true})` is a `ValidationError`**, as the same option
  on an ordinary call has always been. The retry path carried its own copy of the per-request
  checks and this one was missing from it, so a hook asking for redirects was silently ignored.
  Both routes now share one `validateRequest`.
- **A throwing `beforeRequest` hook leaves the options uninstrumented.** The write-tracking `Proxy`
  on `options.headers` and the accessor on `options.body` were only taken back off when the hook
  loop *finished*, so a hook that threw left both in place on the options handed to the
  `beforeError` hooks and out on `error.options`.
- **`extend()` shares the parent's dispatcher** unless the extension names `agent` or an
  agent-level option. A client built with any of `connections`, `keepAliveTimeout`,
  `keepAliveMaxTimeout`, `connectTimeout`, `pipelining`, `http2` or `dnsLookup` handed every client
  extended from it a brand new `undici.Agent` - for a change of headers, of `prefixUrl`, of
  anything. Parent and child shared no sockets, each held a pool of its own up to `connections`,
  and the Agents left behind were never closed, so deriving a client per upstream multiplied the
  process's connections silently. An explicitly passed `agent` was inherited all along, so the two
  ways of configuring the transport disagreed with each other.
- **`delete options.body` in a `beforeRequest` hook removes the body.** The write-tracking accessor
  went with the deleted property, so nothing recorded the hook's intent and the body it had just
  removed was put back and sent. Only on a client that *has* `beforeRequest` hooks - one without
  them never installs the accessor - so the identical hook sent a body on one client and not on
  another. `options.body = undefined` was always correct and is unchanged.
- **A `searchParams` or `form` value that cannot be serialised is a `ValidationError`**, not a
  `RequestError`. Option *values* are checked when the query is built, inside the pre-request work,
  and the wrapper there flattened the class - so `searchParams: {a: {}}` reported itself as a
  transport failure and ran the `beforeError` hooks, where the identical mistake one option along
  threw. Such a value is now also rejected at create/extend, rather than constructing a client
  whose every request fails.
- **`context`, `timeout` and `retry` passed to a client are copied**, like `hooks`, `handlers` and
  `searchParams` already were. Mutating the object you passed to `createClient()` afterwards
  reached every later request the client made - for `timeout` that meant a deadline could be moved
  out from under a client that was already built.

## 0.3.0 - 2026-09-13

`0.2.0` was published in June 2024 and was ~470 lines. This release is effectively a rewrite: the
client it replaces got most of got's *shape* right and most of its *behaviour* wrong. Read the
breaking list before upgrading - several of these were silent in `0.2.0` and are loud now.

Every "matches got" claim below is enforced by a differential test suite that runs the same
scenario through real got 16 and through gotlike and compares both the caller-visible result and
what reached the server (`npm run parity`). The mocking shim is compared against real nock 14 the
same way.

### Breaking

- **`followRedirect` now defaults to `false`**, and can only be set on create/extend - a
  per-request `true` is a `ValidationError`. undici allocates a redirect handler on every request
  once its interceptor is composed, which measured at ~80% of this client's entire per-request
  overhead. Opt in with `gotlike.extend({followRedirect: true})`.
- **Hooks are arrays, and are read from the client's options only.** `0.2.0` took a single function
  per hook and a `hooks` object passed to an individual call. Both are gone; the shape is got's.
- **`afterResponse` hooks take `(response, retryWithMergedOptions)`**, not `(response, options)`,
  and may retry the request the way got's do.
- **`HTTPError.code` is now got's `ERR_NON_2XX_3XX_RESPONSE`**, not `ERR_HTTP_ERROR`.
- **`HTTPError.message` names the request**: `Request failed with status code 403 (Forbidden): GET
  http://host/path`. The query string is deliberately cut off, unlike got's - a query carries api
  keys, signatures and session tokens, and got's message puts them in every log line and APM group
  that prints the error. `error.response.request.options.url` still holds the full url.
- **Every other error carries the underlying `code` and message.** A connection refused now reports
  `ECONNREFUSED` with node's own message; `0.2.0` flattened everything to `ERR_REQUEST_ERROR` and
  the literal string `'Request error'`, which made a DNS failure, a refused socket and a malformed
  url indistinguishable to anything matching on `code` or grouping on `message`.
- **Options are validated.** An unknown or malformed option throws a `ValidationError`
  (`code: 'ERR_INVALID_OPTION'`) instead of being ignored. `validate: false` on create/extend turns
  the check off. In particular `timeout: {request: 0}`, `Infinity` and `NaN` are now rejected -
  `0` used to mean "time out immediately" to the deadline and "no timeout at all" to undici.
- **`prefixUrl` carrying a `?` or `#` is a `ValidationError`**, rather than being concatenated into
  the middle of the url.
- **`retry.limit` defaults to 2** (got's default; undici's is 5), and **`Retry-After` is honoured by
  default**. `0.2.0` derived that from `!!maxRetryAfter`, so a caller who never set that option had
  the upstream's explicit backoff silently ignored.
- **An `accept: application/json` request header is sent for `responseType: 'json'`**, as got sends
  one. A content-negotiating upstream can answer differently than it did before.
- **Requires node >= 22.12 and undici 8.**

### Divergences from current got worth knowing

Neither of these is new here; both are got moving and gotlike deliberately not following. They are
pinned in the parity suite and listed in the README's divergence tables.

- `responseType: 'buffer'` returns a **`Buffer`**; got 15 moved to a plain `Uint8Array`. `Buffer` is
  a subclass, so it satisfies anything typed for one, and callers feeding `sharp()` need it.
- A `300 Multiple Choices` carrying a `Location` is **followed** when `followRedirect` is on,
  because undici's redirect interceptor treats 300 as redirectable; got 15 stopped following it.

### Added

- **Credentials do not cross an origin.** A `beforeRequest` hook or an `afterResponse` retry that
  moves the request to a different origin loses `authorization`, `cookie`, `cookie2`, `host` and
  `proxy-authorization`, url credentials, and an unchanged body. A hook is where a url arrives from
  somewhere else, and every one of those used to take the caller's token and payload to whatever
  host the hook named. Anything the hook sets itself is kept. Matches got 16, which fixed the same
  thing; undici already did it for redirects it follows.
- **A `FormData` body is encoded as multipart.** got 15 made the `FormData` global the documented
  multipart path and undici's `request()` cannot take one - it does not reject it either, the
  request simply never leaves - so this used to hang. The encoding is byte-identical to got's,
  boundary aside, and hooks still see the `FormData` before it is encoded.
- `head()` and `query()` verbs; got's `stream.get`/`.post`/… helpers on the stream client.
- The callable client - `gotlike(url, options)` and `gotlike({url, ...})`.
- `searchParams` (merged with the client's, by got's rules), `form` bodies, and Basic auth from
  `username`/`password` or from credentials in the url.
- `context`, and the `beforeRetry`, `beforeRedirect` and `beforeError` hooks.
- Two stream paths instead of one - a `Readable` for a bodyless request, a `Duplex` whose writable
  half is the request body otherwise - with the response head as both an event and a promise, and
  every failure normalised into a `RequestError` with the `beforeError` hooks run. `0.2.0` sent
  everything through `undici.pipeline`, which cannot replay a body across a redirect.
- `response.ok`, `response.rawBody` (the bytes as received, not a re-serialisation), `retryCount`,
  `timings`, and the final url on `response.url` after a redirect chain.
- Decompression including `zstd`, advertised from what the running node can actually decode; DNS
  caching, response caching and request deduplication, HTTP/2 over TLS, pipelining and pool tuning.
- Response body typing through overloads and through the client's own `responseType`, so
  `extend({responseType: 'json'}).get(url)` types as the parsed body rather than a string.
- A far larger nock shim: object/array/RegExp/function body and query matchers, `.query(true)` and
  `.query(fn)`, `once`/`twice`/`thrice`/`times`, `delay`, `persist`, `done`/`isDone` per scope,
  `enableNetConnect`/`disableNetConnect`, and a `restore()` that puts back the dispatcher that was
  global before the import.
- Test infrastructure that is the point of this release as much as the code: the got and nock
  parity suites, property-based differential tests over generated urls, queries, headers and
  bodies, and a coverage gate (`npm run check`) that fails below 99.8% lines / 96% branches.

### Fixed

Selected - these are the ones that were silently wrong rather than merely missing:

- Per-call headers are folded to lower case at every merge point, so a per-call `Authorization` now
  replaces an instance `authorization` instead of both going out.
- A per-call `searchParams` merges with the client's instead of replacing it, so a client-level api
  key or tenant id no longer vanishes the moment a call names a parameter of its own.
- A per-call `timeout` naming no `request` no longer drops the client's deadline and leaves the
  request unbounded.
- `timeout.request` bounds each *attempt*, as got's does, rather than being a budget for the whole
  retry sequence - and it is enforced by a cancellable deadline, so a response trickling one byte at
  a time can no longer outlive it.
- `json`/`body`/`form` set on a client no longer go out on every request, GETs included.
- `prefixUrl` joining: the fragment comes off before the query is located (`searchParams` used to be
  appended *inside* a fragment and never reach the server), and every leading slash is stripped.
- A url that a `beforeRequest` hook rewrote is now the url that is dispatched.
- A parse failure on an error status runs the `afterResponse` hooks and throws `HTTPError` instead
  of failing to parse first, so a token-refresh hook sees the 401 that triggers it.
- A retry from an `afterResponse` hook re-runs only the hooks before the one that retried, drops a
  stale `authorization`, `content-type` and `content-length` when it replaces the body, and is
  bounded.
- Streams: a piped GET no longer silently returns the 302 itself; a bodyless method other than
  GET/HEAD no longer hangs forever; a failure before any response now reaches an `error` listener
  instead of leaving the caller waiting; and a failed upload fails the write rather than resolving.
- Redirects: the final url is reported, `beforeRedirect` sees a real header object (multi-valued
  headers included), and a retry starts the redirect chain over instead of inheriting the previous
  attempt's hop count.
- nock shim: object and array body matchers work at all (they used to fall through to the real
  network), a regex origin is keyed by pattern so two scopes written with it share one pool,
  `cleanAll()` empties the derived pools, query matching handles RegExp, predicate and array values,
  and an object reply body is labelled `application/json` as nock labels it.

## 0.2.0 - 2024-06-23

Initial published release: retries, a custom agent, JSON parsed outside undici, and the first
version of the nock shim.

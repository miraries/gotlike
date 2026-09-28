# Gotlike

A [got](https://github.com/sindresorhus/got)-shaped HTTP client for node.js, built on
[undici](https://github.com/nodejs/undici). Includes a [nock](https://github.com/nock/nock)-like mocking layer, since nock doesn't
intercept undici.

ESM, node >= 22.12. CommonJS projects can still `require('gotlike')`.

## Usage

```ts
import { Gotlike } from 'gotlike'

// these work as well
// const {gotlike} = require('gotlike')
// const {got} = require('gotlike')
// import got from 'gotlike'
// import {gotlike} from 'gotlike'
// import type {Got} from 'gotlike' // the client's type

const gotlike = new Gotlike({ // or gotlike.extend({ ... })
  prefixUrl: 'https://example.com/api/v1',
  headers: {
    'authorization': 'Bearer test',
  },
  responseType: 'json',
})

const response = await gotlike.get('/test')

console.log(response.body)
```

The client is also callable, like got's export:

```ts
const response = await gotlike('/test', { responseType: 'json' })

// `new Gotlike(...)` gives the plain, non-callable class;
// `createClient(...)` gives the callable form.
```

## Motivation

got has the API worth keeping (extendable clients, handlers, hooks, sane errors), but it sits on
node's `http` module and costs about three times as much per request as undici does. undici is the
fast path, but its API is deliberately low-level: no client extension, no option merging, no hooks,
errors that arrive as raw dispatch failures.

Swapping one for the other in a codebase with hundreds of call sites means rewriting all of them,
and replacing nock as well, because nock doesn't intercept undici at all.

So gotlike puts got's shape on top of undici, and nock's shape on the tests. The aim is that moving a
codebase over is an import change rather than a rewrite, and that the result is roughly **3x got**
on throughput while staying close to raw undici (see [Benchmark](#benchmark)).

It is not a got clone. Features are added when they're needed, and got's design is followed only
where it doesn't cost anything at runtime (see [Differences](#differences-from-got)).

> **Redirects are not followed by default**, unlike got. undici allocates a redirect handler on
> every request once its interceptor is in play, which measured at ~80% of this client's entire
> per-request overhead, so it is opt-in: `gotlike.extend({ followRedirect: true })`.
>
> **Retries are off by default** too, for the same reason: a client without a `retry` object makes
> one attempt where got makes up to three. `gotlike.extend({ retry: {} })` turns them on with got's
> limit of two retries, and undici's retried status codes and methods (see the `retry` row below).

Supports:
- [x] Extendable client
- [x] Handlers
- [x] Hooks: `init`, `beforeRequest`, `afterResponse`, `beforeError`, `beforeRetry`, `beforeRedirect` *(arrays, client-level only)*; a `beforeRequest` hook may answer the request by returning a response
- [x] `afterResponse` retries via `retryWithMergedOptions`
- [x] `context`
- [x] `mutableDefaults` and `client.defaults.options.merge(...)`, for request-level options; `client.defaults.options` reads the client's options back *(read-only)*
- [x] Retries *(partial and opt-in with a `retry` object; maps onto undici's `retry` interceptor and honours `Retry-After`)*
- [x] `searchParams`, `form`
- [x] Decompression: gzip, deflate, br, zstd, compress
- [x] Basic auth: `username` / `password`, or credentials in the url (`https://user:pass@host`)
- [x] `response.ok` / `rawBody` / `retryCount` / `requestUrl` / `redirectUrls` / `statusMessage`
- [x] got's promise shortcuts: `client.get(url).json()`, `.text()`, `.buffer()`
- [x] Named error classes: `HTTPError`, `TimeoutError`, `ParseError`, `ReadError`, `UploadError`, `MaxRedirectsError`, `AbortError`
- [x] TLS options under got's names: `https: {rejectUnauthorized, certificateAuthority, key, certificate, ...}` *(create/extend only)*
- [x] `followRedirect` as a function, `parseJson` / `stringifyJson`
- [x] Streams *(with response head + timings; no progress events)*
- [x] Timings *(only total request)*
- [x] Parsed response body and timings on errors
- [x] Nock-like mocking
- [x] DNS cache
- [x] Connection pool tuning
- [x] Response caching and request deduplication
- [x] HTTP2 *(over TLS; cleartext h2c needs an `agent`)*
- [x] Pipelining
- [x] Options validation
- [x] Callable client: `gotlike(url, options)`, and `gotlike(options)` with the url from `prefixUrl`
- [x] An options object in place of the url on every verb, as got takes it: `client.post({ json })`, `client.stream.post({ body })`

## Differences from got

### Chosen for speed

| | got | gotlike |
| --- | --- | --- |
| `hooks`, `handlers`, `retry`, `agent`, `https`, `http2`, `pipelining`, `dnsCache`, `dnsLookup`, `decompress` | per request or per client | **create/extend only**; passing them per request is a `ValidationError` |
| option merging | per-option merge table, every request | **one shallow spread**; `headers`, `context`, `searchParams` and `timeout` merge one level deep, everything else is replaced |
| `response.rawBody` | always materialised | **computed on first access**. It holds the bytes as received, so a `json` response still hands back the original text. On a `text`/`json` response it is a UTF-8 encoding of the decoded body, which is byte-exact for the UTF-8 that JSON and `charset=utf-8` guarantee; a response in some *other* charset is already mojibake by then, so read it with `responseType: 'buffer'` if the exact bytes matter |
| a UTF-8 BOM on a `text`/`json` response | kept, so `body` starts with U+FEFF, `rawBody` starts `ef bb bf`, and a BOM-prefixed JSON body is a `ParseError` | **stripped**, because undici's `text()` drops it. `body` and `rawBody` both lack it, and a BOM-prefixed JSON body *parses*. Use `responseType: 'buffer'` if the BOM matters |
| `options.url` | normalised to a `URL` | a `URL` too, **except a url `new URL` rejects, which stays a string**, and the request then fails with `ERR_INVALID_URL` as usual. The `URL` is resolved against `prefixUrl` and `searchParams` before handlers and hooks see it: `.href`, `.pathname` and an in-place `options.url.searchParams.set(...)` all work, and `String(options.url)` is exactly what goes on the wire (`/a b/ü` → `/a%20b/%C3%BC`). A hook may also assign a string or a new `URL` |
| `options.url` after a redirect | rewritten to the redirect target | **stays the url that was requested**, so a retry from a hook goes back through the redirect. `response.url` is the final url, as in got |
| `options.context` | fresh `{}` per request | a **shared frozen** `{}` when unset, so reads are safe and writes throw rather than leak. Pass a `context` to get a writable one |
| `validate` | n/a | client-only, like the options above. It is read from the instance, so a per-request value would do nothing |
| `mutableDefaults` / `defaults.options.merge()` | merges any option; on a client without `mutableDefaults` the merge **silently does nothing** | only what a request merges can be merged. `hooks`, `handlers`, `retry`, `agent` and the other create/extend-only options, a body, a `url`, `responseType` and `resolveBodyOnly` are a `ValidationError`, since the client consumed them when it was built. On a client without `mutableDefaults` the merge is a `ValidationError` too. Not inherited by `extend()`, as in got |
| `parseUserinfo` | n/a | client-only, same reasoning as `validate`. Turns `user:pass@host` in a url into a Basic-auth header, and is on by default. Turn it off if no url you pass ever carries credentials, to skip the scan (~300-400ns/request, measured) |
| `followRedirect` | `true` | **`false`**, because redirects cost ~2µs/request to support whether or not one happens. Enable per client with `extend({ followRedirect: true })`, or with a function asked about each redirect (`false` makes the redirect the response, a success as in got; it is handed the redirect's `statusCode`, `statusMessage`, `headers` and `url`, not got's full response). A per-request `true` or function is a `ValidationError` on a client that does not follow redirects, since composing the interceptor is a create/extend-time decision; on one that does, either narrows it |
| `maxRedirects` | configurable | **fixed at 10**, got's own default. A chain longer than that is a `MaxRedirectsError` carrying the 3xx, as it is in got, not a success whose body is the redirect page |
| `stream()` for a bodyless request | always a `Duplex` | a **`Readable`**, since nothing can be written to a GET and the duplex wrapper cost ~10% of stream throughput |
| `prefixUrl` with an absolute `url` | throws | the **absolute url wins**, silently. `prefixUrl` therefore does *not* pin the host: if `url` can be influenced from outside, validate it yourself |
| `prefixUrl` with a query or fragment | allowed | a **`ValidationError`**. The prefix is concatenated with `url`, so a `?` on it would land mid-url. Use `searchParams` |
| `prefixUrl` with a leading slash on `url` | throws (`` `url` must not start with a slash ``) | **accepted**. Every leading slash is stripped and the path is joined, so `'/items'` and `'items'` do the same thing. More permissive than got on purpose, so a caller who meant an absolute path gets a silently different request where got would have stopped them |
| `responseType: 'buffer'` | a `Uint8Array` since got 15 | a real **`Buffer`**. `Buffer` extends `Uint8Array`, so it satisfies anything typed for one, and callers feeding `sharp()` and friends need the subclass. `response.rawBody` likewise |
| `timeout: { request: 0 }` | immediate timeout | a **`ValidationError`**, along with `Infinity` and `NaN`. undici reads its own `bodyTimeout: 0` as *disabled*, so 0 meant two opposite things at once. Leave the option off for no timeout |
| `timeout.lookup`, `.connect`, `.secureConnect`, `.socket`, `.send`, `.response`, `.read` | per-phase bounds | a **`ValidationError`** naming the option. Only `timeout.request` is implemented, and it bounds every phase; accepting the others meant a `timeout: {response: 10000}` that silently bounded nothing. Use `timeout.request`, or the client-level `connectTimeout` for the connection phase |
| `retry.calculateDelay`, `retry.noise`, `https.alpnProtocols` | accepted | a **`ValidationError`** naming the option, as "not implemented" rather than "unknown". Ignoring them would mean a backoff tuning that silently never applies, which is the failure the unknown-key check exists to stop. Drop them, or cap the backoff with `retry.backoffLimit`; undici negotiates ALPN itself, so use `http2: true` to offer h2 |
| `https` | per request or per client | **create/extend only**, like the agent options: it configures the client's dispatcher. `extend()` merges it one level deep, as got does |
| an unknown key in `retry` or `hooks` | accepted and ignored | a **`ValidationError`**. `retry: { limt: 0 }` used to leave the `retry` object's default of two retries in place, and a misspelled hook name simply never fired |
| an agent-level option alongside an explicit `agent`, or on a client built with one | n/a (got's `agent` is per-protocol) | a **`ValidationError`** either way round. A `ProxyAgent` or `H2CClient` cannot be rebuilt from `connections`, so the option can only be silently ignored (named beside the agent) or silently replace your dispatcher with a plain `undici.Agent` (named on a client that already has one). For a proxy agent, the second means every request going direct. Pass a new `agent` configured the way you want instead |
| `form: { a: null }`, `form: { a: undefined }` | `a=null`, `a=undefined`, because got serialises `form` with `new URLSearchParams(form)`, which stringifies both | `a=` and **dropped**, the same rule `searchParams` uses. got's is a serialisation artefact rather than an intent. It is not what got itself does with those values in `searchParams`, and no server wants the four characters `null` in a form field |
| `form: { a: [1, 2] }` | `a=1%2C2`, the same `new URLSearchParams(form)` artefact | `a=1&a=2`, **repeating the key**, which is how a multi-valued form field is actually carried. A silent wire difference for an identical call, so check any `form` you are porting that passes an array |
| `searchParams: { a: [1, 2] }` | **rejected**, since got's `searchParams` takes one string, number, boolean or `null` per key and validates the value | `a=1&a=2`, repeating the key. More permissive rather than different on the wire, so nothing breaks moving *to* gotlike, but code moving back to got will |

### Forced by undici

| | behaviour |
| --- | --- |
| `timeout.request` | a cap on a whole **attempt**, as got's is. It covers every phase, and it starts over for each retry rather than being a budget for the sequence. undici's own `headersTimeout`/`bodyTimeout` are per-phase and `bodyTimeout` restarts on every chunk, so a slowly trickling response would never trip them; a deadline signal enforces the total on top. That also sidesteps undici's coarse 1s timer wheel, so sub-second timeouts fire on time. See the retry rows below for the one case where the deadline waits before it fires |
| `retry` | **off unless the client is given a `retry` object**. got retries twice by default; here a client without one makes exactly one attempt, and `retry: {}` turns retries on. The interceptor costs per request whether or not a retry happens, the same trade as `followRedirect`. Maps onto undici's `retry` interceptor. Within a `retry` object `limit` defaults to got's 2, and `Retry-After` is honoured, but `calculateDelay`/`noise` are not implemented (and are *rejected* rather than ignored; see the table above) and `maxRetryAfter` degrades to "honour the header or don't". The retried **status codes and methods are undici's defaults**, not got's, so set `statusCodes`/`methods` explicitly if that matters. `errorCodes` defaults to undici's list *plus* the two codes it raises for a timeout, since got retries a timeout by default; got's own spelling, `ETIMEDOUT`, is accepted in the list and translated |
| a timed-out attempt | **retried**, as got retries one, but only for a `timeout.request` of **1s or more**. undici cannot report a timeout of its own any sooner than that (`RESOLUTION_MS` in its timer wheel), and a timeout the *deadline signal* reports is one undici will never retry, because an aborted dispatch is the one failure its `RetryHandler` propagates outright. So above 1s the deadline waits up to 700ms past `timeout.request` for undici's own, retryable, timeout to fire, and below it the deadline stays exact and the attempt is not retried: failing at 1.7s for a caller who asked for 100ms is the worse of the two trades. Only the *failure* of an attempt is ever delayed, never a request that succeeds, and the waiting stops as soon as a response head has arrived, so a trickling body keeps its exact bound |
| `beforeRedirect`, `beforeRetry` | **cannot delay or cancel**. undici decides both inside a synchronous dispatch interceptor, so a returned promise is not awaited |
| `300 Multiple Choices` | **followed** when `followRedirect` is on, because undici's redirect interceptor counts 300 as redirectable. got 15 stopped following it (RFC 9110 only says a user agent MAY) and hands the 300 back instead. 304 is not followed by either |
| streamed request bodies | **not replayed across a 307/308**, which must preserve method and body. 301/302/303 are fine (they rewrite to GET and drop the body); non-streamed bodies replay normally |

### Smaller surface

`stream()` resolves to the stream rather than returning it synchronously, so async `beforeRequest`
hooks can be awaited. An absolute `url` overrides `prefixUrl` instead of being rejected outright.

**Not implemented.** Every one of these is either a `ValidationError` naming the option (so a
migration finds it at the first request) or listed here because it fails some other way. The list
comes from running got's own test suite against gotlike (see `conformance/`), not from memory:

- **`cookieJar`**, **`pagination`** / `got.paginate`, a custom **`request`** function,
  **`allowAbsoluteUrls`**, **`encoding`**, **`methodRewriting`**,
  **`allowGetBody`** (a GET with a body is sent as it is, not refused), **`copyPipedHeaders`**,
  **`strictContentLength`**, **`preserveHooks`**, and the socket options **`dnsLookupIpVersion`**,
  **`family`**, **`localAddress`**, **`createConnection`**, **`setHost`**, **`maxHeaderSize`**,
  **`h2session`** and **`enableUnixSockets`** (unix socket urls).
- **`hooks.beforeCache`**, **`retry.calculateDelay`**, **`retry.noise`**,
  **`retry.enforceRetryRules`**, per-phase timeouts, and `https.alpnProtocols`.
- **Events** on the request promise and on streams - `request`, `redirect`, `retry`,
  `uploadProgress`, `downloadProgress` - and a stream's `retryCount`, `createRetryStream`, `socket` and
  `isReadonly`. A stream emits `response` only.
- **Header copying across a pipe**: an `IncomingMessage` piped in does not lend its headers, and a
  `ServerResponse` piped to does not get the status and headers.
- **Writing through `client.defaults.options`**: it reads the client's options back, but a write is a
  `ValidationError` - use `merge()`. It reports options as they were given (`dnsCache: false` stays
  `false`) where got normalises some. `extend()` takes one options object, not several, and not
  another client to merge; got's `Options` class and `got.mergeOptions` do not exist.
- **`CacheError`**, and an error's `request` (got's request stream).
- **On the response**: `ip`, `isFromCache`, `rawHeaders`, and any timing but `timings.phases.total`.
  `statusMessage` is node's standard phrase for the status, not a server's own non-standard one, and
  `HTTPError`'s message uses the same.
- **In hooks**: a `beforeRequest` hook runs once per request rather than once per redirect hop, and
  gets no `{retryCount}` second argument. Returning a response (`{statusCode, headers, body}`) answers
  a promise call, but not a stream one, which is a `RequestError`. An `init` hook's second argument is
  the same object as its first, where got hands over its `Options` instance; writes to its `context`
  and `headers` are merged over the client's as the call's own would be. `init` runs on each call
  made with an options object - including an empty one, where got skips it - and on `extend()`, but
  not on a `retryWithMergedOptions` retry.
  `beforeRedirect` is handed undici's per-hop options (`RedirectRequest`: no `body`/`json`/`form`,
  and changing the url does not re-target the hop). `beforeRetry` runs inside undici's retry
  interceptor, so its changes to `error.options` do not reach the retried request, and it is not
  called for a `retryWithMergedOptions` retry. A relative string `url` handed to
  `retryWithMergedOptions` resolves against `prefixUrl`, not against the url of the current request.
- **`.json()`** does not add `accept: application/json` the way got's does - the request is already
  on its way. Set `responseType: 'json'` for that. **`.buffer()`** is byte-exact only when called
  before the body is read, as it always is when written `client.get(url).buffer()`.

**Smaller differences** got's suite also turned up, none of which a caller is likely to depend on:
an invalid url's error carries no `input`, and an empty url is reported as missing rather than
invalid; `https:host` (no `//`) is accepted and read by WHATWG rules; `prefixUrl` must be a string,
not a `URL`, and a hook sees it as given rather than normalised to end in `/`; a non-enumerable
option (`context` defined with `Object.defineProperty`) is dropped, since options are copied with a
spread; a hook array holding something other than a function fails when it is called, not when the
client is built; `ValidationError` carries no `options`; `HTTPError#response` is enumerable; an
`authorization` or `proxy-authorization` header given as a multi-value array, an array `form` and a
`null` header value are all accepted rather than refused; `response.request.options` omits a
`username`/`password` the caller never set rather than reporting `''`; after a redirect,
`HTTPError`'s message names the url requested rather than the last one; a stream's response head
has no `requestUrl`; a `TimeoutError` with no response has no `timings`; an `AbortSignal.timeout()`
firing is `ETIMEDOUT` where got passes the DOMException's numeric code; a `ReadError` keeps its
cause's code (`Z_DATA_ERROR`) where got reports `ERR_READING_RESPONSE_STREAM`, and a body shorter
than its `content-length` is `other side closed` where got says `Content-Length mismatch`; a
`TimeoutError` has no `event`, since there is one timeout; a TLS handshake failure keeps the TLS
error's own code where got reports `EPROTO`; an `init` hook on a stream call is not shown got's
internal `isStream: true`; `defaults.options.context`, `headers` and `hooks` are live views of the
client's, not got's normalised copies. HTTP/2 is undici's (`allowH2`) rather than got's own session
pool, so session reuse, informational responses, trailers and its error messages differ.

**Behaves differently, because undici does.** A 301/302 `POST` becomes a `GET` without its body
(got keeps the method and body unless `methodRewriting` says otherwise); a body is not forwarded
across origins on a 307/308, and a body that cannot be replayed fails as the 3xx `HTTPError`; a
caller-set `transfer-encoding`, or a `content-length` that disagrees with the body, is refused
(`invalid transfer-encoding header`, `Request body length does not match content-length header`);
and undici's HTTP parser accepts a few malformed responses node's rejects with `Parse Error`.
**`timeout.request` does not bound connecting**: undici only wires a request's abort once its
connection is up, so a TCP connect or TLS handshake that stalls (a blackholed address, a server
that accepts and never answers the handshake) runs to the client's `connectTimeout`, undici's 10s by
default, whatever `timeout.request` or `signal` say. got's request timeout covers that phase. Set
`connectTimeout` no higher than your request timeout if that matters.

**No `user-agent` is sent.** got identifies itself as `got (https://github.com/sindresorhus/got)`;
undici has no default and gotlike adds none, so requests go out with the header absent entirely,
which an upstream that rate-limits, gates or just logs by agent will see. Set one per client if that
matters: `gotlike.extend({ headers: { 'user-agent': 'my-service/1.2' } })`. It is the only request
header that differs between the two clients on the same runtime; `accept-encoding` differs only
below node 22.15, where `zstd` cannot be decoded and so is not advertised (see [Compression](#compression)).

This is also a much younger library than got, with a correspondingly smaller amount of production
mileage behind it. The behaviour above is covered by tests; the long tail beyond it is not.

## Performance options

All of these are dispatcher-level, so they can only be set on create/extend. Keep-alive is
always on because undici does it by default; got's `agent`/`agentkeepalive` setup is unnecessary.

```ts
const client = gotlike.extend({
  dnsCache: true,           // caches lookups per origin; or pass { maxTTL, maxItems, ... }
  connections: 128,         // max sockets per origin (undici's default is 6)
  keepAliveTimeout: 10_000, // how long idle sockets stick around
  keepAliveMaxTimeout: 60_000,
  connectTimeout: 5_000,
  pipelining: 1,            // 0 disables keep-alive entirely
  http2: true,              // ALPN-negotiated h2 over TLS
  dedupe: true,             // collapse concurrent identical in-flight GETs
  cache: true,              // RFC 9111 caching; pass an object for a SqliteCacheStore
  decompress: false,        // skip the decompress interceptor if upstreams never compress
});
```

Interceptors are only composed when the corresponding option is set, and the whole chain is
built once per client rather than per request.

**`extend()` shares the dispatcher**, so deriving clients does not multiply connection pools:

```ts
const tuned = gotlike.extend({ connections: 128 });

tuned.extend({ prefixUrl: 'https://a.example' }); // same pool as `tuned`
tuned.extend({ prefixUrl: 'https://b.example' }); // same pool again
tuned.extend({ connections: 4 });                 // names the transport, so its own pool
```

An extension that names `agent` or any of the options above gets the dispatcher its own options
describe; anything else inherits the parent's, sockets and keep-alive included.

One exception, and it is a `ValidationError` rather than a surprise: the options above cannot be
applied to a client you gave an explicit `agent`. There is no way to ask a `ProxyAgent` or an
`H2CClient` for a copy of itself with `connections` changed, so honouring the option would mean
replacing your dispatcher with a plain `undici.Agent`. For a proxy agent, that means every
request going out **direct**, with nothing on the wire to say so. Pass a new `agent` instead:

```ts
const proxied = gotlike.extend({ agent: new EnvHttpProxyAgent() });

proxied.extend({ prefixUrl: 'https://a.example' });      // keeps the proxy
proxied.extend({ connections: 128 });                    // ValidationError
proxied.extend({ agent: new EnvHttpProxyAgent({ connections: 128 }) }); // this is how
```

`agent` also covers the transports no option above describes, such as a proxy or cleartext h2c:

```ts
import { H2CClient, EnvHttpProxyAgent } from 'undici';

gotlike.extend({ agent: new H2CClient('http://internal.service') });
gotlike.extend({ agent: new EnvHttpProxyAgent() });
```

`agent` takes any undici `Dispatcher`, including one you write yourself. gotlike never looks
inside it, and its own interceptor chain composes on top, so a new transport needs no changes
here.

### Where the time actually goes

Measured against a null dispatcher, so only client-side work is left (median of 3 runs, each in a
fresh process, because comparing dispatchers in one process poisons the inline caches badly enough
to invert results):

| | ns/request | vs raw undici |
| --- | --- | --- |
| raw `undici.request` | 2115 | - |
| gotlike, default (no redirects) | 2588 | +473 |
| gotlike, `followRedirect: true` | 4569 | +2454 |
| gotlike, default + `decompress: false` | 2513 | +398 |

**Redirect support costs ~2µs per request**, about 80% of gotlike's entire overhead. undici's
redirect interceptor allocates a `RedirectHandler` on *every* request to handle a case that almost
never happens (`maxRedirections: 10` costs ~1.4µs against ~0.2µs for `0`). That is why it is off by
default here, and why enabling it is a per-client decision:

```ts
const client = gotlike.extend({ followRedirect: true });
```

Everything left after that (option forming, header merging, response construction, validation)
comes to **under 500ns combined**. There is not much left to win here without giving up correctness.

## Mutable defaults

got's `mutableDefaults`, for the token refresh that merges a new credential into the client from a
hook so every later request carries it:

```ts
const api = gotlike.extend({
  prefixUrl,
  responseType: 'json',
  mutableDefaults: true,
  hooks: {
    afterResponse: [async (response, retryWithMergedOptions) => {
      if (response.statusCode === 401 && !response.request.options.context.skipAuthRefresh) {
        const updated = { headers: { authorization: `Bearer ${await refresh()}` } };

        api.defaults.options.merge(updated);

        return retryWithMergedOptions(updated);
      }

      return response;
    }],
  },
});
```

`merge()` uses `extend()`'s rules (headers case-insensitively, `context`, `timeout` and
`searchParams` one level deep, the rest replaced) and costs nothing per request: it replaces what
every request already reads. A request already in flight keeps the defaults it started with, and a
client extended from this one *before* the merge keeps its own. `mutableDefaults` is not inherited
by `extend()`; name it on the client you mean to merge into.

Two differences from got, both so that a merge cannot silently do nothing. On a client built
without `mutableDefaults` it is a `ValidationError`, where got freezes the defaults and ignores the
merge, so a refreshed token is used for one retry and then dropped. And only request-level options
can be merged: `hooks`, `retry`, `agent` and the rest are built into the client when it is created,
so they are `ValidationError`s here too. Use `extend()` for those.

## Hooks

```ts
const client = gotlike.extend({
  hooks: {
    // may mutate options; sees the resolved url and the serialised body
    beforeRequest: [(options) => { options.headers['x-signature'] = sign(options.body); }],

    // runs before throwHttpErrors, so error statuses are visible here
    afterResponse: [async (response, retryWithMergedOptions) => {
      if (response.statusCode === 401 && !response.request.options.context.alreadyRetried) {
        const token = await refresh(response.request.options.context.brandId);

        return retryWithMergedOptions({
          headers: { authorization: `Bearer ${token}` },
          context: { ...response.request.options.context, alreadyRetried: true },
        });
      }

      return response;
    }],

    // return an error to replace the one about to be thrown
    beforeError: [(error) => new ServiceError(error.code, error.response?.body)],

    // undici strips `authorization` across origins; put it back if you mean to
    beforeRedirect: [(request, response) => {
      logger.info({ to: request.path, status: response.statusCode }, 'following redirect');
      request.headers.authorization = token;
    }],

    beforeRetry: [(error, statusCode, retryCount) => {
      logger.warn({ statusCode, retryCount }, 'retrying');
    }],
  },
});
```

A `beforeRequest` hook may rewrite `options.url`, and the request goes to the url it left. An absolute one is
used exactly as written, so a signed query survives; a relative one is resolved against `prefixUrl` again.
A hook may equally write `options.searchParams` (assigned or changed in place) or `options.username`/`password`,
as in got; an `authorization` header set explicitly still wins over credentials.

To change the body from a hook, **write `options.body`**. `json` and `form` have already been serialised into it
by the time hooks run, as they have in got, so assigning `options.json` there has no effect. `content-length` is
re-derived from whatever `options.body` ends up as, unless you set one explicitly. Then it is yours to keep in
step: undici checks an explicit `content-length` against the body it is about to send and fails the request on a
mismatch.

### Credentials do not cross an origin

A `beforeRequest` hook or a `retryWithMergedOptions` that moves the request to a **different
origin** loses `authorization`, `cookie`, `cookie2`, `host` and `proxy-authorization`, along with
url credentials and the request body:

```ts
gotlike.extend({
  hooks: {
    beforeRequest: [async (options) => { options.url = await resolveEndpoint(); }],
  },
}).post('https://my-api.test/thing', {
  body: payload,
  headers: { authorization: 'Bearer …' },
});
// if resolveEndpoint() returns another host, that host sees no token, no cookie and no body
```

A hook is where a url arrives from somewhere else (a signing service, a discovered endpoint, a
redirect you follow yourself), and sending the caller's credentials to whatever host it names is
the leak undici already prevents when *it* follows a cross-origin redirect. gotlike draws the same
boundary for a hook, as got 16 does.

Anything the hook sets **itself** survives, because it set it knowing where the request was going:
a new `authorization`, a new `body`. So a token refresh that also changes origin has to re-supply
the body it wants sent. A same-origin rewrite, the ordinary signing case, is untouched, and a
url written differently (`http://h:80/` against `http://h/`, a host in another case) is still the
same origin.

`beforeError` runs for streamed requests too, for *every* stream failure and not just an error
status, and a stream's `HTTPError` carries the same `error.response` a non-streamed one does. It
does not run when *you* destroy the stream; see [Errors](#errors).

`afterResponse` is the one hook that does **not** run for `stream()`: there is no parsed body to
hand it, and a streamed request can't be replayed. got scopes it to its promise API for the same
reason.

`beforeRedirect` and `beforeRetry` **cannot delay or cancel** the redirect or retry. undici decides
both inside a synchronous dispatch interceptor, so a promise returned from them is not awaited. They
are for logging, metrics, and (for `beforeRedirect`) adjusting `request.headers` on the next hop.

`beforeRetry` is told why the attempt it is retrying failed: `statusCode` for an attempt that got a
response, `error` for one that failed before its headers arrived. Exactly one of the two is set.

`retryWithMergedOptions` re-runs the request with `newOptions` merged over the ones it was sent
with (`headers`, `context`, `searchParams` and `timeout` merge one level deep, everything else is
replaced). A key you pass as `undefined` leaves the first attempt's value standing rather than
clearing it, as it does everywhere else here and as it does in got. So forwarding
`{method: req.method, throwHttpErrors: cfg.throwHttpErrors}` from somewhere those can be absent
retries the request as it was rather than as a `GET` that no longer throws. It goes straight
back to the request; handlers already ran and are not re-entered.

A body is *replaced*, not merged: passing any of `json`, `body` or `form` drops the other two and
the `content-type` that described the old one, so a retry can change a json body to a form. Passing
none keeps the first attempt's body and its `content-type`, which is what a token refresh wants.

The retried response is passed to the hooks *before* the one that retried, and no further, so a
refresh hook never sees its own retry, and an earlier logging hook runs once per attempt. This is
got's behaviour (it cuts the array at the retrying hook), and it is what makes a hook that always
retries terminate instead of recursing.

A hook that throws, or that forgets to return a response, fails the request as a `RequestError`
with the `beforeError` hooks applied, the same as any other failure, rather than escaping raw.

## Mocking

`gotlike/nock` covers the parts of nock's API that matter for undici:

```ts
import nock from 'gotlike/nock';

nock('https://api.example.com/base/path')   // base paths are folded into every interceptor
  .post(/\/orders\/.*/)                      // string, regex or function path matchers
  .query(true)                              // true matches any query; an object matches exactly
  .times(2)
  .reply(function (uri, requestBody) {      // nock's callback shape, with this.req.headers
    return [200, { ok: true }, { 'x-custom': 'yes' }];
  });

nock.cleanAll();
nock.disableNetConnect();
```

Also supported: `.persist()`, `.delay()`, `.matchHeader()` (on an interceptor or a whole scope),
`.basicAuth()`, `.optionally()`, `.replyWithError()`, `.once()`, `.twice()`, `.thrice()`, `.isDone()`/
`.done()`/`.pendingMocks()`/`.activeMocks()` on a scope, `nock.isDone()`, `nock.pendingMocks()`/`activeMocks()` (nock's
`METHOD proto://host:port/path` strings), `nock.activate()`/`restore()`, and the scope options
`reqheaders`, `badheaders`, `conditionally` and `allowUnmocked` (`nock(host, {reqheaders: {...}})`).
With `allowUnmocked`, a request to that host no interceptor matches goes to the real server, even
under `disableNetConnect()`, as in nock.

A request no interceptor matches fails as nock reports it: `Nock: No match for request {...}` with
code `ERR_NOCK_NO_MATCH` on a mocked origin, and `Nock: Disallowed net connect for "host:port/path"`
with `ENETUNREACH` on an unmocked one that net connect refuses. undici's own `MockNotMatchedError`,
which says which interceptors were left, is on `error.cause`.

**Not implemented** (from running nock's own suite against the shim, see `conformance/`):
`nock.back`, `nock.recorder`, `nock.define`/`load`, `nock.emitter` and scope events,
`nock.removeInterceptor`, `scope.remove()`/`clone()`, `.replyWithFile()`,
`.delayConnection()`/`.delayBody()`, `.defaultReplyHeaders()`, `.replyContentLength()`, `.replyDate()`, `.filteringPath()`/
`.filteringRequestBody()`, `scope.intercept()`, a node-style `reply(function (uri, body, callback))`,
and reply headers given as an array, a `Map` or with function values. `filteringScope` is accepted
but not applied, and fails closed (a scope matches only its own host). A query is parsed as `URLSearchParams` rather than with `qs`, so nested keys (`a[b]=1`) are not
expanded. The shim does not validate its arguments the way nock does (`times('x')` throws undici's
error rather than being ignored). A body matcher sees a multipart `FormData` body as unparsed text. A
`.query(fn)` or `matchHeader()` predicate may be called more than once per request, since undici
applies matchers more than once - keep them pure. A reply callback's body is only JSON-parsed when
the request's `content-type` is a single string. And the shim never sees a request made with node's
own `http` module - it replaces undici's global dispatcher.

As in nock, a plain string path does **not** match a request that carries a query
string; add `.query(true)` for that.

A regex origin such as `nock(/\.example\.com$/)` works, and any number of scopes may share one
pattern. Two *different* patterns that both match the same host do not: undici resolves a concrete
origin against the first regex pool registered for it and caches that decision, so the second
pattern's interceptors never match. A scope's `isDone()`/`done()`/`pendingMocks()` answer for that
scope alone, as nock's do.

Body matchers take a string, a RegExp, a predicate, or an object/array compared against the
request body parsed as JSON (a RegExp or function as a leaf value matches that field), as nock's
do. A predicate is handed the body parsed as JSON when it parses and the text otherwise (`''` for
no body), as nock hands it, except that nock also parses an urlencoded form body into an object
and the shim hands that over as text. Parse it in the predicate with `new URLSearchParams(body)`,
which works under both. An object reply body is sent as `application/json`, again as nock sends it.

A client with its own dispatcher (`agent`, or any of `connections`, `keepAliveTimeout`,
`http2` and the other agent options) is mocked too, as nock mocks every agent: a request to a
mocked origin, or to one `disableNetConnect()` closes, goes to the mock, and an allowed live
request still leaves through the client's own dispatcher. An `agent` that is itself a `MockAgent`
is left alone.

## Streams

```ts
const stream = await gotlike.stream('https://example.com/file');

const head = await stream.response;   // also emitted as a `response` event
console.log(head.statusCode, head.headers, head.timings.phases.total);

await pipeline(stream, createWriteStream('file'));
```

The `response` event is emitted **before any of the body reaches you**, as got's is, so the
proxying shape works written either way round:

```js
const stream = await client.stream(url);

stream.on('response', (head) => res.writeHead(head.statusCode, head.headers));
stream.pipe(res);   // the head is already out by the time the first chunk is
```

The one ordering that is not guaranteed is a `data` listener attached *before* a `response` one.
There, `response` still arrives, but after the first chunk.

Unlike got's, `stream()` resolves to the stream rather than returning it synchronously, because the
`beforeRequest` hooks are async and awaiting them is worth more than a synchronous return.

The writable half carries the request body. It is ended for you when the method has no body
(GET/HEAD) or when a `body`/`json`/`form` was supplied; otherwise write to it and end it yourself:

```ts
const upload = await gotlike.stream(url, { method: 'POST' });

await pipeline(createReadStream('file'), upload);
```

With `throwHttpErrors` on, an error status surfaces when you read the stream, so listen on `error`;
as in got, no `response` event is emitted for it.
With it off, await `stream.response` and check `ok`. The error is a full `HTTPError`, with
`error.response` populated and the `beforeError` hooks already applied.

`stream.response` also carries `retryCount`, alongside `statusCode`, `ok`, `headers`, `url` and
`timings`.

A request with no body of its own resolves to a plain `Readable`: there is nothing to write to a
GET, and wrapping it in a duplex costs ~10% of stream throughput for a writable half nobody can
use. Pass a body-carrying method to get the writable half, and TypeScript will type it as a duplex:

```ts
const download = await gotlike.stream(url);                    // Readable
const upload   = await gotlike.stream(url, { method: 'POST' }); // Duplex
```

`stream` carries got's verb helpers too, and they type the same way. `stream.get`, `.head` and
`.options` resolve to a `Readable`, and `stream.post`, `.put`, `.patch`, `.delete` and `.query` to
the duplex:

```ts
const upload = await gotlike.stream.post(url);

await pipeline(createReadStream('file'), upload);
```

**Redirects and streamed bodies.** Bodyless streams follow redirects normally. A streamed request
body cannot be replayed, so a 307/308, which must preserve method and body, resolves with the
redirect response itself rather than following it. A 301/302/303 on a POST is fine, since those
rewrite to GET and drop the body anyway. Non-streamed bodies replay normally.

## Request bodies

`json` and `form` are serialised for you and set a `content-type` unless one is already present.
`body` is sent as given, and may be a string, a `Buffer`, a `Uint8Array`, a `Readable`, or a `FormData`:

```ts
const form = new FormData();

form.set('name', 'value');
form.set('file', new Blob([bytes], { type: 'image/png' }), 'shot.png');

await gotlike.post(url, { body: form });
// multipart/form-data; boundary=… , encoded byte-for-byte as got encodes it
```

`FormData` is got 15's documented multipart path. undici's `request()` cannot take one directly.
It does not reject it either; the request simply never leaves. So gotlike encodes it and sets the
`content-type` with the boundary that encoding produced. An explicit `content-type` wins, as it
does for `json` and `form`, and then the boundary is yours to get right. The body goes out as a
stream, so a large upload is not held in memory and, as in got, cannot be replayed across a
redirect or a retry.

`beforeRequest` hooks see the `FormData` itself, before it is encoded, so a hook can still add a
signed field to it.

## Compression

Responses are decompressed automatically. Everything node's `zlib` can decode is handled:
`gzip`/`x-gzip`, `deflate`, `compress`/`x-compress`, `br` and `zstd`.

The `accept-encoding` request header is built from what the running node can actually decode.
`zstd` only exists from node 22.15, and advertising an encoding we can't decode would leave you
holding compressed bytes. `compress`/`x-compress` are decoded if a server sends them but aren't
advertised, since nothing uses them.

Set `decompress: false` on create/extend to skip the interceptor and send no `accept-encoding`.

An `accept` header is derived from `responseType` the way got derives one: `application/json` for
`responseType: 'json'`, and nothing at all for `text`, `buffer` or an unset one. An explicit `accept`
always wins.

> [!NOTE]
> undici's decompress interceptor is still flagged experimental, so node prints
> `ExperimentalWarning: DecompressInterceptor is experimental and subject to change` the first
> time a client uses it. Decompression is on by default, so that means once per process.
> It is harmless. Silence it with `decompress: false`, or with node's
> `--disable-warning=ExperimentalWarning`.

## Errors

Failures are normalised to a `RequestError` subclass, all of which stay `instanceof RequestError`:

| class | `code` | when |
| --- | --- | --- |
| `HTTPError` | `ERR_NON_2XX_3XX_RESPONSE` | `throwHttpErrors` is on and the status is outside 2xx, or a 3xx that reached you while following redirects for a reason other than the limit (no `location`, a body that cannot be replayed). A 3xx with `followRedirect` off is not an error, and a 304 never is |
| `MaxRedirectsError` | `ERR_TOO_MANY_REDIRECTS` | the redirect chain ran past 10 hops (`Redirected 10 times. Aborting.`), or undici refused a redirect straight back to the same url as a loop. `error.response` is the last 3xx |
| `TimeoutError` | `ETIMEDOUT` | exceeded `timeout.request` (`Timeout awaiting 'request' for 5000ms`, got's message), or an `AbortSignal.timeout()` fired |
| `ReadError` | the cause's `code`, or `ERR_READING_RESPONSE_STREAM` | the response head arrived but reading or decompressing the body failed: a reset part-way through (`ECONNRESET`), a truncated gzip stream |
| `UploadError` | `ERR_UPLOAD` | a stream passed as `body` errored while it was being sent. The stream's own error, with its code, is `error.cause` |
| `ParseError` | `ERR_BODY_PARSE_FAILURE` | body didn't parse as the requested `responseType`, on a status that was otherwise fine. An *empty* body is never a parse failure, whatever the status. On an error status the status wins: the body is left as the text that arrived, the hooks still see it, and `throwHttpErrors` decides, so a 500 carrying a proxy's HTML page is an `HTTPError`, not a parse failure |
| `AbortError` | `ERR_ABORTED` | the request's `signal` was aborted (`This operation was aborted.`, got's message, unless you aborted with a reason of your own) |
| `RequestError` | the underlying error's own `code`, or `ERR_REQUEST_ERROR` | everything else (connection refused, an unsupported protocol as `ERR_UNSUPPORTED_PROTOCOL`, ...) |

got's `CacheError` does not exist here: the cache is undici's.

An `HTTPError`'s message is got's (`Request failed with status code 403 (Forbidden): GET
http://host/path`) with one deliberate difference: **the query string is removed**. got names the
full url, which is how an api key, a signature or a session token in a query string ends up in every
log line and APM group that prints the error. The path identifies the request; the query is what
leaks. `error.response.request.options.url` still carries the url the request actually went to.

`ValidationError` (`ERR_INVALID_OPTION`) is the one failure that is **not** a `RequestError`, and
deliberately so: it means the client was configured wrong rather than that a request failed. Create
and extend throw it synchronously; a call rejects with it, like any other failure, before anything
reaches the network. It stays a `ValidationError` on every route, including the values inside a
`searchParams` or `form`, which are only checked as the query is built, and including one raised
from inside an `afterResponse` retry.

`error.message` is the underlying failure's own (`connect ECONNREFUSED 127.0.0.1:443`,
`getaddrinfo ENOTFOUND …`) rather than a generic label, so a log line or an APM grouping can tell
one transport failure from another. The originating error is also kept as `error.cause`.

`error.code` comes from that same underlying error, as got's does: `ECONNREFUSED`, `ENOTFOUND`,
`ERR_INVALID_URL`. A connection the server closed on you is `ECONNRESET`, as in got, although undici
calls it `UND_ERR_SOCKET` (`other side closed`) - that stays on `error.cause`. Other failures undici
describes itself arrive under its own names. `ERR_REQUEST_ERROR` is the fallback, for a failure
carrying no code of its own: a throwing hook, say.

Hooks follow the same rule: anything a `beforeRequest`, `afterResponse` or `beforeError` hook
throws comes back as a `RequestError` carrying the hook's own message, not as the raw error.

`error.response` is a full response, with parsed `body`, `headers`, `statusCode`, `ok`,
`retryCount`, `timings` and `request.options`. It is `undefined` only when the request failed
before a response arrived. On a parse failure `response.body` is the raw text that failed to parse.

**Streams fail the same way.** Both stream paths raise these same classes with the `beforeError`
hooks applied, whether the failure came before the response head (connection refused, a
`timeout.request`), from the status (`throwHttpErrors`), or part-way through the body (a truncated
download). `stream.errored`, the `error` event, `stream.response` and `stream.pipeline` all report
the identical normalised error; undici's raw `SocketError`/`DOMException` never reaches you.

This covers the *request's* failures only. Destroying the stream yourself (`stream.destroy()`, a `for await`
with a `break`, a `pipeline` whose destination fails) is not a failed request. The error is passed through as
it stands and the `beforeError` hooks do not run. In a proxy, that keeps a client disconnecting mid-download
from being reported as an upstream failure on every hang-up.

A failure that arrives before the response head is emitted to an `error` listener whether or not
anything ever reads the stream, so the got-shaped pattern works as written:

```js
const stream = await client.stream(url);

stream.on('error', (error) => console.error(error.code));
stream.on('response', () => stream.pipe(destination));
```

A stream nobody is listening to keeps its failure until it is read, rather than emitting an `error`
with no handler and taking the process down. `await stream.response` reports the same failure and
attaches no listener.

## Bodyless responses

`204`, `205`, `304` and any `HEAD` response cannot carry a body, so none is parsed. With
`responseType: 'json'` the body is `undefined`, with `text` it is `''`, and with `buffer` it is an
empty `Buffer`, rather than a parse failure on an empty string. (got hands back `''` for the json
case; `undefined` is a deliberate divergence, pinned in the parity suite.)

A status that *can* carry a body but didn't (a `201 Created` with nothing in it, a `200` with
`content-length: 0`, a `3xx` read with `followRedirect` off) is not a parse failure either. Under
`responseType: 'json'` it resolves with `''`, exactly as got does.

## Response

```ts
response.body        // parsed per responseType; a Buffer for 'buffer'
response.rawBody     // Buffer of the bytes received; computed on first access, not eagerly
                     // (a UTF-8 re-encode on text/json; use responseType: 'buffer' for other charsets)
response.ok          // statusCode in the 2xx range
response.statusCode
response.headers
response.url         // the final url, after any redirects
response.retryCount  // retries undici made, plus any an afterResponse hook drove; 0 without either
response.timings.phases.total
response.request.options
```

### Typing the body

The body type comes from the call site, as it does in got. Pass it as a type argument:

```ts
type User = { id: number; name: string }

const { body } = await gotlike.get<User>('/users/1', { responseType: 'json' })
//      ^? User
```

`responseType` settles it when you don't, and `resolveBodyOnly` unwraps the response:

```ts
await gotlike.get('/x')                                    // Response<string>
await gotlike.get('/x', { responseType: 'buffer' })        // Response<Buffer>
await gotlike.get<User>('/x', { resolveBodyOnly: true })   // User
await gotlike.get('/x', { resolveBodyOnly: true })         // string
```

A client's own `responseType` carries through `extend()`, so calls that say nothing still get
the right body type:

```ts
const api = gotlike.extend({ prefixUrl, responseType: 'json' })

await api.get('/x')              // Response<unknown>; narrow it, or pass the type
await api.get<User>('/x')        // Response<User>
await api.get('/x', { responseType: 'text' })  // Response<string>; the call still wins
```

A client-level `resolveBodyOnly: true` carries through the same way.

The same overloads are on `post`/`put`/`patch`/`delete`/`head`/`query`, on the callable form
(`gotlike<User>('/x')`) and on `handle`.

`Response` itself is not a tagged union over `responseType`, since there is nothing on `Response<T>`
to key it on. The client type carries it instead, which is also what got does.

## Benchmark

```
cd benchmark && npm install && npm run bench
```

Compares gotlike against got, raw `undici.request` and undici's `fetch`, across GET/POST, body
sizes, streaming, and concurrency levels of 1/10/50. Requests are served from pre-built response
buffers over raw sockets, so the server stays out of the measurement.

Throughput at concurrency 10, node 26, loopback (median of 5 rounds):

| client | GET json | POST json | 100 KB | stream 100 KB |
| --- | --- | --- | --- | --- |
| `undici.request` | 28,146 | 30,227 | 13,946 | 12,165 |
| gotlike | 28,572 | 29,135 | 13,717 | 11,051 |
| undici `fetch` | 14,191 | 10,678 | 7,283 | 7,773 |
| got | 9,762 | 9,775 | 6,862 | 6,927 |

So roughly **3x got and 2x `fetch`** on JSON work, and at parity with raw undici.

**gotlike and `undici.request` should be read as equal.** gotlike is a thin wrapper over it and
cannot genuinely be faster. Across scenarios it lands at 0.87-1.01x of raw undici; treat anything
in that band as noise, not a result. The gaps against got and `fetch` are well outside it.

Streaming is the one place gotlike gives up something measurable (0.87-0.98x): it wraps the stream
to expose the response head and apply `throwHttpErrors`.

Benchmarking clients in one process is noisier than it looks: whichever runs first gets warm
sockets and leaves a cold JIT for the rest, which alone produced a ~25% swing. The runner rotates
client order across several rounds and reports each client's median round. Tunable with
`BENCH_DURATION`, `BENCH_ROUNDS`, `BENCH_WARMUP`, `BENCH_CONCURRENCY` and `BENCH_SERVER=http`.

## Options validation

Options are validated: unknown keys, a misspelled `responseType`, `timeout: 5000` where an object
was meant, or a client-only option passed to a single call.

```ts
await gotlike.get('/test', { responseType: 'jsn' })
// ValidationError: `responseType` must be one of text, json, buffer, got `jsn`

await gotlike.get('/test', { retry: { limit: 2 } })
// ValidationError: `retry` can only be set when creating or extending a client, not per request
```

Client options are always validated on create/extend, where it throws synchronously and costs
nothing. Per-request validation measures ~50ns, around 0.1% of a request, and rejects rather than
throwing so it behaves like any other failure. Turn it off with `validate: false` if you disagree.

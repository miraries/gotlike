# Gotlike

A [got](https://github.com/sindresorhus/got)-shaped HTTP client for node.js, built on
[undici](https://github.com/nodejs/undici). Includes a [nock](https://github.com/nock/nock)-like mocking layer, since nock doesn't
intercept undici.

ESM, node >= 22.12. CommonJS projects can still `require('gotlike')`

## Usage

```ts
import { Gotlike } from 'gotlike'

// these work as well
// const {gotlike} = require('gotlike')
// const {got} = require('gotlike')
// import got from 'gotlike'
// import {Got} from 'gotlike'
// import {gotlike} from 'gotlike'

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

got has the API worth keeping - extendable clients, handlers, hooks, sane errors - but it sits on
node's `http` module and costs about three times as much per request as undici does. undici is the
fast path, but its API is deliberately low-level: no client extension, no option merging, no hooks,
errors that arrive as raw dispatch failures.

Swapping one for the other in a codebase with hundreds of call sites means rewriting all of them,
and replacing nock as well, because nock doesn't intercept undici at all.

So: undici underneath, got's shape on top, and nock's shape for the tests. The aim is that moving a
codebase over is an import change rather than a rewrite - and that the result is roughly **3x got**
on throughput while staying within a few percent of raw undici.

It is not a got clone. Features are added when they're needed, and got's design is followed only
where it doesn't cost anything at runtime - see [Differences](#differences-from-got).

> **Redirects are not followed by default**, unlike got. undici allocates a redirect handler on
> every request once its interceptor is in play, which measured at ~80% of this client's entire
> per-request overhead - so it is opt-in: `gotlike.extend({ followRedirect: true })`.

Supports:
- [x] Extendable client
- [x] Handlers
- [x] Hooks *(arrays, instance-level only)*
- [x] `afterResponse` retries via `retryWithMergedOptions`
- [x] `context`
- [x] Retries *(partial - maps onto undici's `retry` interceptor; honours `Retry-After`)*
- [x] `searchParams`, `form`
- [x] Decompression - gzip, deflate, br, zstd, compress
- [x] Basic auth - `username` / `password`
- [x] `response.ok` / `rawBody` / `retryCount`
- [x] Named error classes - `HTTPError`, `TimeoutError`, `ParseError`
- [x] Streams *(with response head + timings; no progress events)*
- [x] All hooks - `beforeRequest`, `afterResponse`, `beforeError`, `beforeRetry`, `beforeRedirect`
- [x] Timings *(only total request)*
- [x] Parsed response body and timings on errors
- [x] Nock-like mocking
- [x] DNS cache
- [x] Connection pool tuning
- [x] Response caching and request deduplication
- [x] HTTP2 *(over TLS; cleartext h2c needs an `agent`)*
- [x] Pipelining
- [x] Options validation
- [x] Callable client - `gotlike(url, options)`

## Differences from got

### Chosen for speed

| | got | gotlike |
| --- | --- | --- |
| `hooks`, `handlers`, `retry`, `agent`, `http2`, `pipelining`, `dnsCache`, `dnsLookup`, `decompress` | per request or per client | **create/extend only** - passing them per request is a `ValidationError` |
| option merging | per-option merge table, every request | **one shallow spread**; `headers` and `context` merge one level deep |
| `response.rawBody` | always materialised | **computed on first access** - the bytes as received, so a `json` response still hands back the original text |
| `options.url` | normalised to a `URL` | **left a string**, rewritten to the full `prefixUrl`-resolved URL before handlers and hooks see it. Use `String(options.url)`, not `options.url.href` |
| `options.context` | fresh `{}` per request | a **shared frozen** `{}` when unset - reads are safe, writes throw rather than leak. Pass a `context` to get a writable one |
| `validate` | n/a | client-only, like the options above - it is read from the instance, so a per-request value would do nothing |
| `followRedirect` | `true` | **`false`** - redirects cost ~2µs/request to support, whether or not one happens. Enable per client with `extend({ followRedirect: true })`; a per-request `true` is a `ValidationError`, since composing the interceptor is a create/extend-time decision |
| `stream()` for a bodyless request | always a `Duplex` | a **`Readable`** - nothing can be written to a GET, and the duplex wrapper cost ~10% of stream throughput |

### Forced by undici

| | behaviour |
| --- | --- |
| `timeout.request` | a cap on the **whole** request, as got's is. undici's own `headersTimeout`/`bodyTimeout` are per-phase and `bodyTimeout` restarts on every chunk, so a slowly trickling response would never trip them - a deadline signal enforces the total on top. That also sidesteps undici's coarse 1s timer wheel, so sub-second timeouts fire on time |
| `retry` | maps onto undici's `retry` interceptor. `limit` defaults to got's 2, and `Retry-After` is honoured, but `calculateDelay`/`noise` are not implemented and `maxRetryAfter` degrades to "honour the header or don't". The retried **status codes and methods are undici's defaults**, not got's - set `statusCodes`/`methods` explicitly if that matters |
| `beforeRedirect`, `beforeRetry` | **cannot delay or cancel** - undici decides both inside a synchronous dispatch interceptor, so a returned promise is not awaited |
| streamed request bodies | **not replayed across a 307/308**, which must preserve method and body. 301/302/303 are fine (they rewrite to GET and drop the body); non-streamed bodies replay normally |

### Smaller surface

`stream()` resolves to the stream rather than returning it synchronously, so async `beforeRequest`
hooks can be awaited. An absolute `url` overrides `prefixUrl` instead of being rejected outright.
got's `init` hook, `pagination`, `allowGetBody` and `methodRewriting` are not implemented.

This is also a much younger library than got, with a correspondingly smaller amount of production
mileage behind it. The behaviour above is covered by tests; the long tail beyond it is not.

## Performance options

All of these are dispatcher-level, so they can only be set on create/extend. Keep-alive is
always on - undici does it by default and got's `agent`/`agentkeepalive` setup is unnecessary.

```ts
const client = gotlike.extend({
  dnsCache: true,           // or { maxTTL, maxItems, ... } - caches lookups per origin
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

### Where the time actually goes

Measured against a null dispatcher, so only client-side work is left (median of 3 runs, each in a
fresh process - comparing dispatchers in one process poisons the inline caches badly enough to
invert results):

| | ns/request | vs raw undici |
| --- | --- | --- |
| raw `undici.request` | 2115 | - |
| gotlike, default (no redirects) | 2588 | +473 |
| gotlike, `followRedirect: true` | 4569 | +2454 |
| gotlike, default + `decompress: false` | 2513 | +398 |

**Redirect support is worth ~2µs per request** - about 80% of gotlike's entire overhead. undici's
redirect interceptor allocates a `RedirectHandler` on *every* request to handle a case that almost
never happens (`maxRedirections: 10` costs ~1.4µs against ~0.2µs for `0`). That is why it is off by
default here, and why enabling it is a per-client decision:

```ts
const client = gotlike.extend({ followRedirect: true });
```

Everything left after that - option forming, header merging, response construction, validation - is
**under 500ns combined**. There is not much left to win here without giving up correctness.

For anything else - proxies, cleartext h2c - pass your own dispatcher as `agent`:

```ts
import { H2CClient, EnvHttpProxyAgent } from 'undici';

gotlike.extend({ agent: new H2CClient('http://internal.service') });
gotlike.extend({ agent: new EnvHttpProxyAgent() });
```

`agent` takes any undici `Dispatcher`, including one you write yourself. gotlike never looks
inside it, and its own interceptor chain composes on top - so a new transport needs no changes
here.

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

`beforeError` runs for streamed requests too, and a stream's `HTTPError` carries the same
`error.response` a non-streamed one does.

`beforeRedirect` and `beforeRetry` **cannot delay or cancel** the redirect or retry - undici decides
both inside a synchronous dispatch interceptor, so a promise returned from them is not awaited. They
are for logging, metrics, and (for `beforeRedirect`) adjusting `request.headers` on the next hop.

`retryWithMergedOptions` re-runs the request with `newOptions` merged over the ones it was sent
with (`headers` and `context` merge one level deep, everything else is replaced). It goes straight
back to the request - handlers already ran and are not re-entered.

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

Also supported: `.persist()`, `.delay()`, `.matchHeader()`, `.replyWithError()`, `.once()`,
`.twice()`, `.thrice()`, `.isDone()`, `nock.pendingMocks()`, `nock.activate()`/`restore()`.

Note that, as in nock, a plain string path does **not** match a request that carries a query
string - add `.query(true)` for that.

## Streams

```ts
const stream = await gotlike.stream('https://example.com/file');

const head = await stream.response;   // also emitted as a `response` event
console.log(head.statusCode, head.headers, head.timings.phases.total);

await pipeline(stream, createWriteStream('file'));
```

Unlike got's, `stream()` resolves to the duplex rather than returning it synchronously - the
`beforeRequest` hooks are async and awaiting them is worth more than a synchronous return.

The writable half carries the request body. It is ended for you when the method has no body
(GET/HEAD) or when a `body`/`json`/`form` was supplied; otherwise write to it and end it yourself:

```ts
const upload = await gotlike.stream(url, { method: 'POST' });

await pipeline(createReadStream('file'), upload);
```

With `throwHttpErrors` on, an error status surfaces when you read the stream - listen on `error`,
or await `stream.response` and check `ok` with it turned off. The error is a full `HTTPError`, with
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

**Redirects and streamed bodies.** Bodyless streams follow redirects normally. A streamed request
body cannot be replayed, so a 307/308 - which must preserve method and body - resolves with the
redirect response itself rather than following it. A 301/302/303 on a POST is fine, since those
rewrite to GET and drop the body anyway. Non-streamed bodies replay normally.

## Compression

Responses are decompressed automatically. Everything node's `zlib` can decode is handled:
`gzip`/`x-gzip`, `deflate`, `compress`/`x-compress`, `br` and `zstd`.

The `accept-encoding` request header is built from what the running node can actually decode -
`zstd` only exists from node 22.15, and advertising an encoding we can't decode would leave you
holding compressed bytes. `compress`/`x-compress` are decoded if a server sends them but aren't
advertised, since nothing uses them.

Set `decompress: false` on create/extend to skip the interceptor and send no `accept-encoding`.

## Errors

Failures are normalised to a `RequestError` subclass, all of which stay `instanceof RequestError`:

| class | `code` | when |
| --- | --- | --- |
| `HTTPError` | `ERR_HTTP_ERROR` | non-2xx/3xx and `throwHttpErrors` is on |
| `TimeoutError` | `ETIMEDOUT` | exceeded `timeout.request`, or an `AbortSignal.timeout()` fired |
| `ParseError` | `ERR_BODY_PARSE_FAILURE` | body didn't parse as the requested `responseType` |
| `AbortError` | `ERR_ABORTED` | the request's `signal` was aborted |
| `RequestError` | `ERR_REQUEST_ERROR` | everything else (connection refused, socket errors, ...) |

The originating error is kept as `error.cause`.

`error.response` is a full response - parsed `body`, `headers`, `statusCode`, `ok`, `retryCount`,
`timings` and `request.options` - and is `undefined` only when the request failed before a response
arrived. On a parse failure `response.body` is the raw text that failed to parse.

## Bodyless responses

`204`, `205`, `304` and any `HEAD` response cannot carry a body, so none is parsed. With
`responseType: 'json'` the body is `undefined`, with `text` it is `''`, and with `buffer` it is an
empty `Buffer` - rather than a parse failure on an empty string.

## Response

```ts
response.body        // parsed per responseType; a Buffer for 'buffer'
response.rawBody     // Buffer of the bytes received; computed on first access, not eagerly
response.ok          // statusCode in the 2xx range
response.statusCode
response.headers
response.retryCount  // 0 unless `retry` is configured
response.timings.phases.total
response.request.options
```

### Typing the body

The body type comes from the call site, as it does in got - pass it as a type argument:

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

await api.get('/x')              // Response<unknown> - narrow it, or pass the type
await api.get<User>('/x')        // Response<User>
await api.get('/x', { responseType: 'text' })  // Response<string> - the call still wins
```

A client-level `resolveBodyOnly: true` carries through the same way.

The same overloads are on `post`/`put`/`patch`/`delete`, on the callable form
(`gotlike<User>('/x')`) and on `handle`.

`Response` itself is not a tagged union over `responseType` - there is nothing on `Response<T>` to
key it on. The client type carries it instead, which is also what got does.

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

**gotlike and `undici.request` should be read as equal** - gotlike is a thin wrapper over it and
cannot genuinely be faster. Across scenarios it lands at 0.87-1.01x of raw undici; treat anything
in that band as noise, not a result. The gaps against got and `fetch` are well outside it.

Streaming is the one place gotlike gives up something measurable (0.87-0.98x): it wraps the duplex
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

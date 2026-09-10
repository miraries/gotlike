# Gotlike

Barebones [got](https://github.com/sindresorhus/got)-like [undici](https://github.com/nodejs/undici)-based not-as-safe
commonjs-compatible http client for node.js.

Includes a basic nock-like mocking system (since nock doesn't work with undici).

The idea is to be able to replace got and nock with gotlike in most cases, while being more performant.
At the moment only the features I use are implemented.

Supports:
- [x] Extendable client
- [x] Handlers
- [x] Hooks *(arrays, `beforeRequest` / `afterResponse` / `beforeError`, instance-level only)*
- [x] `afterResponse` retries via `retryWithMergedOptions`
- [x] `context`
- [x] Retries *(partial - maps onto undici's `retry` interceptor)*
- [x] `searchParams`, `form`
- [x] Decompression - gzip, deflate, br, zstd, compress
- [x] Basic auth - `username` / `password`
- [x] `response.ok` / `rawBody` / `retryCount`
- [x] Named error classes - `HTTPError`, `TimeoutError`, `ParseError`
- [x] Streams *(with response head + timings; no progress events)*
- [x] Timings *(only total request)*
- [x] Parsed response body and timings on errors
- [x] Nock-like mocking
- [x] DNS cache
- [x] Connection pool tuning
- [x] Response caching and request deduplication
- [x] HTTP2 *(over TLS; cleartext h2c needs an `agent`)*
- [x] Pipelining
- [ ] HTTP3 - not possible, undici has no QUIC support
- [ ] Options validation
- [ ] Callable client - `gotlike(url, options)`
- [ ] `beforeRedirect` hook - would mean reimplementing undici's redirect handling

## Differences

Deliberate divergences from got, mostly to keep the per-request path cheap:

- `retry`, `http2`, `pipelining`, `dnsCache`, `dnsLookup`, `agent`, `handlers` and `hooks` can be
  set only on instance create/extend. Passing them to a single call has no effect - resolving them
  once per client is what keeps them off the hot path
- Options are shallow-merged (instance defaults, then call options, with `headers` and `context`
  merged one level deep). got walks a per-option merge table on every request
- `options.url` is a string, not a `URL`. It is rewritten to the full `prefixUrl`-resolved URL
  before handlers and hooks see it, so use `String(options.url)` rather than `options.url.href`
- An absolute `url` overrides `prefixUrl` rather than being appended to it (got refuses the
  combination outright)
- `timeout.request` is subject to undici's timer resolution: undici arms header/body timeouts on a
  coarse timer wheel with a 1 second resolution, so **any timeout below ~1s behaves as ~1s**
- `options.context` defaults to a shared frozen empty object. Reads are safe; writing to it throws
  rather than silently leaking across requests. Pass a `context` to get a writable one
- Only one function per hook type runs per request in got's `init`/`beforeRedirect`/`beforeRetry`
  sense - those three hooks don't exist here at all

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
built once per client rather than per request. `followRedirect: false` on the client skips
composing the redirect interceptor as well - worth doing when you never expect redirects,
since the interceptor rest-spreads the dispatch options before it can bail out.

For anything else - proxies, cleartext h2c - pass your own dispatcher as `agent`:

```ts
import { H2CClient, EnvHttpProxyAgent } from 'undici';

gotlike.extend({ agent: new H2CClient('http://internal.service') });
gotlike.extend({ agent: new EnvHttpProxyAgent() });
```

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
  },
});
```

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

With `throwHttpErrors` on, an error status destroys the stream with an `HTTPError` rather than
resolving - listen on `error`, or await `stream.response` and check `ok` with it turned off.

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
| `TimeoutError` | `ETIMEDOUT` | exceeded `timeout.request` |
| `ParseError` | `ERR_BODY_PARSE_FAILURE` | body didn't parse as the requested `responseType` |
| `RequestError` | `ERR_REQUEST_ERROR` | everything else (connection refused, aborted, ...) |

The originating error is kept as `error.cause`.

`error.response` is a full response - parsed `body`, `headers`, `statusCode`, `ok`, `retryCount`,
`timings` and `request.options` - and is `undefined` only when the request failed before a response
arrived. On a parse failure `response.body` is the raw text that failed to parse.

## Response

```ts
response.body        // parsed per responseType; a Buffer for 'buffer'
response.rawBody     // Buffer; computed on first access, not eagerly
response.ok          // statusCode in the 2xx range
response.statusCode
response.headers
response.retryCount  // 0 unless `retry` is configured
response.timings.phases.total
response.request.options
```

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
    'authorization': 'Basic test:test',
  },
  responseType: 'json',
})

const response = await gotlike.get('/test')

console.log(response.body)
```

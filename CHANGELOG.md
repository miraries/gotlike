# Changelog

All notable changes to this project are documented here. This project adheres to
[semantic versioning](https://semver.org/spec/v2.0.0.html); while the major version is `0`, a
minor bump is where breaking changes land.

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

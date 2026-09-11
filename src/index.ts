import dns from 'node:dns';
import zlib from 'node:zlib';
import {Duplex, Readable} from 'node:stream';
import undici, {DecoratorHandler, Dispatcher, errors, getGlobalDispatcher, interceptors} from 'undici';
import type {IncomingHttpHeaders} from 'undici/types/header.js';

const {BodyTimeoutError, HeadersTimeoutError, RequestRetryError} = errors;

/**
 * Present a response body as the stream `stream()` resolves to.
 *
 * A failure is raised by the readable itself when first read, rather than by destroying the
 * stream. Destroying has no good moment: synchronously, the error is emitted before an
 * awaiting caller has attached a listener; on a later tick, a small body has already been
 * consumed and the read finished cleanly. Raising it at read time lands whenever the caller
 * actually reads.
 */
function asStream(readable: Readable, head: StreamHead | undefined, error?: Error): GotlikeStream {
  const source = error
    ? new Readable({
        read() {
          this.destroy(error);
        },
      })
    : readable;

  const stream = source as GotlikeStream;

  stream.response = head ? Promise.resolve(head) : Promise.reject(error ?? new Error('Request failed'));
  // Nothing is obliged to await this; an unhandled rejection would take the process down.
  stream.response.catch(() => undefined);

  if (head) {
    // On setImmediate, not a microtask: callers attach their listener after
    // `await stream(...)`, and a microtask queued before that await resolves fires first.
    setImmediate(() => stream.emit('response', head));
  }

  return stream;
}

/**
 * At a redirect hop undici hands over headers in its flat `[name, value, name, value]` raw
 * form rather than as an object, so a hook writing `headers.authorization` would be setting
 * a named property on an array and silently achieving nothing.
 */
function headersToObject(headers: unknown): IncomingHttpHeaders {
  if (!Array.isArray(headers)) {
    return (headers ?? {}) as IncomingHttpHeaders;
  }

  const object: IncomingHttpHeaders = {};

  for (let i = 0; i < headers.length; i += 2) {
    object[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
  }

  return object;
}

/**
 * What the previous dispatch produced, plus how many there have been. Both the retry counter
 * and the redirect tracker need exactly this, so they share it.
 */
type DispatchState = {
  count: number;
  lastStatusCode?: number;
  lastHeaders?: IncomingHttpHeaders;
  lastError?: Error;
};

type RedirectState = DispatchState;

type AttemptState = DispatchState & {
  onRetry?: (error: Error | undefined, statusCode: number | undefined, retryCount: number) => void;
};

/**
 * undici's typings don't expose the per-request options that the `redirect` and `retry`
 * interceptors pick off the dispatch options, but both read them at runtime (see
 * lib/interceptor/{redirect,retry}.js). Composing the interceptors once per client and
 * overriding per request is what keeps these as request options without rebuilding a
 * dispatcher on every call. `attempts` and `redirects` are ours.
 */
type InterceptorOptions = {
  maxRedirections?: number;
  retryOptions?: RetryHandlerOptions;
  attempts?: AttemptState;
  redirects?: RedirectState;
};

/** `DecoratorHandler`'s typings declare no members, so restate the two we delegate to. */
declare class DecoratorHandlerShape {
  constructor(handler: Dispatcher.DispatchHandler);
  onResponseStart(
    controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    statusMessage?: string,
  ): void;
  onResponseError(controller: Dispatcher.DispatchController, error: Error): void;
}

const BaseDecoratorHandler = DecoratorHandler as unknown as typeof DecoratorHandlerShape;

/**
 * Records what a dispatch produced onto shared state, so the *next* dispatch can say why it
 * happened - which status redirected it, or which error it is retrying. Pass-through
 * otherwise; `DecoratorHandler` forwards everything it doesn't override.
 */
class OutcomeHandler extends BaseDecoratorHandler {
  #state: DispatchState;

  constructor(handler: Dispatcher.DispatchHandler, state: DispatchState) {
    super(handler);

    this.#state = state;
  }

  override onResponseStart(
    controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    statusMessage?: string,
  ) {
    this.#state.lastStatusCode = statusCode;
    this.#state.lastHeaders = headers;
    this.#state.lastError = undefined;

    return super.onResponseStart(controller, statusCode, headers, statusMessage);
  }

  override onResponseError(controller: Dispatcher.DispatchController, error: Error) {
    this.#state.lastError = error;

    return super.onResponseError(controller, error);
  }
}

/**
 * An interceptor that counts dispatches and calls `onRedispatch` for every one after the
 * first, with what the previous attempt produced.
 *
 * Composing this *inside* another interceptor is what makes it useful: `compose()` wraps in
 * array order, so an earlier entry sits closer to the socket and is re-entered whenever the
 * outer interceptor retries or follows a redirect, while the outer one is entered once.
 *
 * undici exposes no counter of its own - `response.context` is null after a retried request,
 * and hooking the retry decision callback would mean reimplementing undici's backoff. This
 * gets the same information from public API only.
 */
function trackDispatches(
  select: (opts: InterceptorOptions) => DispatchState | undefined,
  onRedispatch: (state: DispatchState, opts: Dispatcher.DispatchOptions) => void,
): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) =>
    function TrackDispatches(opts, handler) {
      const state = select(opts as InterceptorOptions);

      if (!state) {
        return dispatch(opts, handler);
      }

      state.count++;

      if (state.count > 1) {
        onRedispatch(state, opts);
      }

      return dispatch(opts, new OutcomeHandler(handler, state));
    };
}

/** Drives `response.retryCount`, and `beforeRetry` when the client has such hooks. */
const countAttempts = trackDispatches(
  (opts) => opts.attempts,
  (state) => {
    (state as AttemptState).onRetry?.(state.lastError, state.lastStatusCode, state.count - 1);
  },
);

/**
 * Fires `beforeRedirect` hooks. The hop's outgoing options are still mutable at this point,
 * which is what lets a hook re-add a header undici stripped on a cross-origin redirect.
 *
 * The state holder has to arrive with the dispatch options rather than be attached on the
 * first hop: `RedirectHandler` copies the options in its constructor - before hop 1 reaches
 * here - and re-dispatches later hops with that copy, so anything attached on hop 1 is
 * invisible to hop 2.
 */
function makeRedirectTracker(hooks: NonNullable<Hooks['beforeRedirect']>): Dispatcher.DispatcherComposeInterceptor {
  return trackDispatches(
    (opts) => opts.redirects,
    (state, opts) => {
      if (state.lastStatusCode === undefined) {
        return;
      }

      const request: RedirectRequest = {
        origin: String(opts.origin ?? ''),
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: headersToObject(opts.headers),
      };

      for (const hook of hooks) {
        hook(request, {statusCode: state.lastStatusCode, headers: state.lastHeaders ?? {}});
      }

      // Always assigned back: the hook may have mutated the object or replaced it, and the
      // object form has to replace whatever raw array undici handed us either way.
      opts.headers = request.headers;
    },
  );
}

type RetryHandlerOptions = NonNullable<Parameters<typeof interceptors.retry>[0]>;

type UndiciRequestOptions = NonNullable<Parameters<typeof undici.request>[1]> & InterceptorOptions;
type UndiciPipelineOptions = NonNullable<Parameters<typeof undici.pipeline>[1]> & InterceptorOptions;

/** The fields both `undici.request` and `undici.pipeline` accept. */
type SharedDispatchOptions = UndiciRequestOptions & UndiciPipelineOptions;

const emptyContext: Record<string, any> = Object.freeze({});

/**
 * What we can actually decompress, in preference order. undici's decompress interceptor
 * handles everything node's zlib does, but `createZstdDecompress` only exists from node
 * 22.15 - advertising an encoding we can't decode would leave callers holding compressed
 * bytes, so the header is built from what this runtime really supports.
 *
 * `compress`/`x-compress` and `x-gzip` are decompressed if a server sends them, but aren't
 * advertised: they're effectively dead on the wire and only lengthen the header.
 */
const acceptEncoding = [
  typeof zlib.createGunzip === 'function' ? 'gzip' : '',
  typeof zlib.createInflate === 'function' ? 'deflate' : '',
  typeof zlib.createBrotliDecompress === 'function' ? 'br' : '',
  typeof zlib.createZstdDecompress === 'function' ? 'zstd' : '',
]
  .filter(Boolean)
  .join(', ');

const absoluteUrl = /^[a-z][a-z\d+\-.]*:\/\//i;

/**
 * Serialise `searchParams` / `form` values. Entries that are `null` or `undefined` are
 * dropped rather than sent as the string "null" - got does the same, and a provider
 * receiving `?foo=undefined` is never what was meant.
 */
function stringifyQuery(input: NonNullable<RequestOptions['searchParams']>): string {
  if (typeof input === 'string') {
    return input.startsWith('?') ? input.slice(1) : input;
  }

  if (input instanceof URLSearchParams) {
    return input.toString();
  }

  const params = new URLSearchParams();

  for (const key in input) {
    const value = input[key];

    if (value !== null && value !== undefined) {
      params.append(key, String(value));
    }
  }

  return params.toString();
}

/** Status codes that cannot carry a response body, per RFC 9110. */
const bodylessStatusCodes = new Set([204, 205, 304]);

function isOk(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/** What `throwHttpErrors` acts on: anything outside 2xx/3xx. */
function isHttpError(statusCode: number): boolean {
  return statusCode < 200 || statusCode >= 400;
}

function hasNoBody(statusCode: number, method: string): boolean {
  return method === 'HEAD' || bodylessStatusCodes.has(statusCode);
}

function hasHeader(headers: IncomingHttpHeaders, name: string): boolean {
  if (headers[name] !== undefined) {
    return true;
  }

  for (const key in headers) {
    if (key.toLowerCase() === name) {
      return true;
    }
  }

  return false;
}

/** Dispatches minus the first attempt. */
function retriesFrom(attempts?: {count: number}): number {
  return attempts ? Math.max(attempts.count - 1, 0) : 0;
}

/** Shallow-merge two optional records, without allocating when only one is present. */
function mergeRecords<T extends object>(base?: T, override?: T): T | undefined {
  if (!base) {
    return override;
  }

  return override ? {...base, ...override} : base;
}

const hookNames = ['beforeRequest', 'afterResponse', 'beforeError', 'beforeRetry', 'beforeRedirect'] as const;

/** Concatenates every hook array, so extending a client adds to its hooks rather than replacing them. */
function mergeHooks(base?: Hooks, override?: Hooks): Hooks | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  const merged: Hooks = {};

  for (const name of hookNames) {
    // Assigned through a cast because each hook name has its own signature; `concatHooks`
    // is generic over the element type and the names do not unify.
    (merged as Record<string, unknown[] | undefined>)[name] = concatHooks(
      base[name] as unknown[] | undefined,
      override[name] as unknown[] | undefined,
    );
  }

  return merged;
}

/** An empty hook array is the same as none, and costs a length check per request. */
function usedHooks<T>(hooks?: T[]): T[] | undefined {
  return hooks?.length ? hooks : undefined;
}

function concatHooks<T>(base?: T[], added?: T[]): T[] | undefined {
  if (!base) {
    return added;
  }

  return added ? [...base, ...added] : base;
}

/** Milliseconds since `startTime`, or 0 when the request never got far enough to have one. */
function elapsedMs(startTime?: [number, number]): number {
  return startTime ? hrtimeToMilliseconds(process.hrtime(startTime)) : 0;
}

function hrtimeToMilliseconds(hrtime: [number, number]) {
  const seconds = hrtime[0];
  const nanoseconds = hrtime[1];

  return seconds * 1000 + nanoseconds / 1_000_000;
}

type RetryOptions = {
  limit: number;
  methods: Dispatcher.HttpMethod[];
  statusCodes: number[];
  errorCodes: string[];
  // calculateDelay: RetryFunction;
  backoffLimit: number;
  // noise: number;
  maxRetryAfter?: number;
};

export class RequestError<T = unknown> extends Error {
  override name = 'RequestError';

  code: string;
  declare readonly options: RequestOptions;

  /**
   * The response that produced this error, in the same shape `call()` resolves with: a
   * parsed `body` and populated `timings`. Absent when the request failed before a
   * response was received (connection refused, timeout, aborted).
   */
  readonly response?: Response<T>;

  constructor(
    message: string,
    code: string,
    error: Partial<Error> | undefined,
    options: RequestOptions,
    response?: Response<T>,
  ) {
    super(message, error instanceof Error ? {cause: error} : undefined);

    this.code = code ?? 'ERR_GOT_REQUEST_ERROR';
    this.response = response;

    this.options = options;
  }
}

/** Thrown for a non-2xx/3xx response when `throwHttpErrors` is on. */
export class HTTPError<T = unknown> extends RequestError<T> {
  override name = 'HTTPError';
}

/** Thrown when the request exceeded `timeout.request`. */
export class TimeoutError<T = unknown> extends RequestError<T> {
  override name = 'TimeoutError';
}

/** Thrown when the request was aborted through its `signal`. */
export class AbortError<T = unknown> extends RequestError<T> {
  override name = 'AbortError';
}

/** Thrown when the body could not be parsed as the requested `responseType`. */
export class ParseError<T = unknown> extends RequestError<T> {
  override name = 'ParseError';
}

export type FormedOptions = RequestOptions & {
  throwHttpErrors: boolean;
  followRedirect: boolean;
  headers: IncomingHttpHeaders;
  responseType: 'text' | 'json' | 'buffer';
  method: Dispatcher.HttpMethod;
  context: Record<string, any>;
};

export type HandlerFunction = (
  options: FormedOptions,
  next: (newOptions: FormedOptions) => Promise<Response>,
) => Promise<Response>;

export type RequestOptions<T = unknown> = {
  /** The URL to request, as a string or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url). */
  url?: string | URL;

  /** Request headers. */
  headers?: IncomingHttpHeaders;

  /** When specified, `prefixUrl` will be prepended to `url`. */
  prefixUrl?: string;

  /** Username for Basic authentication. Sets `authorization` unless one is already set. */
  username?: string;

  /** Password for Basic authentication. */
  password?: string;

  /**
   * Milliseconds to wait for the server to end the response before aborting the request with `ETIMEDOUT` error (a.k.a. `request` property).
   * By default, there's no timeout.
   *
   * Only `request` property is supported.
   **/
  timeout?: {
    request?: number;
  };

  /** The HTTP method used to make the request. */
  method?: Dispatcher.HttpMethod;

  /**
   * JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.
   *
   * __Note__: This option is not enumerable and will not be merged with the instance defaults.
   */
  json?: unknown;

  body?: string | Buffer | Uint8Array | null;

  /** The parsing method. `buffer` resolves to a Node `Buffer`. */
  responseType?: 'text' | 'json' | 'buffer';

  /**
   * Query string to add to the request URL. Overrides any query already present on `url`.
   *
   * Object values are stringified; `null` and `undefined` entries are dropped.
   */
  searchParams?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined>;

  /**
   * `application/x-www-form-urlencoded` body. Sets the `Content-Type` header unless one is
   * already set. Takes precedence over `body`, and is itself overridden by `json`.
   */
  form?: Record<string, string | number | boolean | null | undefined> | URLSearchParams;

  /**
   * Validate options. Client options are always validated on create/extend - it happens
   * once and costs nothing. This flag controls the *per-request* check, which catches
   * things like a misspelled `responseType` on a single call.
   *
   * @default true
   */
  validate?: boolean;

  /**
   * Decompress `gzip`, `deflate`, `br` and `zstd` responses, and advertise support for them
   * via `accept-encoding`.
   *
   * Can only be set on instance create/extend - it composes a dispatcher interceptor.
   *
   * @default true
   */
  decompress?: boolean | DecompressOptions;

  handlers?: HandlerFunction[];

  /**
   * Hooks allow modifications during the request lifecycle.
   * Hook functions may be async and are run serially, in array order.
   *
   * __Note__: hooks are only read from the options a client was created or extended with.
   * Passing `hooks` to a single call has no effect - flattening the arrays once per client
   * is what keeps them off the per-request path.
   **/
  hooks?: Hooks<T>;

  /**
   * Arbitrary per-request data. Shallow-merged over the instance's `context` and reachable
   * from hooks and handlers as `options.context` / `response.request.options.context`.
   */
  context?: Record<string, any>;

  /**
   * Determines if a `HTTPError` is thrown for unsuccessful responses.
   *
   * If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing.
   * This may be useful if you are checking for resource availability and are expecting error responses.
   *
   * @default true
   **/
  throwHttpErrors?: boolean;

  /**
   * You can abort the `request` using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).
   */
  signal?: AbortSignal;

  /**
   * Whether redirect responses should be followed automatically.
   */
  followRedirect?: boolean;

  /**
   * Returns a `Stream` instead of a `Promise`.
   * This is equivalent to calling `gotlike.stream(url, options?)`.
   *
   * @default false
   **/
  isStream?: boolean;

  /**
   * When set to `true` the promise will return the Response body instead of the Response object.
   *
   * @default false
   **/
  resolveBodyOnly?: boolean;

  /**
   * Different from `got`'s `agent` option, single dispatcher is used for all requests.
   *
   * Pass your own dispatcher to do anything the options below don't cover - an
   * `EnvHttpProxyAgent`, a `ProxyAgent`, or an `H2CClient` for cleartext HTTP/2.
   */
  agent?: Dispatcher;

  retry?: Partial<RetryOptions>;

  /** Allow HTTP/2 over TLS, negotiated via ALPN. Cleartext h2c needs an `agent`. */
  http2?: boolean;

  pipelining?: number;

  dnsLookup?: typeof dns.lookup;

  /**
   * Cache DNS lookups per origin, via undici's `dns` interceptor. `true` uses its
   * defaults; an object is passed straight through.
   *
   * A real win for repeated calls to the same handful of hosts, which is the usual
   * shape of talking to a fixed set of upstream APIs.
   */
  dnsCache?: boolean | DnsCacheOptions;

  /** Max connections per origin. undici's default is 6 (`null` for unlimited). */
  connections?: number;

  /** How long an idle socket is kept around, in ms. undici's default is 4s. */
  keepAliveTimeout?: number;

  /** Upper bound for `keepAliveTimeout` when the server sends keep-alive hints, in ms. */
  keepAliveMaxTimeout?: number;

  /** Connection establishment timeout, in ms. undici's default is 10s. */
  connectTimeout?: number;

  /**
   * RFC 9111 response caching, via undici's `cache` interceptor. `true` uses an in-memory
   * store; pass an object to configure it (including a `SqliteCacheStore`).
   */
  cache?: boolean | CacheOptions;

  /**
   * Collapse concurrent identical in-flight requests into one, via undici's `deduplicate`
   * interceptor. Safe methods only (GET by default).
   */
  dedupe?: boolean | DedupeOptions;
};

export type DnsCacheOptions = NonNullable<Parameters<typeof interceptors.dns>[0]>;
export type CacheOptions = NonNullable<Parameters<typeof interceptors.cache>[0]>;
export type DedupeOptions = NonNullable<Parameters<typeof interceptors.deduplicate>[0]>;
export type DecompressOptions = NonNullable<Parameters<typeof interceptors.decompress>[0]>;

/**
 * Re-runs the request the hook fired for, with `newOptions` merged over the options it was
 * sent with (`headers` and `context` are shallow-merged, everything else is replaced).
 * Returning its result from an `afterResponse` hook is how got-style token refresh works.
 */
export type RetryWithMergedOptions<T = any> = (newOptions: RequestOptions<T>) => Promise<Response<T>>;

/** The outgoing request for a redirect hop. `headers` is mutable. */
/** Methods that can carry a request body, and so get a writable stream half. */
export type BodyMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RedirectRequest = {
  origin: string;
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
};

export type Hooks<T = any> = {
  /** Run after options are formed and the body is serialised; may mutate `options`. */
  beforeRequest?: ((options: FormedOptions) => void | Promise<void>)[];
  /**
   * Run before `throwHttpErrors` is applied, so error statuses are visible here.
   * Must return a response - either the one it was given, or `retryWithMergedOptions(...)`.
   */
  afterResponse?: ((
    response: Response<T>,
    retryWithMergedOptions: RetryWithMergedOptions<T>,
  ) => Response<T> | Promise<Response<T>>)[];
  /** Run before a `RequestError` is thrown; return an error to replace it. */
  beforeError?: ((error: RequestError) => Error | Promise<Error>)[];

  /**
   * Run before a redirect is followed, with the outgoing request and the response that
   * caused it. Mutating `request.headers` changes the redirected request - which is the
   * point: undici strips `authorization` on a cross-origin redirect, and this is where you
   * put it back if you mean to.
   *
   * __Note__: like `beforeRetry`, this cannot delay or cancel the redirect. undici follows
   * it from a synchronous dispatch interceptor, so a returned promise is not awaited.
   */
  beforeRedirect?: ((request: RedirectRequest, response: {statusCode: number; headers: IncomingHttpHeaders}) => void)[];

  /**
   * Run when a request is about to be retried, with whatever the failed attempt produced.
   *
   * __Note__: unlike got's, this hook cannot delay or cancel the retry. undici decides to
   * retry inside a synchronous dispatch interceptor, so there is nothing to await on. Use
   * it for logging and metrics; returning a promise from it is not awaited.
   */
  beforeRetry?: ((error: Error | undefined, statusCode: number | undefined, retryCount: number) => void)[];
};

/** Status, headers and timings, available once the response head arrives on a stream. */
export type StreamHead = {
  statusCode: number;
  ok: boolean;
  headers: IncomingHttpHeaders;
  url: string | URL;
  timings: {
    phases: {
      /** Time to the response head. The body is still streaming at this point. */
      total: number;
    };
  };
};

/**
 * The response body, plus the head.
 *
 * A request with no body of its own gets the underlying response stream unwrapped - there is
 * nothing to write to a GET, and wrapping it in a duplex costs about 10% of stream
 * throughput for a writable half nobody can use. Methods that *can* carry a body get a
 * `GotlikeUploadStream`, which is a `Duplex`; see the `stream()` overloads.
 */
export type GotlikeStream = Readable & {
  /**
   * Resolves once the response head arrives, rejects if the request fails before that.
   * The same information is emitted as a `response` event.
   */
  response: Promise<StreamHead>;
};

/** A `stream()` for a method that can carry a body: write the request body to it. */
export type GotlikeUploadStream = GotlikeStream & Duplex;

export type Response<T = any> = {
  body: T; // todo: make response type tagged union based on responseType
  headers: IncomingHttpHeaders;
  readonly url: string | URL;
  statusCode: number;
  /** Whether `statusCode` is in the 2xx range. */
  ok: boolean;
  /**
   * The response body as a `Buffer`.
   *
   * Computed on first access rather than eagerly: text and JSON responses are read with
   * undici's optimised `body.text()`, and materialising a Buffer for every request just in
   * case would cost more than it's worth. For a `buffer` responseType this is the body
   * itself; otherwise it's the decoded text re-encoded as UTF-8.
   */
  readonly rawBody: Buffer;
  /** How many times the request was retried. Always 0 unless `retry` is configured. */
  retryCount: number;
  timings: {
    phases: {
      total: number;
    };
  };
  /** Back-reference to the request, so hooks can reach `response.request.options.context`. */
  request: {
    options: FormedOptions;
  };
};

/**
 * Responses are class instances, not object literals, for one measured reason: a getter in an
 * object literal is installed per object, which cost ~190ns per response against ~7ns for a
 * class whose getter sits on the prototype. `rawBody` is still only computed when read.
 */
class GotlikeResponse<T> implements Response<T> {
  body: T;
  headers: IncomingHttpHeaders;
  statusCode: number;
  ok: boolean;
  retryCount: number;
  timings: {phases: {total: number}};
  request: {options: FormedOptions};

  #rawBody?: Buffer;

  constructor(
    body: T,
    headers: IncomingHttpHeaders,
    statusCode: number,
    retryCount: number,
    total: number,
    options: FormedOptions,
  ) {
    this.body = body;
    this.headers = headers;
    this.statusCode = statusCode;
    this.ok = isOk(statusCode);
    this.retryCount = retryCount;
    this.timings = {phases: {total}};
    this.request = {options};
  }

  get url(): string | URL {
    return this.request.options.url as string | URL;
  }

  get rawBody(): Buffer {
    return (this.#rawBody ??= Buffer.isBuffer(this.body)
      ? this.body
      : Buffer.from(typeof this.body === 'string' ? this.body : (JSON.stringify(this.body) ?? '')));
  }
}

const defaultOptions = {
  throwHttpErrors: true,
  followRedirect: false,
  headers: {},
  responseType: 'text',
  method: 'GET',
} satisfies RequestOptions;

const responseTypes = ['text', 'json', 'buffer'];
const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

/**
 * Options that only mean anything when a client is built. Passing one per request is
 * rejected rather than ignored - a silently dropped `hooks` is very hard to notice.
 *
 * A Set, not an array: this is consulted once per option on every validated request.
 */
const clientOnlyOptions = new Set<keyof RequestOptions>([
  'agent',
  'retry',
  'http2',
  'pipelining',
  'dnsLookup',
  'dnsCache',
  'connections',
  'keepAliveTimeout',
  'keepAliveMaxTimeout',
  'connectTimeout',
  'cache',
  'dedupe',
  'decompress',
  'handlers',
  'hooks',
  // `validate` is read from the instance, so a per-request value would do nothing.
  'validate',
]);

/** Agent-level options: any of these present means building a dedicated dispatcher. */
const agentOptions = [
  'http2',
  'pipelining',
  'dnsLookup',
  'connections',
  'keepAliveTimeout',
  'keepAliveMaxTimeout',
  'connectTimeout',
] as const satisfies readonly (keyof RequestOptions)[];

/**
 * Every option name, as a map rather than a list so `satisfies` can check it against
 * `RequestOptions`. Adding an option to the type without adding it here is a compile error,
 * which is the only thing keeping the two from drifting apart.
 */
const knownOptionMap = {
  url: true,
  headers: true,
  prefixUrl: true,
  username: true,
  password: true,
  timeout: true,
  method: true,
  json: true,
  body: true,
  form: true,
  searchParams: true,
  responseType: true,
  throwHttpErrors: true,
  signal: true,
  followRedirect: true,
  isStream: true,
  resolveBodyOnly: true,
  context: true,
  validate: true,
  agent: true,
  retry: true,
  http2: true,
  pipelining: true,
  dnsLookup: true,
  dnsCache: true,
  connections: true,
  keepAliveTimeout: true,
  keepAliveMaxTimeout: true,
  connectTimeout: true,
  cache: true,
  dedupe: true,
  decompress: true,
  handlers: true,
  hooks: true,
} satisfies Record<keyof RequestOptions, true>;

const knownOptions = new Set(Object.keys(knownOptionMap));

export class ValidationError extends Error {
  override name = 'ValidationError';
}

function invalid(message: string): never {
  throw new ValidationError(message);
}

/**
 * Catches the option mistakes that otherwise fail confusingly much later - a misspelled
 * `responseType`, `timeout: 5000` instead of `timeout: {request: 5000}`, a client-only
 * option passed per request and silently ignored.
 *
 * `atCreation` distinguishes the two call sites: `hooks` and `retry` are meaningful on a
 * client but inert on a single call, and saying so beats being quietly ignored.
 */
export function validateOptions(options: RequestOptions, atCreation: boolean): void {
  for (const key in options) {
    if (!knownOptions.has(key)) {
      invalid(`Unknown option \`${key}\``);
    }

    if (
      !atCreation &&
      clientOnlyOptions.has(key as keyof RequestOptions) &&
      options[key as keyof RequestOptions] !== undefined
    ) {
      invalid(`\`${key}\` can only be set when creating or extending a client, not per request`);
    }
  }

  const {responseType, method, timeout, headers, searchParams, form, prefixUrl, retry, hooks} = options;

  if (responseType !== undefined && !responseTypes.includes(responseType)) {
    invalid(`\`responseType\` must be one of ${responseTypes.join(', ')}, got \`${String(responseType)}\``);
  }

  if (method !== undefined && !httpMethods.includes(method)) {
    invalid(`\`method\` must be a valid HTTP method, got \`${String(method)}\``);
  }

  if (timeout !== undefined) {
    if (typeof timeout !== 'object' || timeout === null) {
      invalid('`timeout` must be an object like `{request: 5000}`');
    }

    if (timeout.request !== undefined && (typeof timeout.request !== 'number' || timeout.request < 0)) {
      invalid('`timeout.request` must be a non-negative number of milliseconds');
    }
  }

  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
    invalid('`headers` must be an object');
  }

  if (prefixUrl !== undefined && typeof prefixUrl !== 'string') {
    invalid('`prefixUrl` must be a string');
  }

  if (
    searchParams !== undefined &&
    typeof searchParams !== 'string' &&
    !(searchParams instanceof URLSearchParams) &&
    (typeof searchParams !== 'object' || searchParams === null)
  ) {
    invalid('`searchParams` must be a string, URLSearchParams or a plain object');
  }

  if (form !== undefined && !(form instanceof URLSearchParams) && (typeof form !== 'object' || form === null)) {
    invalid('`form` must be a URLSearchParams or a plain object');
  }

  if (retry !== undefined && (typeof retry !== 'object' || retry === null)) {
    invalid('`retry` must be an object like `{limit: 2}`');
  }

  if (hooks !== undefined) {
    if (typeof hooks !== 'object' || hooks === null) {
      invalid('`hooks` must be an object');
    }

    for (const name of hookNames) {
      const hook = hooks[name];

      if (hook !== undefined && !Array.isArray(hook)) {
        invalid(`\`hooks.${name}\` must be an array of functions`);
      }
    }
  }
}

export class Gotlike {
  baseOptions?: RequestOptions;

  /** Explicit dispatcher for this client, if one was built or passed in. */
  ownAgent?: Dispatcher;

  /** Per-request retry defaults, applied through the composed `retry` interceptor. */
  retryOptions?: RetryHandlerOptions;

  /**
   * The instance's headers, with `accept-encoding` already folded in. Precomputing it here
   * saves a case-insensitive header scan and an assignment on every request; a per-call
   * `accept-encoding` still wins, because call options are spread over these.
   */
  defaultHeaders: IncomingHttpHeaders;

  /**
   * Whether the redirect interceptor is composed. Opt-in rather than opt-out: undici allocates
   * a `RedirectHandler` on every request once it is in the chain, which measured at roughly
   * 80% of this client's total per-request overhead.
   */
  followsRedirects: boolean;

  /** Whether per-request options are validated. Client options always are. */
  validate: boolean;

  /** Whether the composed chain decompresses. Instance-level, so `call()` can't disagree. */
  decompress: boolean;

  decompressOptions?: DecompressOptions;

  /**
   * Hooks flattened out of `baseOptions` once, so `call()` only has to check for a
   * non-empty array instead of walking an options object per request.
   */
  beforeRequestHooks?: NonNullable<Hooks['beforeRequest']>;
  afterResponseHooks?: NonNullable<Hooks['afterResponse']>;
  beforeErrorHooks?: NonNullable<Hooks['beforeError']>;
  beforeRetryHooks?: NonNullable<Hooks['beforeRetry']>;
  beforeRedirectHooks?: NonNullable<Hooks['beforeRedirect']>;

  /** Memoised interceptor chain, together with the base dispatcher it was composed from. */
  #composedFrom?: Dispatcher;
  #composed?: Dispatcher;

  constructor(options?: RequestOptions) {
    if (options) {
      validateOptions(options, true);
    }

    this.baseOptions = options;
    this.followsRedirects = options?.followRedirect === true;
    this.validate = options?.validate !== false;
    this.decompress = options?.decompress !== false;

    this.defaultHeaders = options?.headers ? {...options.headers} : {};

    // undici's decompress interceptor acts on the response's content-encoding but never asks
    // for one, so support has to be advertised here.
    if (this.decompress && !hasHeader(this.defaultHeaders, 'accept-encoding')) {
      this.defaultHeaders['accept-encoding'] = acceptEncoding;
    }

    if (this.decompress) {
      this.decompressOptions = {
        // undici skips error responses by default. got decompresses them, and so must we:
        // a gzipped error body is exactly what error handling needs to read.
        skipErrorResponses: false,
        ...(typeof options?.decompress === 'object' ? options.decompress : undefined),
      };
    }

    // Left undefined when empty, so `call()` only has to check for a truthy field.
    this.beforeRequestHooks = usedHooks(options?.hooks?.beforeRequest);
    this.afterResponseHooks = usedHooks(options?.hooks?.afterResponse);
    this.beforeErrorHooks = usedHooks(options?.hooks?.beforeError);
    this.beforeRetryHooks = usedHooks(options?.hooks?.beforeRetry);
    this.beforeRedirectHooks = usedHooks(options?.hooks?.beforeRedirect);

    if (options?.agent) {
      this.ownAgent = options.agent;
    } else if (options && agentOptions.some((key) => options[key] !== undefined)) {
      this.ownAgent = new undici.Agent({
        allowH2: options.http2,
        pipelining: options.pipelining,
        connections: options.connections,
        keepAliveTimeout: options.keepAliveTimeout,
        keepAliveMaxTimeout: options.keepAliveMaxTimeout,
        connectTimeout: options.connectTimeout,
        connect: options.dnsLookup
          ? {
              lookup: options.dnsLookup,
            }
          : undefined,
      });
    }

    // `retry: {limit: 0}` is how callers disable retries; composing a RetryHandler that
    // will never retry just costs a handler allocation per request, so skip it entirely.
    if (options?.retry && options.retry.limit !== 0) {
      this.retryOptions = {
        methods: options.retry.methods,
        statusCodes: options.retry.statusCodes,
        errorCodes: options.retry.errorCodes,
        maxRetries: options.retry.limit,
        maxTimeout: options.retry.backoffLimit,
        retryAfter: !!options.retry.maxRetryAfter,
        // got resolves an exhausted retry to the last response; undici's handler
        // throws a RequestRetryError instead unless we opt out.
        throwOnError: false,
      };
    }
  }

  /**
   * The dispatcher requests are actually sent through.
   *
   * undici 8 moved redirect and retry handling out of the request options and into
   * dispatcher interceptors, so they have to be composed onto a dispatcher up front.
   * We resolve the base dispatcher lazily so that a `setGlobalDispatcher` call made
   * after the client was constructed (which is exactly what `./nock` does) is still
   * picked up, and memoise the composition so the interceptor chain is built once per
   * base dispatcher rather than once per request.
   */
  get agent(): Dispatcher {
    const base = this.ownAgent ?? getGlobalDispatcher();

    if (this.#composedFrom !== base) {
      const options = this.baseOptions;
      const chain: Dispatcher.DispatcherComposeInterceptor[] = [];

      // Resolve first, so everything downstream talks to a cached address.
      if (options?.dnsCache) {
        chain.push(interceptors.dns(options.dnsCache === true ? undefined : options.dnsCache));
      }

      // Skipped entirely when the client never follows redirects: the interceptor
      // rest-spreads the dispatch options on every request before it can bail out.
      if (this.followsRedirects) {
        // Must sit before `redirect` in the array: compose() wraps in order, so an earlier
        // entry ends up inside, and only something inside is re-entered per hop.
        if (this.beforeRedirectHooks) {
          chain.push(makeRedirectTracker(this.beforeRedirectHooks));
        }

        chain.push(interceptors.redirect());
      }

      if (options?.dedupe) {
        chain.push(interceptors.deduplicate(options.dedupe === true ? undefined : options.dedupe));
      }

      if (options?.cache) {
        chain.push(interceptors.cache(options.cache === true ? undefined : options.cache));
      }

      if (this.decompress) {
        chain.push(interceptors.decompress(this.decompressOptions));
      }

      if (this.retryOptions) {
        chain.push(countAttempts, interceptors.retry(this.retryOptions));
      }

      this.#composedFrom = base;
      this.#composed = chain.length > 0 ? base.compose(chain) : base;
    }

    return this.#composed as Dispatcher;
  }

  /**
   * Merge the instance defaults with the per-call options.
   *
   * One spread plus two conditional sub-merges, into a fresh object. got walks a
   * per-option merge table on every request; we can get away with a shallow spread
   * because every option that would need deeper merging (`hooks`, `handlers`, `retry`,
   * `agent`, ...) is resolved at create/extend time instead.
   *
   * The result is always a new object, so a caller can safely reuse the options object
   * it passes in - `call()` and the `beforeRequest` hooks mutate what they're given.
   */
  formOptions(options: RequestOptions, url?: string | URL, method?: Dispatcher.HttpMethod): FormedOptions {
    if (this.validate) {
      validateOptions(options, false);

      // Turning redirects *on* means composing an interceptor, which is a create/extend-time
      // decision - a per-request `true` would otherwise be silently ignored. Turning them off
      // per request is fine, and just sets `maxRedirections: 0`.
      if (options.followRedirect && !this.followsRedirects) {
        invalid('`followRedirect: true` can only be set when creating or extending a client');
      }
    }

    const base = this.baseOptions;
    const formed = (base ? {...base, ...options} : {...options}) as FormedOptions;

    // Always a fresh object: handlers and `beforeRequest` hooks routinely write to
    // `options.headers`, and the instance defaults must not pick those up.
    formed.headers = {...this.defaultHeaders, ...options.headers};

    if (base?.context && options.context) {
      formed.context = {...base.context, ...options.context};
    } else if (formed.context === undefined) {
      // Shared and frozen: `options.context.foo` should read as undefined rather than
      // throw when no context was set, without allocating an object per request. Frozen
      // so that a hook writing to it fails loudly instead of leaking across requests.
      formed.context = emptyContext;
    }

    if (url !== undefined) {
      formed.url = url;
    }

    if (method !== undefined) {
      formed.method = method;
    }

    return formed;
  }

  handle<T>(options: RequestOptions = {}, url?: string | URL, method?: Dispatcher.HttpMethod): Promise<Response<T>> {
    let formed: FormedOptions;

    // A synchronous throw out of a promise-returning method escapes `.catch()`, so a bad
    // option surfaces as a rejection like every other failure. Construction still throws
    // synchronously - `new Gotlike(...)` isn't async.
    try {
      formed = this.formOptions(options, url, method);
    } catch (error) {
      return Promise.reject(error);
    }

    // handler merging only supported during client create or extend
    const handlers = formed.handlers;

    let result: Promise<Response<T>>;

    if (handlers) {
      let iteration = 0;

      const iterateHandlers = (newOptions: FormedOptions) => {
        const handler = handlers[iteration++] ?? this.call.bind(this);

        return handler(newOptions, iterateHandlers);
      };

      result = iterateHandlers(formed) as Promise<Response<T>>;
    } else {
      result = this.call<T>(formed);
    }

    // Unwrapped out here rather than in `call()` so that handlers and `afterResponse` hooks
    // always see a full Response. Unwrapping earlier means a handler doing
    // `response.timings` blows up whenever a caller asks for `resolveBodyOnly`.
    if (formed.resolveBodyOnly && !formed.isStream) {
      return result.then((response) => response.body) as Promise<Response<T>>;
    }

    return result;
  }

  /**
   * Join `prefixUrl` and `url` the way got does: the prefix keeps at most one trailing
   * slash and the path never contributes a leading one, so neither side can produce the
   * `//` that plain concatenation used to.
   */
  /**
   * The options every dispatch shares. `call()`, `callBodylessStream()` and `callStream()`
   * built this same literal three times over, which is three places to forget a field.
   */
  dispatchOptions(options: FormedOptions): SharedDispatchOptions {
    return {
      dispatcher: this.agent,
      headers: options.headers,
      method: options.method,
      bodyTimeout: options.timeout?.request,
      headersTimeout: options.timeout?.request,
      signal: options.signal,
      maxRedirections: options.followRedirect ? 10 : 0,
      redirects: this.beforeRedirectHooks ? {count: 0} : undefined,
    };
  }

  resolveUrl(options: FormedOptions): string {
    const url = options.url === undefined ? '' : String(options.url);

    // An absolute url wins over the prefix. got would refuse the combination outright;
    // silently concatenating the two is the worse failure mode, since callers do mix
    // absolute urls and prefixed clients.
    const joined =
      !options.prefixUrl || absoluteUrl.test(url)
        ? url
        : (options.prefixUrl.endsWith('/') ? options.prefixUrl : options.prefixUrl + '/') +
          (url.startsWith('/') ? url.slice(1) : url);

    if (options.searchParams === undefined) {
      return joined;
    }

    const search = stringifyQuery(options.searchParams);
    const existing = joined.indexOf('?');

    // got's `searchParams` replaces the url's own query rather than merging into it.
    const withoutQuery = existing === -1 ? joined : joined.slice(0, existing);

    return search ? withoutQuery + '?' + search : withoutQuery;
  }

  /**
   * Build the `RequestError` for a failure, giving `beforeError` hooks a chance to replace
   * it. Hooks may return any error; anything that isn't an `Error` is ignored.
   */
  async toRequestError(
    message: string,
    code: string,
    cause: Partial<Error> | undefined,
    options: FormedOptions,
    response?: Response<any>,
    ErrorClass: typeof RequestError = RequestError,
  ): Promise<Error> {
    let error: Error = new ErrorClass(message, code, cause, options, response);

    if (this.beforeErrorHooks) {
      for (const hook of this.beforeErrorHooks) {
        const replacement = await hook(error as RequestError);

        if (replacement instanceof Error) {
          error = replacement;
        }
      }
    }

    return error;
  }

  async call<T = unknown>(options: FormedOptions): Promise<Response<T>> {
    let undiciResponse;
    let responseBody;
    let startTime;
    let attempts: AttemptState | undefined;
    let parseFailed = false;

    // The resolved URL is what hooks and handlers should see and what request signing
    // needs, so write it back before anything gets a look at the options.
    const url = (options.url = this.resolveUrl(options));

    // Serialise up front so `beforeRequest` hooks can read and re-sign `options.body`
    // regardless of whether the caller passed `json` or `body`.
    if (options.json !== undefined) {
      options.body = JSON.stringify(options.json);

      // Case-insensitive: undici would otherwise send both a caller's `Content-Type` and
      // the one we add, and the header the server picks is anyone's guess.
      if (!hasHeader(options.headers, 'content-type')) {
        options.headers['content-type'] = 'application/json';
      }
    } else if (options.form !== undefined) {
      options.body = stringifyQuery(options.form);

      if (!hasHeader(options.headers, 'content-type')) {
        options.headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }

    if (
      (options.username !== undefined || options.password !== undefined) &&
      !hasHeader(options.headers, 'authorization')
    ) {
      const credentials = `${options.username ?? ''}:${options.password ?? ''}`;

      options.headers['authorization'] = 'Basic ' + Buffer.from(credentials).toString('base64');
    }

    if (this.beforeRequestHooks) {
      for (const hook of this.beforeRequestHooks) {
        await hook(options);
      }
    }

    // make request
    try {
      const body = options.body;

      if (options.isStream) {
        const hasBody = options.body !== undefined && options.body !== null;
        const stream =
          !hasBody && (options.method === 'GET' || options.method === 'HEAD')
            ? await this.callBodylessStream(options)
            : this.callStream(options);

        return stream as unknown as Response<T>;
      }

      startTime = process.hrtime();

      // Only allocated for clients that actually retry; everyone else reports 0.
      attempts = this.retryOptions
        ? {
            count: 0,
            onRetry:
              this.beforeRetryHooks &&
              ((error, statusCode, retryCount) => {
                for (const hook of this.beforeRetryHooks!) {
                  hook(error, statusCode, retryCount);
                }
              }),
          }
        : undefined;

      const requestOptions: UndiciRequestOptions = {
        ...this.dispatchOptions(options),
        attempts,
        body,
      };

      undiciResponse = await undici.request(url, requestOptions);

      if (hasNoBody(undiciResponse.statusCode, options.method)) {
        // 204/205/304 and HEAD cannot carry a body, so there is nothing to parse. Attempting
        // it anyway turned every empty 204 into a parse failure.
        await undiciResponse.body.dump();

        responseBody =
          options.responseType === 'json' ? undefined : options.responseType === 'buffer' ? Buffer.alloc(0) : '';
      } else if (options.responseType === 'json') {
        const text = await undiciResponse.body.text();

        // Keep the raw text reachable: it is what `error.response.body` should show.
        responseBody = text;

        try {
          responseBody = JSON.parse(text);
        } catch (error) {
          // Flagged rather than recognised by message. V8 words this differently depending
          // on the input ("Unexpected end of JSON input" vs "... is not valid JSON"), and
          // matching on the wording misfiled empty bodies as generic request errors.
          parseFailed = true;

          throw error;
        }
      } else if (options.responseType === 'text') {
        responseBody = await undiciResponse.body.text();
      } else {
        // A Node Buffer, not the ArrayBuffer undici hands back - callers pass this
        // straight into things like `sharp()` that only accept Buffers.
        responseBody = Buffer.from(await undiciResponse.body.arrayBuffer());
      }
    } catch (err) {
      // A retry that ran out of attempts carries the last response on the error itself.
      if (err instanceof RequestRetryError) {
        undiciResponse = {
          statusCode: err.statusCode,
          headers: err.headers as IncomingHttpHeaders,
        };
      }

      // `responseBody` holds the raw text when JSON parsing is what failed, and is
      // undefined otherwise - either way it is what the caller wants to inspect.
      const response =
        undiciResponse &&
        new GotlikeResponse<any>(
          responseBody,
          undiciResponse.headers,
          undiciResponse.statusCode,
          retriesFrom(attempts),
          elapsedMs(startTime),
          options,
        );

      if (err instanceof HeadersTimeoutError || err instanceof BodyTimeoutError) {
        throw await this.toRequestError(err.message, 'ETIMEDOUT', err, options, response, TimeoutError);
      }

      if (parseFailed) {
        throw await this.toRequestError(
          (err as Error).message,
          'ERR_BODY_PARSE_FAILURE',
          err as Error,
          options,
          response,
          ParseError,
        );
      }

      // A signal reports its reason as a DOMException: `AbortError` from `abort()`, and
      // `TimeoutError` from `AbortSignal.timeout()`. The latter is a timeout by any useful
      // definition, so it lands on the same class and code as `timeout.request`.
      if ((err as Error)?.name === 'AbortError') {
        throw await this.toRequestError(
          (err as Error).message,
          'ERR_ABORTED',
          err as Error,
          options,
          response,
          AbortError,
        );
      }

      if ((err as Error)?.name === 'TimeoutError') {
        throw await this.toRequestError(
          (err as Error).message,
          'ETIMEDOUT',
          err as Error,
          options,
          response,
          TimeoutError,
        );
      }

      throw await this.toRequestError('Request error', 'ERR_REQUEST_ERROR', err as Error, options, response);
    }

    let response: Response<T> = new GotlikeResponse<T>(
      responseBody as T,
      undiciResponse.headers,
      undiciResponse.statusCode,
      retriesFrom(attempts),
      elapsedMs(startTime),
      options,
    );

    // Runs before `throwHttpErrors` on purpose: got-style token refresh hooks need to see
    // the 401 that triggers them.
    if (this.afterResponseHooks) {
      for (const hook of this.afterResponseHooks) {
        response = await hook(response, (newOptions) => this.retryWithMergedOptions<T>(options, newOptions));
      }
    }

    if (options.throwHttpErrors && isHttpError(response.statusCode)) {
      throw await this.toRequestError(
        `Response code ${response.statusCode}`,
        'ERR_HTTP_ERROR',
        undefined,
        options,
        response,
        HTTPError,
      );
    }

    return response;
  }

  /**
   * Streaming without a request body.
   *
   * `undici.pipeline` makes the duplex's writable side the request body, and `RedirectHandler`
   * refuses to follow a redirect whose body it cannot replay - so a piped GET silently returns
   * the 302 itself instead of the thing it points at. Requests that have no body to replay go
   * through `undici.request` instead, where redirects work normally, and the response stream is
   * presented as a duplex with an inert writable half.
   */
  async callBodylessStream(options: FormedOptions): Promise<GotlikeStream> {
    const startTime = process.hrtime();

    let undiciResponse;

    try {
      undiciResponse = await undici.request(options.url as string, this.dispatchOptions(options));
    } catch (error) {
      // Reported through the duplex rather than by rejecting `stream()`, so that both
      // stream paths fail the same way whatever the caller is listening on.
      return asStream(Readable.from([]), undefined, error as Error);
    }

    const streamHead: StreamHead = {
      statusCode: undiciResponse.statusCode,
      ok: isOk(undiciResponse.statusCode),
      headers: undiciResponse.headers,
      url: options.url as string | URL,
      timings: {
        phases: {
          total: elapsedMs(startTime),
        },
      },
    };

    const failed = options.throwHttpErrors && isHttpError(undiciResponse.statusCode);

    if (failed) {
      // The body is being replaced by the error, so let undici reclaim the socket.
      undiciResponse.body.dump().catch(() => undefined);
    }

    return asStream(
      undiciResponse.body,
      streamHead,
      failed
        ? new HTTPError(`Response code ${streamHead.statusCode}`, 'ERR_HTTP_ERROR', undefined, options)
        : undefined,
    );
  }

  /**
   * Streaming *with* a request body. Returns the duplex synchronously so it can be piped
   * straight away; the head arrives later, on the `response` event and promise.
   *
   * Assumes `call()` has already resolved the url, serialised the body and run the
   * `beforeRequest` hooks - it is only ever reached from there.
   */
  callStream(options: FormedOptions): GotlikeUploadStream {
    const startTime = process.hrtime();

    let resolveHead: (head: StreamHead) => void;
    let rejectHead: (error: Error) => void;

    const head = new Promise<StreamHead>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });

    // Nothing may await this promise, and an unhandled rejection would take the process
    // down; the same failure is always reported on the stream's `error` event too.
    head.catch(() => undefined);

    const duplex = undici.pipeline(
      options.url as string,
      this.dispatchOptions(options),
      ({statusCode, headers, body}) => {
        const streamHead: StreamHead = {
          statusCode,
          ok: isOk(statusCode),
          headers,
          url: options.url as string | URL,
          timings: {
            phases: {
              total: elapsedMs(startTime),
            },
          },
        };

        resolveHead(streamHead);
        duplex.emit('response', streamHead);

        if (options.throwHttpErrors && isHttpError(statusCode)) {
          // Destroying from inside the handler surfaces on the duplex's `error` event.
          throw new HTTPError(`Response code ${statusCode}`, 'ERR_HTTP_ERROR', undefined, options);
        }

        return body;
      },
    ) as unknown as GotlikeUploadStream;

    duplex.on('error', (error: Error) => rejectHead(error));

    // `undici.pipeline` takes the request body from the duplex's writable side, not from
    // `opts.body` - so a body supplied through the options has to be written here. Methods
    // that never carry a body are ended straight away; anything else is left open for the
    // caller to write to and end themselves.
    if (options.body !== undefined && options.body !== null) {
      duplex.end(options.body);
    } else if (options.method === 'GET' || options.method === 'HEAD') {
      duplex.end();
    }

    duplex.response = head;

    return duplex;
  }

  /**
   * Re-run a request with `newOptions` merged over the options it was sent with. Handed to
   * `afterResponse` hooks so they can refresh credentials and retry.
   *
   * The retry goes straight to `call()`: handlers already ran for this request, and running
   * them again would re-log and re-wrap a request the caller only made once.
   */
  retryWithMergedOptions<T>(options: FormedOptions, newOptions: RequestOptions): Promise<Response<T>> {
    const merged = {...options, ...newOptions} as FormedOptions;

    if (newOptions.headers) {
      merged.headers = {...options.headers, ...newOptions.headers};
    }

    if (newOptions.context) {
      merged.context = {...options.context, ...newOptions.context};
    }

    // `url` was already resolved against `prefixUrl` for the first attempt.
    merged.prefixUrl = undefined;

    return this.call<T>(merged);
  }

  extend(options: RequestOptions) {
    const base = this.baseOptions;

    return new Gotlike({
      ...base,
      ...options,
      headers: mergeRecords(base?.headers, options.headers),
      context: mergeRecords(base?.context, options.context),
      // Handlers and hooks accumulate, so an extended client keeps the parent's.
      handlers: concatHooks(base?.handlers, options.handlers),
      hooks: mergeHooks(base?.hooks, options.hooks),
    });
  }

  /**
   * Request a `Duplex` instead of a parsed response.
   *
   * Unlike got's, this resolves to the stream rather than returning it synchronously - the
   * `beforeRequest` hooks are async, and awaiting them is worth more than the sync return.
   */
  stream(url: string | URL, options: RequestOptions & {method: BodyMethod}): Promise<GotlikeUploadStream>;
  stream(url: string | URL, options?: RequestOptions): Promise<GotlikeStream>;
  stream(url: string | URL, options: RequestOptions = {}): Promise<GotlikeStream> {
    return this.handle({...options, isStream: true}, url) as unknown as Promise<GotlikeStream>;
  }

  get<T>(url: string | URL, options: RequestOptions = {}) {
    return this.handle<T>(options, url, 'GET');
  }

  post<T>(url: string | URL, options: RequestOptions = {}) {
    return this.handle<T>(options, url, 'POST');
  }

  delete<T>(url: string | URL, options: RequestOptions = {}) {
    return this.handle<T>(options, url, 'DELETE');
  }

  put<T>(url: string | URL, options: RequestOptions = {}) {
    return this.handle<T>(options, url, 'PUT');
  }

  patch<T>(url: string | URL, options: RequestOptions = {}) {
    return this.handle<T>(options, url, 'PATCH');
  }
}

/**
 * A client that can also be called directly - `client(url, options)` - the way got's export
 * can, while keeping every method and field of the underlying `Gotlike`.
 */
export type CallableClient = Omit<Gotlike, 'extend'> & {
  <T = unknown>(url: string | URL, options?: RequestOptions): Promise<Response<T>>;
  /**
   * `Gotlike` is `Omit`ted of `extend` above on purpose: an intersection merges call
   * signatures into an overload set, and `Gotlike['extend']` would win and type an extended
   * client as a plain, non-callable `Gotlike`.
   */
  extend(options: RequestOptions): CallableClient;
};

/**
 * Wrap an instance in a callable function.
 *
 * Methods are bound to the instance rather than the function, so `this` inside them is
 * still the real `Gotlike` - which matters because the private `#composed` fields only
 * exist there. Prototype-swapping tricks look neater and break on exactly that.
 *
 * All of this happens once per client; the per-request path is untouched.
 */
function asCallable(instance: Gotlike): CallableClient {
  const callable = function callableClient<T>(url: string | URL, options: RequestOptions = {}) {
    return instance.handle<T>(options, url);
  } as unknown as CallableClient;

  for (const key of Object.getOwnPropertyNames(Gotlike.prototype)) {
    if (key === 'constructor') {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(Gotlike.prototype, key)!;

    if (descriptor.get) {
      Object.defineProperty(callable, key, {get: descriptor.get.bind(instance), configurable: true});
    } else if (typeof descriptor.value === 'function') {
      Object.defineProperty(callable, key, {
        value: descriptor.value.bind(instance),
        writable: true,
        configurable: true,
      });
    }
  }

  // Instance fields (baseOptions, retryOptions, ...) forward to the instance, so reading or
  // writing them through the callable and through the instance stay the same thing.
  for (const key of Object.keys(instance)) {
    Object.defineProperty(callable, key, {
      get: () => instance[key as keyof Gotlike],
      set: (value) => {
        (instance as unknown as Record<string, unknown>)[key] = value;
      },
      enumerable: true,
      configurable: true,
    });
  }

  // An extended client stays callable.
  callable.extend = (options: RequestOptions) => asCallable(instance.extend(options));

  return callable;
}

/** Create a callable client. `new Gotlike(options)` gives the plain, non-callable form. */
export function createClient(options?: RequestOptions): CallableClient {
  return asCallable(new Gotlike(options));
}

/**
 * One instance behind all three names, as got does. Three separate clients would each carry
 * their own headers and interceptor chain, and `got !== gotlike` would be a surprise for
 * anyone configuring or comparing them.
 */
const defaultClient = createClient(defaultOptions);

export default defaultClient;

export const gotlike = defaultClient;

// For easier replacement
export const got = defaultClient;
export type Got = CallableClient;
export type ExtendOptions = RequestOptions;

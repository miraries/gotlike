import dns from 'node:dns';
import zlib from 'node:zlib';
import {Duplex} from 'node:stream';
import undici, {DecoratorHandler, Dispatcher, errors, getGlobalDispatcher, interceptors} from 'undici'
import {IncomingHttpHeaders} from 'undici/types/header';

const {BodyTimeoutError, HeadersTimeoutError, RequestRetryError} = errors;

/**
 * undici's typings don't expose the per-request options that the `redirect` and
 * `retry` interceptors pick off the dispatch options, but both read them at runtime
 * (see lib/interceptor/{redirect,retry}.js). Composing the interceptors once per
 * client and overriding per request is what lets us keep these as request options
 * without rebuilding a dispatcher on every call.
 */
/** Mutable per-request holder: dispatch count plus what the last attempt produced. */
type AttemptState = {
  count: number;
  lastError?: Error;
  lastStatusCode?: number;
  onRetry?: (error: Error | undefined, statusCode: number | undefined, retryCount: number) => void;
};

type InterceptorOptions = {
  maxRedirections?: number;
  retryOptions?: RetryHandlerOptions;
  attempts?: AttemptState;
};

/**
 * Counts how many times a request is dispatched. Composed *inside* the retry interceptor -
 * `compose()` wraps in array order, so an earlier entry sits closer to the socket and is
 * re-entered on every retry, while the retry interceptor itself is only entered once.
 *
 * undici exposes no retry counter of its own (`response.context` is null), and the retry
 * decision callback would mean reimplementing undici's default backoff logic. This is the
 * same information using only public API.
 */
const countAttempts: Dispatcher.DispatcherComposeInterceptor = (dispatch) =>
  function CountAttempts(opts, handler) {
    const state = (opts as InterceptorOptions).attempts!;

    state.count++;

    // Second dispatch onwards means the previous one was retried.
    if (state.count > 1) {
      state.onRetry?.(state.lastError, state.lastStatusCode, state.count - 1);
    }

    return dispatch(opts, new AttemptHandler(handler, state));
  };

/**
 * Records what each attempt produced so the next one can report why it was retried.
 * Pass-through otherwise - `DecoratorHandler` forwards everything it doesn't override.
 */
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

class AttemptHandler extends BaseDecoratorHandler {
  #state: AttemptState;

  constructor(handler: Dispatcher.DispatchHandler, state: AttemptState) {
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
    this.#state.lastError = undefined;

    return super.onResponseStart(controller, statusCode, headers, statusMessage);
  }

  override onResponseError(controller: Dispatcher.DispatchController, error: Error) {
    this.#state.lastError = error;

    return super.onResponseError(controller, error);
  }
}

type RetryHandlerOptions = NonNullable<Parameters<typeof interceptors.retry>[0]>;

type UndiciRequestOptions = NonNullable<Parameters<typeof undici.request>[1]> & InterceptorOptions;
type UndiciPipelineOptions = NonNullable<Parameters<typeof undici.pipeline>[1]> & InterceptorOptions;

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
].filter(Boolean).join(', ');

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

function concatHooks<T>(base?: T[], added?: T[]): T[] | undefined {
  if (!base) {
    return added;
  }

  return added ? [...base, ...added] : base;
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
}

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

  constructor(message: string, code: string, error: Partial<Error> | undefined, options: RequestOptions, response?: Response<T>) {
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

/** Thrown when the body could not be parsed as the requested `responseType`. */
export class ParseError<T = unknown> extends RequestError<T> {
  override name = 'ParseError';
}

export type FormedOptions = RequestOptions & {
  throwHttpErrors: boolean,
  followRedirect: boolean,
  headers: IncomingHttpHeaders,
  responseType: 'text' | 'json' | 'buffer',
  method: Dispatcher.HttpMethod,
  context: Record<string, any>,
};

export type HandlerFunction = (options: FormedOptions, next: (newOptions: FormedOptions) => Promise<Response>) => Promise<Response>;

export type RequestOptions<T = unknown> = {
  /** The URL to request, as a string or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url). */
  url?: string | URL

  /** Request headers. */
  headers?: IncomingHttpHeaders

  /** When specified, `prefixUrl` will be prepended to `url`. */
  prefixUrl?: string

  /** Username for Basic authentication. Sets `authorization` unless one is already set. */
  username?: string

  /** Password for Basic authentication. */
  password?: string

  /**
   * Milliseconds to wait for the server to end the response before aborting the request with `ETIMEDOUT` error (a.k.a. `request` property).
   * By default, there's no timeout.
   *
   * Only `request` property is supported.
   **/
  timeout?: {
    request?: number
  }

  /** The HTTP method used to make the request. */
  method?: Dispatcher.HttpMethod

  /**
   * JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.
   *
   * __Note__: This option is not enumerable and will not be merged with the instance defaults.
   */
  json?: unknown

  body?: string | Buffer | Uint8Array | null

  /** The parsing method. `buffer` resolves to a Node `Buffer`. */
  responseType?: 'text' | 'json' | 'buffer'

  /**
   * Query string to add to the request URL. Overrides any query already present on `url`.
   *
   * Object values are stringified; `null` and `undefined` entries are dropped.
   */
  searchParams?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined>

  /**
   * `application/x-www-form-urlencoded` body. Sets the `Content-Type` header unless one is
   * already set. Takes precedence over `body`, and is itself overridden by `json`.
   */
  form?: Record<string, string | number | boolean | null | undefined> | URLSearchParams

  /**
   * Decompress `gzip`, `deflate`, `br` and `zstd` responses, and advertise support for them
   * via `accept-encoding`.
   *
   * Can only be set on instance create/extend - it composes a dispatcher interceptor.
   *
   * @default true
   */
  decompress?: boolean | DecompressOptions

  handlers?: HandlerFunction[]

  /**
   * Hooks allow modifications during the request lifecycle.
   * Hook functions may be async and are run serially, in array order.
   *
   * __Note__: hooks are only read from the options a client was created or extended with.
   * Passing `hooks` to a single call has no effect - flattening the arrays once per client
   * is what keeps them off the per-request path.
   **/
  hooks?: Hooks<T>

  /**
   * Arbitrary per-request data. Shallow-merged over the instance's `context` and reachable
   * from hooks and handlers as `options.context` / `response.request.options.context`.
   */
  context?: Record<string, any>

  /**
   * Determines if a `HTTPError` is thrown for unsuccessful responses.
   *
   * If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing.
   * This may be useful if you are checking for resource availability and are expecting error responses.
   *
   * @default true
   **/
  throwHttpErrors?: boolean

  /**
   * You can abort the `request` using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).
   */
  signal?: AbortSignal

  /**
   * Whether redirect responses should be followed automatically.
   */
  followRedirect?: boolean

  /**
   * Returns a `Stream` instead of a `Promise`.
   * This is equivalent to calling `gotlike.stream(url, options?)`.
   *
   * @default false
   **/
  isStream?: boolean

  /**
   * When set to `true` the promise will return the Response body instead of the Response object.
   *
   * @default false
   **/
  resolveBodyOnly?: boolean

  /**
   * Different from `got`'s `agent` option, single dispatcher is used for all requests.
   *
   * Pass your own dispatcher to do anything the options below don't cover - an
   * `EnvHttpProxyAgent`, a `ProxyAgent`, or an `H2CClient` for cleartext HTTP/2.
   */
  agent?: Dispatcher

  retry?: Partial<RetryOptions>

  /** Allow HTTP/2 over TLS, negotiated via ALPN. Cleartext h2c needs an `agent`. */
  http2?: boolean

  pipelining?: number

  dnsLookup?: typeof dns.lookup

  /**
   * Cache DNS lookups per origin, via undici's `dns` interceptor. `true` uses its
   * defaults; an object is passed straight through.
   *
   * A real win for repeated calls to the same handful of hosts, which is the usual
   * shape of talking to a fixed set of upstream APIs.
   */
  dnsCache?: boolean | DnsCacheOptions

  /** Max connections per origin. undici's default is 6 (`null` for unlimited). */
  connections?: number

  /** How long an idle socket is kept around, in ms. undici's default is 4s. */
  keepAliveTimeout?: number

  /** Upper bound for `keepAliveTimeout` when the server sends keep-alive hints, in ms. */
  keepAliveMaxTimeout?: number

  /** Connection establishment timeout, in ms. undici's default is 10s. */
  connectTimeout?: number

  /**
   * RFC 9111 response caching, via undici's `cache` interceptor. `true` uses an in-memory
   * store; pass an object to configure it (including a `SqliteCacheStore`).
   */
  cache?: boolean | CacheOptions

  /**
   * Collapse concurrent identical in-flight requests into one, via undici's `deduplicate`
   * interceptor. Safe methods only (GET by default).
   */
  dedupe?: boolean | DedupeOptions
}

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

export type Hooks<T = any> = {
  /** Run after options are formed and the body is serialised; may mutate `options`. */
  beforeRequest?: ((options: FormedOptions) => void | Promise<void>)[]
  /**
   * Run before `throwHttpErrors` is applied, so error statuses are visible here.
   * Must return a response - either the one it was given, or `retryWithMergedOptions(...)`.
   */
  afterResponse?: ((response: Response<T>, retryWithMergedOptions: RetryWithMergedOptions<T>) => Response<T> | Promise<Response<T>>)[]
  /** Run before a `RequestError` is thrown; return an error to replace it. */
  beforeError?: ((error: RequestError) => Error | Promise<Error>)[]

  /**
   * Run when a request is about to be retried, with whatever the failed attempt produced.
   *
   * __Note__: unlike got's, this hook cannot delay or cancel the retry. undici decides to
   * retry inside a synchronous dispatch interceptor, so there is nothing to await on. Use
   * it for logging and metrics; returning a promise from it is not awaited.
   */
  beforeRetry?: ((error: Error | undefined, statusCode: number | undefined, retryCount: number) => void)[]
}

/** Status, headers and timings, available once the response head arrives on a stream. */
export type StreamHead = {
  statusCode: number
  ok: boolean
  headers: IncomingHttpHeaders
  url: string | URL
  timings: {
    phases: {
      /** Time to the response head. The body is still streaming at this point. */
      total: number
    }
  }
};

/**
 * The duplex returned by `stream()`. Write the request body to it (unless `body`/`json`/`form`
 * was supplied, in which case it is already ended), read the response body from it.
 */
export type GotlikeStream = Duplex & {
  /**
   * Resolves once the response head arrives, rejects if the request fails before that.
   * The same information is emitted as a `response` event.
   */
  response: Promise<StreamHead>
};

export type Response<T = any> = {
  body: T // todo: make response type tagged union based on responseType
  headers: IncomingHttpHeaders
  url: string | URL
  statusCode: number
  /** Whether `statusCode` is in the 2xx range. */
  ok: boolean
  /**
   * The response body as a `Buffer`.
   *
   * Computed on first access rather than eagerly: text and JSON responses are read with
   * undici's optimised `body.text()`, and materialising a Buffer for every request just in
   * case would cost more than it's worth. For a `buffer` responseType this is the body
   * itself; otherwise it's the decoded text re-encoded as UTF-8.
   */
  readonly rawBody: Buffer
  /** How many times the request was retried. Always 0 unless `retry` is configured. */
  retryCount: number
  timings: {
    phases: {
      total: number
    }
  }
  /** Back-reference to the request, so hooks can reach `response.request.options.context`. */
  request: {
    options: FormedOptions
  }
}

const defaultOptions = {
  throwHttpErrors: true,
  followRedirect: true,
  headers: {},
  responseType: 'text',
  method: 'GET',
} satisfies RequestOptions;

export class Gotlike {
  baseOptions?: RequestOptions;

  /** Explicit dispatcher for this client, if one was built or passed in. */
  ownAgent?: Dispatcher;

  /** Per-request retry defaults, applied through the composed `retry` interceptor. */
  retryOptions?: RetryHandlerOptions;

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

  /** Memoised interceptor chain, together with the base dispatcher it was composed from. */
  #composedFrom?: Dispatcher;
  #composed?: Dispatcher;

  constructor(options?: RequestOptions) {
    this.baseOptions = options;
    this.decompress = options?.decompress !== false;

    this.decompressOptions = {
      // undici skips error responses by default. got decompresses them, and so must we:
      // a gzipped error body is exactly what error handling needs to read.
      skipErrorResponses: false,
      ...(typeof options?.decompress === 'object' ? options.decompress : undefined),
    };

    // Empty arrays would cost a length check per request for nothing.
    this.beforeRequestHooks = options?.hooks?.beforeRequest?.length ? options.hooks.beforeRequest : undefined;
    this.afterResponseHooks = options?.hooks?.afterResponse?.length ? options.hooks.afterResponse : undefined;
    this.beforeErrorHooks = options?.hooks?.beforeError?.length ? options.hooks.beforeError : undefined;
    this.beforeRetryHooks = options?.hooks?.beforeRetry?.length ? options.hooks.beforeRetry : undefined;

    if (options?.agent) {
      this.ownAgent = options.agent;
    } else if (
      options?.http2 || options?.pipelining !== undefined || options?.dnsLookup ||
      options?.connections !== undefined || options?.keepAliveTimeout !== undefined ||
      options?.keepAliveMaxTimeout !== undefined || options?.connectTimeout !== undefined
    ) {
      this.ownAgent = new undici.Agent({
        allowH2: options.http2,
        pipelining: options.pipelining,
        connections: options.connections,
        keepAliveTimeout: options.keepAliveTimeout,
        keepAliveMaxTimeout: options.keepAliveMaxTimeout,
        connectTimeout: options.connectTimeout,
        connect: options.dnsLookup ? {
          lookup: options.dnsLookup,
        } : undefined,
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
      if (options?.followRedirect !== false) {
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
      this.#composed = chain.length ? base.compose(chain) : base;
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
    const base = this.baseOptions;
    const formed = (base ? {...base, ...options} : {...options}) as FormedOptions;

    // Always a fresh object: handlers and `beforeRequest` hooks routinely write to
    // `options.headers`, and the instance defaults must not pick those up.
    formed.headers = base?.headers ? {...base.headers, ...options.headers} : {...options.headers};

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
    const formed = this.formOptions(options, url, method);

    // handler merging only supported during client create or extend
    const handlers = formed.handlers;

    let result: Promise<Response<T>>;

    if (handlers) {
      let iteration = 0;

      const iterateHandlers = (newOptions: FormedOptions) => {
        const handler = handlers[iteration++] ?? this.call.bind(this);

        return handler(newOptions, iterateHandlers);
      }

      result = iterateHandlers(formed) as Promise<Response<T>>;
    } else {
      result = this.call<T>(formed);
    }

    // Unwrapped out here rather than in `call()` so that handlers and `afterResponse` hooks
    // always see a full Response. Unwrapping earlier means a handler doing
    // `response.timings` blows up whenever a caller asks for `resolveBodyOnly`.
    if (formed.resolveBodyOnly && !formed.isStream) {
      return result.then(response => response.body) as Promise<Response<T>>;
    }

    return result;
  }

  /**
   * Join `prefixUrl` and `url` the way got does: the prefix keeps at most one trailing
   * slash and the path never contributes a leading one, so neither side can produce the
   * `//` that plain concatenation used to.
   */
  resolveUrl(options: FormedOptions): string {
    const url = options.url === undefined ? '' : String(options.url);

    // An absolute url wins over the prefix. got would refuse the combination outright;
    // silently concatenating the two is the worse failure mode, since callers do mix
    // absolute urls and prefixed clients.
    const joined = !options.prefixUrl || absoluteUrl.test(url) ?
      url :
      (options.prefixUrl.endsWith('/') ? options.prefixUrl : options.prefixUrl + '/') +
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

    // The resolved URL is what hooks and handlers should see and what request signing
    // needs, so write it back before anything gets a look at the options.
    const url = options.url = this.resolveUrl(options);

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

    if ((options.username !== undefined || options.password !== undefined) &&
        !hasHeader(options.headers, 'authorization')) {
      const credentials = `${options.username ?? ''}:${options.password ?? ''}`;

      options.headers['authorization'] = 'Basic ' + Buffer.from(credentials).toString('base64');
    }

    // undici's decompress interceptor acts on the response's content-encoding but never
    // asks for one, so advertise support here.
    if (this.decompress && !hasHeader(options.headers, 'accept-encoding')) {
      options.headers['accept-encoding'] = acceptEncoding;
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
        return this.callStream(options) as unknown as Response<T>;
      }

      startTime = process.hrtime();

      // Only allocated for clients that actually retry; everyone else reports 0.
      attempts = this.retryOptions ?
        {
          count: 0,
          onRetry: this.beforeRetryHooks && ((error, statusCode, retryCount) => {
            for (const hook of this.beforeRetryHooks!) {
              hook(error, statusCode, retryCount);
            }
          }),
        } :
        undefined;

      const requestOptions: UndiciRequestOptions = {
        attempts,
        dispatcher: this.agent,
        headers: options.headers,
        body,
        method: options.method,
        bodyTimeout: options?.timeout?.request,
        headersTimeout: options?.timeout?.request,
        signal: options.signal,
        maxRedirections: options.followRedirect ? 10 : 0,
      };

      undiciResponse = await undici.request(url, requestOptions);

      if (options.responseType === 'json') {
        responseBody = await undiciResponse.body.text();
        responseBody = JSON.parse(responseBody);
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
      const response = undiciResponse && this.formResponse<any>(
        responseBody,
        undiciResponse.statusCode,
        undiciResponse.headers,
        options,
        startTime,
        retriesFrom(attempts),
      );

      if (err instanceof HeadersTimeoutError || err instanceof BodyTimeoutError) {
        throw await this.toRequestError(err.message, 'ETIMEDOUT', err, options, response, TimeoutError);
      }

      if (err instanceof SyntaxError && err.message?.endsWith('not valid JSON')) {
        throw await this.toRequestError(err.message, 'ERR_BODY_PARSE_FAILURE', err, options, response, ParseError);
      }

      throw await this.toRequestError('Request error', 'ERR_REQUEST_ERROR', err as Error, options, response);
    }

    let response = this.formResponse<T>(
      responseBody as T,
      undiciResponse.statusCode,
      undiciResponse.headers,
      options,
      startTime,
      retriesFrom(attempts),
    );

    // Runs before `throwHttpErrors` on purpose: got-style token refresh hooks need to see
    // the 401 that triggers them.
    if (this.afterResponseHooks) {
      for (const hook of this.afterResponseHooks) {
        response = await hook(response, (newOptions) => this.retryWithMergedOptions<T>(options, newOptions));
      }
    }

    if (options.throwHttpErrors && (response.statusCode < 200 || response.statusCode >= 400)) {
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
   * The streaming counterpart to `call()`. Returns the duplex synchronously so it can be
   * piped straight away; the response head arrives later, via the `response` event and the
   * `response` promise hung off the duplex.
   *
   * Assumes `call()` has already resolved the url, serialised the body and run the
   * `beforeRequest` hooks - it is only ever reached from there.
   */
  callStream(options: FormedOptions): GotlikeStream {
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

    const pipelineOptions: UndiciPipelineOptions = {
      dispatcher: this.agent,
      headers: options.headers,
      method: options.method,
      bodyTimeout: options?.timeout?.request,
      headersTimeout: options?.timeout?.request,
      signal: options.signal,
      maxRedirections: options.followRedirect ? 10 : 0,
    };

    const duplex = undici.pipeline(options.url as string, pipelineOptions, ({statusCode, headers, body}) => {
      const streamHead: StreamHead = {
        statusCode,
        ok: statusCode >= 200 && statusCode < 300,
        headers,
        url: options.url as string | URL,
        timings: {
          phases: {
            total: hrtimeToMilliseconds(process.hrtime(startTime)),
          },
        },
      };

      resolveHead(streamHead);
      duplex.emit('response', streamHead);

      if (options.throwHttpErrors && (statusCode < 200 || statusCode >= 400)) {
        // Destroying from inside the handler surfaces on the duplex's `error` event.
        throw new HTTPError(`Response code ${statusCode}`, 'ERR_HTTP_ERROR', undefined, options);
      }

      return body;
    }) as GotlikeStream;

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

  formResponse<T>(
    body: T,
    statusCode: number,
    headers: IncomingHttpHeaders,
    options: FormedOptions,
    startTime?: [number, number],
    retryCount = 0,
  ): Response<T> {
    let rawBody: Buffer | undefined;

    return {
      body,
      headers,
      url: options.url as string | URL,
      statusCode,
      ok: statusCode >= 200 && statusCode < 300,
      retryCount,
      get rawBody(): Buffer {
        return rawBody ??= Buffer.isBuffer(body) ?
          body :
          Buffer.from(typeof body === 'string' ? body : JSON.stringify(body) ?? '');
      },
      timings: {
        phases: {
          total: startTime ? hrtimeToMilliseconds(process.hrtime(startTime)) : 0,
        },
      },
      request: {
        options,
      },
    };
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

    const handlers = base?.handlers ?
      [...base.handlers, ...options.handlers ?? []] :
      options.handlers;

    const headers = base?.headers ?
      {...base.headers, ...options.headers} :
      options.headers;

    const context = base?.context ?
      {...base.context, ...options.context} :
      options.context;

    // Hooks concatenate like handlers, so an extended client keeps the parent's.
    const hooks = base?.hooks || options.hooks ?
      {
        beforeRequest: concatHooks(base?.hooks?.beforeRequest, options.hooks?.beforeRequest),
        afterResponse: concatHooks(base?.hooks?.afterResponse, options.hooks?.afterResponse),
        beforeError: concatHooks(base?.hooks?.beforeError, options.hooks?.beforeError),
        beforeRetry: concatHooks(base?.hooks?.beforeRetry, options.hooks?.beforeRetry),
      } :
      undefined;

    return new Gotlike({
      ...base,
      ...options,
      headers,
      handlers,
      context,
      hooks,
    });
  }

  /**
   * Request a `Duplex` instead of a parsed response.
   *
   * Unlike got's, this resolves to the stream rather than returning it synchronously - the
   * `beforeRequest` hooks are async, and awaiting them is worth more than the sync return.
   */
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

export default new Gotlike(defaultOptions);

export const gotlike = new Gotlike(defaultOptions);

// For easier replacement
export const got = new Gotlike(defaultOptions);
export type Got = Gotlike;
export type ExtendOptions = RequestOptions;

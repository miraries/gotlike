import undici, {Dispatcher} from 'undici'
import {IncomingHttpHeaders} from 'undici/types/header';
import type Errors from 'undici/types/errors';

// @ts-expect-error - no types
import {BodyTimeoutError, HeadersTimeoutError} from 'undici/lib/core/errors';

function hrtimeToMilliseconds(hrtime: [number, number]) {
  const seconds = hrtime[0];
  const nanoseconds = hrtime[1];
  return seconds * 1000 + nanoseconds / 1e6;
}

export class RequestError extends Error {
  // input?: string;

  code: string;
  // override stack!: string;
  declare readonly options: RequestOptions;
  readonly response?: Dispatcher.ResponseData;

  // readonly request?: Request;

  constructor(message: string, code: string, error: Partial<Error>, options: RequestOptions, response?: Dispatcher.ResponseData) {
    super(message);
    // Error.captureStackTrace(this, this.constructor);

    this.name = 'RequestError';
    this.code = code ?? 'ERR_GOT_REQUEST_ERROR';
    // this.input = (error as any).input;
    this.response = response;

    this.options = options;
  }
}

type FormedOptions = RequestOptions & {
  throwHttpErrors: boolean,
  followRedirect: boolean,
  headers: IncomingHttpHeaders,
  responseType: 'text' | 'json' | 'buffer',
  method: Dispatcher.HttpMethod,
};

export type HandlerFunction = (options: FormedOptions, next: (newOptions: FormedOptions) => Promise<Response>) => Promise<Response>;

export type RequestOptions<T = unknown> = {
  /** The URL to request, as a string or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url). */
  url?: string | URL

  /** Request headers. */
  headers?: IncomingHttpHeaders

  /** When specified, `prefixUrl` will be prepended to `url`. */
  prefixUrl?: string

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

  /** The parsing method. */
  responseType?: 'text' | 'json' | 'buffer'

  handlers?: HandlerFunction[]

  /**
   * Hooks allow modifications during the request lifecycle.
   * Hook functions may be async and are run serially.
   *
   * Only single function per hook is supported.
   **/
  hooks?: {
    beforeRequest?(options: RequestOptions<T>): void
    afterResponse?(response: Response<T>, options: RequestOptions<T>): void
    beforeError?(error: RequestError): void
  }

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
}

export type Response<T = any> = {
  body: T // todo: make response type tagged unions
  headers: IncomingHttpHeaders
  url: string | URL
  statusCode: number
  timings: {
    phases: {
      total: number
    }
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

  constructor(options?: RequestOptions) {
    this.baseOptions = options;
  }

  handle<T>(options: RequestOptions = {}): Promise<Response<T>> {
    // merge options
    options.method ??= this.baseOptions?.method;
    options.json ??= this.baseOptions?.json;
    options.prefixUrl ??= this.baseOptions?.prefixUrl; // todo: merge this with url
    options.body ??= this.baseOptions?.body;
    options.timeout ??= this.baseOptions?.timeout;
    options.responseType ??= this.baseOptions?.responseType;
    options.throwHttpErrors ??= this.baseOptions?.throwHttpErrors;
    options.followRedirect ??= this.baseOptions?.followRedirect;
    options.resolveBodyOnly ??= this.baseOptions?.resolveBodyOnly;
    options.isStream ??= this.baseOptions?.isStream;

    if (this.baseOptions?.headers && options.headers) {
      options.headers = {
        ...this.baseOptions.headers,
        ...options.headers,
      };
    } else {
      options.headers ??= this.baseOptions?.headers ?? {};
    }

    // handler merging only supported during client create or extend
    options.handlers ??= this.baseOptions?.handlers;

    if (options.handlers) {
      let iteration = 0;

      const iterateHandlers = (newOptions: FormedOptions) => {
        const handler = options.handlers![iteration++] ?? this.call.bind(this);

        return handler(newOptions, iterateHandlers);
      }

      return iterateHandlers(options as FormedOptions);
    }

    return this.call<T>(options as FormedOptions);
  }

  async call<T = unknown>(options: FormedOptions): Promise<Response<T>> {
    let undiciResponse;
    let responseBody;
    let startTime;

    if (this.baseOptions?.hooks?.beforeRequest) {
      this.baseOptions.hooks.beforeRequest(options);
    }

    const url = (options.prefixUrl ? options.prefixUrl + '/' : '') + options.url as string | URL;

    // make request
    try {
      const body = options.json ?
        JSON.stringify(options.json) :
        options.body;

      if (options.isStream) {
        const duplex = undici.pipeline(url, {
          headers: options.headers,
          body: 'zxc',
          method: options.method,
          bodyTimeout: options?.timeout?.request,
          headersTimeout: options?.timeout?.request,
          signal: options.signal,
          maxRedirections: options.followRedirect ? 10 : 0,
          throwOnError: false,
        }, ({ body }) => body);

        if (options.method === 'GET') {
          duplex.end();
        }

        // @ts-ignore - fixme
        return duplex;
      }

      startTime = process.hrtime();

      undiciResponse = await undici.request(url, {
        headers: options.headers,
        body,
        method: options.method,
        bodyTimeout: options?.timeout?.request,
        headersTimeout: options?.timeout?.request,
        throwOnError: false,
        signal: options.signal,
        maxRedirections: options.followRedirect ? 10 : 0,
      });

      if (options.responseType === 'json') {
        responseBody = await undiciResponse.body.json();
      } else if (options.responseType === 'text') {
        responseBody = await undiciResponse.body.text();
      } else {
        responseBody = await undiciResponse.body.arrayBuffer();
      }

    } catch (err) {
      // todo: pass all errors to beforeError hook first
      if (this.baseOptions?.hooks?.beforeError) {
        const requestError = new RequestError(
          'Request error',
          'ERR_REQUEST_ERROR',
          err as Error,
          options,
          undiciResponse,
        );

        this.baseOptions.hooks.beforeError(requestError);
      }

      if (err instanceof HeadersTimeoutError || err instanceof BodyTimeoutError) {
        throw new RequestError(
          (err as Errors.HeadersTimeoutError | Errors.BodyTimeoutError).message,
          'ETIMEDOUT',
          (err as Errors.HeadersTimeoutError | Errors.BodyTimeoutError),
          options,
          undiciResponse,
        );
      }

      if (err instanceof SyntaxError && (err as { message?: string })?.message?.endsWith('not valid JSON')) {
        throw new RequestError(
          err.message,
          'ERR_BODY_PARSE_FAILURE',
          err,
          options,
          undiciResponse,
        );
      }

      throw new RequestError(
        'Request error',
        'ERR_REQUEST_ERROR',
        err as Error,
        options,
        undiciResponse,
      )
    }

    const response = {
      body: responseBody as T,
      headers: undiciResponse.headers,
      url: options.url as string | URL,
      statusCode: undiciResponse.statusCode,
      timings: {
        phases: {
          total: hrtimeToMilliseconds(process.hrtime(startTime))
        }
      }
    };

    if (options.throwHttpErrors && (undiciResponse.statusCode < 200 || undiciResponse.statusCode >= 400)) {
      throw new RequestError(
        `Response code ${undiciResponse?.statusCode}`,
        'ERR_HTTP_ERROR',
        {},
        options,
        undiciResponse,
      );
    }

    if (this.baseOptions?.hooks?.afterResponse) {
      this.baseOptions.hooks.afterResponse(response, options);
    }

    if (options.resolveBodyOnly) {
      // @ts-ignore - fixme
      return response.body;
    }

    return response;
  }

  extend(options: RequestOptions) {
    const handlers = this.baseOptions?.handlers ?
      [...this.baseOptions.handlers, ...options.handlers ?? []] :
      options.handlers;

    const headers = this.baseOptions?.headers ?
      {...this.baseOptions.headers, ...options.headers} :
      options.headers;

    return new Gotlike({
      ...this.baseOptions,
      ...options,
      headers,
      handlers,
    });
  }

  stream<T>(url: string | URL, options: RequestOptions = {}) {
    options.url = url;
    options.isStream = true;

    return this.handle<T>(options);
  }

  get<T>(url: string | URL, options: RequestOptions = {}) {
    options.url = url;
    options.method = 'GET';
    return this.handle<T>(options);
  }

  post<T>(url: string | URL, options: RequestOptions = {}) {
    options.url = url;
    options.method = 'POST';
    return this.handle<T>(options);
  }

  delete<T>(url: string | URL, options: RequestOptions = {}) {
    options.url = url;
    options.method = 'DELETE';
    return this.handle<T>(options);
  }

  put<T>(url: string | URL, options: RequestOptions = {}) {
    options.url = url;
    options.method = 'PUT';
    return this.handle<T>(options);
  }

  patch<T>(url: string | URL, options: RequestOptions = {}) {
    options.url = url;
    options.method = 'PATCH';
    return this.handle<T>(options);
  }
}

export default new Gotlike(defaultOptions);

export const gotlike = new Gotlike(defaultOptions);

// For easier replacement
export const got = new Gotlike(defaultOptions);
export type Got = Gotlike;
export type ExtendOptions = RequestOptions;

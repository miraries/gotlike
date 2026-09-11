import type {Url} from 'node:url';
import {MockAgent, setGlobalDispatcher} from 'undici';
import type {MockInterceptor} from 'undici/types/mock-interceptor.js';
import type {Interceptable} from 'undici';

const mockAgent = new MockAgent();

if (process.env.NOCK_OFF !== 'true') {
  setGlobalDispatcher(mockAgent);
}

/** Pools handed out by `mockAgent.get`, kept so `cleanAll()` can reach them. */
const pools = new Map<string, Interceptable>();

type HeaderMatcher = string | RegExp | ((fieldValue: string) => boolean);
type PathMatcher = string | RegExp | ((path: string) => boolean);
type BodyMatcher = string | RegExp | ((body: string) => boolean);

/** `true` matches any query string, an object matches those exact params. */
type QueryMatcher = boolean | Record<string, any> | URLSearchParams;

export type Options = {
  reqheaders?: Record<string, HeaderMatcher>;
};

export type ReplyHeaders = Record<string, string | string[]>;
export type ReplyBody = string | Buffer | Record<string, any> | unknown[] | null;

/** nock's `this` inside a reply callback. */
type ReplyContext = {
  req: {
    headers: Record<string, string>;
    method: string;
    path: string;
  };
};

/**
 * Exported so an async reply callback can annotate its return: TypeScript infers an array,
 * not a tuple, through `async () => [200, body]`, and contextual typing doesn't reach inside
 * the promise.
 */
export type ReplyFunctionResult = [number, ReplyBody?, ReplyHeaders?];
type ReplyFunction = (
  this: ReplyContext,
  uri: string,
  requestBody: unknown,
) => ReplyFunctionResult | Promise<ReplyFunctionResult>;
type ReplyBodyFunction = (this: ReplyContext, uri: string, requestBody: unknown) => ReplyBody | Promise<ReplyBody>;

/**
 * nock hands reply callbacks a parsed object when the request looked like JSON, and the
 * raw string otherwise.
 */
function parseRequestBody(body: unknown, headers: Record<string, string>): unknown {
  if (typeof body !== 'string' || body === '') {
    return body;
  }

  const contentType = headers['content-type'] ?? headers['Content-Type'];

  if (contentType?.includes('json')) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body;
}

function stripQuery(path: string): string {
  const index = path.indexOf('?');

  return index === -1 ? path : path.slice(0, index);
}

/**
 * Turn a nock path matcher into one undici will accept, accounting for the base path that
 * `nock('https://host/base')` may carry and for `.query(true)`.
 *
 * undici matches a string `path` against the request path *including* its query string, so
 * anything that has to ignore the query becomes a function matcher.
 *
 * `expectedQuery` is only passed when undici can't apply the query itself - it folds `query`
 * into the stored path and compares strings, which it can only do when the path *is* a string.
 * Behind a function matcher the query would otherwise be dropped, and the interceptor would
 * match every query there is.
 */
function buildPathMatcher(
  basePath: string,
  path: PathMatcher,
  ignoreQuery: boolean,
  expectedQuery?: Record<string, any>,
): string | ((path: string) => boolean) {
  if (typeof path === 'string' && !ignoreQuery && !expectedQuery && !basePath) {
    return path;
  }

  if (typeof path === 'string' && !ignoreQuery && !expectedQuery) {
    return basePath + path;
  }

  return (requestPath: string) => {
    if (expectedQuery && !queryMatches(requestPath, expectedQuery)) {
      return false;
    }

    const candidate = ignoreQuery || expectedQuery ? stripQuery(requestPath) : requestPath;

    if (basePath) {
      if (!candidate.startsWith(basePath)) {
        return false;
      }

      // nock matches the interceptor path against what follows the base path.
      return matchPath(path, candidate.slice(basePath.length));
    }

    return matchPath(path, candidate);
  };
}

function matchPath(matcher: PathMatcher, path: string): boolean {
  if (typeof matcher === 'string') {
    return matcher === path;
  }

  if (typeof matcher === 'function') {
    return matcher(path);
  }

  return matcher.test(path);
}

/**
 * Match one expected query value against what arrived. nock allows a RegExp or a function
 * here, and an array for a repeated key - `String(value)` alone turned a RegExp into the
 * literal `"/bar/"` and an array into `"1,2"`, neither of which could ever match.
 */
function queryValueMatches(actual: URLSearchParams, name: string, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    const values = actual.getAll(name);

    return values.length === expected.length && expected.every((item, i) => values[i] === String(item));
  }

  const value = actual.get(name);

  if (value === null) {
    return false;
  }

  if (expected instanceof RegExp) {
    return expected.test(value);
  }

  if (typeof expected === 'function') {
    return Boolean((expected as (v: string) => unknown)(value));
  }

  return value === String(expected);
}

/** nock's default is an exact match: every param the interceptor named, and nothing else. */
function queryMatches(requestPath: string, expected: Record<string, any>): boolean {
  const index = requestPath.indexOf('?');
  const actual = new URLSearchParams(index === -1 ? '' : requestPath.slice(index + 1));
  const names = Object.keys(expected);

  // Counted over entries, so a repeated key is only satisfied by an array expectation of
  // the same length.
  const arrayValues = names.reduce(
    (total, name) => total + (Array.isArray(expected[name]) ? expected[name].length : 1),
    0,
  );

  if (actual.size !== arrayValues) {
    return false;
  }

  return names.every((name) => queryValueMatches(actual, name, expected[name]));
}

/**
 * Whether undici can fold this query into its stored path itself. It serialises values, so a
 * RegExp or a predicate has to be matched by `queryMatches` instead; arrays it handles fine.
 */
function isSerialisableQuery(query?: Record<string, any>): boolean {
  if (!query) {
    return true;
  }

  return Object.values(query).every((value) => !(value instanceof RegExp) && typeof value !== 'function');
}

function queryToObject(query: Record<string, any> | URLSearchParams): Record<string, any> {
  if (query instanceof URLSearchParams) {
    return Object.fromEntries(query.entries());
  }

  return query;
}

class Interceptor {
  #scope: Scope;
  #pool: Interceptable;
  #basePath: string;
  #method: string;
  #path: PathMatcher;
  #body?: BodyMatcher;
  #headers: Record<string, HeaderMatcher>;
  #query?: QueryMatcher;

  /** Recorded before `reply()`, applied to the undici MockScope it produces. */
  #times?: number;
  #persist = false;
  #delay?: number;

  constructor(
    scope: Scope,
    pool: Interceptable,
    basePath: string,
    method: string,
    path: PathMatcher,
    body?: BodyMatcher,
    options?: Options,
  ) {
    this.#scope = scope;
    this.#pool = pool;
    this.#basePath = basePath;
    this.#method = method;
    this.#path = path;
    this.#body = body;
    this.#headers = {...options?.reqheaders};
  }

  query(matcher: QueryMatcher = true): this {
    this.#query = matcher;

    return this;
  }

  matchHeader(name: string, value: HeaderMatcher): this {
    this.#headers[name] = value;

    return this;
  }

  times(count: number): this {
    this.#times = count;

    return this;
  }

  once(): this {
    return this.times(1);
  }

  twice(): this {
    return this.times(2);
  }

  thrice(): this {
    return this.times(3);
  }

  persist(): this {
    this.#persist = true;

    return this;
  }

  delay(ms: number): this {
    this.#delay = ms;

    return this;
  }

  #intercept(): MockInterceptor {
    // Only `.query(true)` needs a query-ignoring matcher.
    const ignoreQuery = this.#query === true;
    const query =
      this.#query !== undefined && this.#query !== true && this.#query !== false
        ? queryToObject(this.#query)
        : undefined;

    // For an object query undici folds the params into the interceptor's path string and
    // compares that, which a function matcher would defeat - so those keep an ordinary string
    // path. It can only do that when the path *is* a string, though: behind the function
    // matcher a regex or function path needs, it drops the query and matches every one of them.
    //
    // It also can only do it for values it can serialise. A RegExp or a predicate value
    // stringifies to nonsense (`"/bar/"`), so those go through `queryMatches` instead.
    const undiciAppliesQuery = typeof this.#path === 'string' && !ignoreQuery && isSerialisableQuery(query);

    const options: MockInterceptor.Options = {
      method: this.#method,
      path: buildPathMatcher(this.#basePath, this.#path, ignoreQuery, undiciAppliesQuery ? undefined : query),
      body: this.#body,
      headers: Object.keys(this.#headers).length > 0 ? this.#headers : undefined,
    };

    if (query && undiciAppliesQuery) {
      options.query = query;
    }

    return this.#pool.intercept(options);
  }

  #applyScopeOptions(mockScope: {times(n: number): any; persist(): any; delay(ms: number): any}): Scope {
    if (this.#times !== undefined) {
      mockScope.times(this.#times);
    }

    if (this.#persist) {
      mockScope.persist();
    }

    if (this.#delay !== undefined) {
      mockScope.delay(this.#delay);
    }

    return this.#scope;
  }

  #context(opts: {method?: string; path: string; headers?: Record<string, string>}): ReplyContext {
    return {
      req: {
        headers: opts.headers ?? {},
        method: opts.method ?? this.#method,
        path: opts.path,
      },
    };
  }

  /** The uri a reply callback sees: path relative to the base path, query included. */
  #uri(path: string): string {
    return this.#basePath && path.startsWith(this.#basePath) ? path.slice(this.#basePath.length) : path;
  }

  reply(responseCode: number, body?: ReplyBody | ReplyBodyFunction, headers?: ReplyHeaders): Scope;
  reply(replyFunction: ReplyFunction): Scope;
  reply(
    responseCodeOrFunction: number | ReplyFunction,
    body?: ReplyBody | ReplyBodyFunction,
    headers?: ReplyHeaders,
  ): Scope {
    const interceptor = this.#intercept();

    // nock's `.reply(function (uri, requestBody) { return [status, body, headers] })`
    if (typeof responseCodeOrFunction === 'function') {
      return this.#replyWith(interceptor, responseCodeOrFunction);
    }

    // nock's `.reply(status, function (uri, requestBody) { return body })` - the same thing
    // with the status and headers already decided.
    if (typeof body === 'function') {
      // `body` narrows to the bare `Function` half of its union, so restate the shape.
      const bodyFunction = body as ReplyBodyFunction;

      return this.#replyWith(interceptor, async function (this: ReplyContext, uri, requestBody) {
        return [responseCodeOrFunction, await bodyFunction.call(this, uri, requestBody), headers];
      });
    }

    return this.#applyScopeOptions(
      interceptor.reply(responseCodeOrFunction, (body ?? '') as any, headers ? {headers: headers as any} : {}),
    );
  }

  /** The single place that builds nock's callback context, parses the body and calls back. */
  #replyWith(interceptor: MockInterceptor, resolve: ReplyFunction): Scope {
    return this.#applyScopeOptions(
      interceptor.reply(async (opts: any) => {
        const context = this.#context(opts);
        const [statusCode, data, replyHeaders] = await resolve.call(
          context,
          this.#uri(opts.path),
          parseRequestBody(opts.body, context.req.headers),
        );

        return {statusCode, data: data ?? '', responseOptions: replyHeaders ? {headers: replyHeaders as any} : {}};
      }),
    );
  }

  replyWithError(error: Error | Record<string, any>): Scope {
    const asError = error instanceof Error ? error : Object.assign(new Error('Mocked error'), error);

    return this.#applyScopeOptions(this.#intercept().replyWithError(asError));
  }
}

class Scope {
  #pool: Interceptable;
  #basePath: string;
  #origin: string;

  /** Set by `persist()`, and inherited by every interceptor registered after it. */
  #persist = false;

  constructor(origin: string, basePath: string) {
    let pool = pools.get(origin);

    if (!pool) {
      pool = mockAgent.get(origin);
      pools.set(origin, pool);
    }

    this.#pool = pool;
    this.#basePath = basePath;
    this.#origin = origin;
  }

  #verb(method: string, path: PathMatcher, body?: BodyMatcher, options?: Options): Interceptor {
    const interceptor = new Interceptor(this, this.#pool, this.#basePath, method, path, body, options);

    return this.#persist ? interceptor.persist() : interceptor;
  }

  /**
   * Replay every interceptor on this scope indefinitely. nock's own docs put `persist()` on the
   * scope - `nock(host).persist().get('/')` - so the per-interceptor form alone isn't enough.
   */
  persist(): this {
    this.#persist = true;

    return this;
  }

  get(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('GET', path, body, options);
  }

  post(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('POST', path, body, options);
  }

  put(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('PUT', path, body, options);
  }

  patch(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('PATCH', path, body, options);
  }

  delete(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('DELETE', path, body, options);
  }

  head(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('HEAD', path, body, options);
  }

  options(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('OPTIONS', path, body, options);
  }

  /**
   * True once every interceptor registered on this scope has been consumed.
   *
   * Scoped to this origin: asking one scope used to answer for every origin at once, so an
   * unrelated scope with something still pending made this report `false`. Two scopes on the
   * same origin but different base paths do still share an answer - a pending interceptor
   * reports its origin, and its path may be a function, so there is nothing finer to filter on.
   */
  isDone(): boolean {
    return !mockAgent.pendingInterceptors().some((interceptor) => interceptor.origin === this.#origin);
  }

  /** nock's assertion form of `isDone()`. */
  done(): void {
    if (!this.isDone()) {
      throw new Error(`Mocks for ${this.#origin} are not all done`);
    }
  }
}

/**
 * Split `https://host:port/base/path` into the origin undici wants and the path prefix
 * every interceptor on the scope should inherit.
 */
function splitOrigin(basePath: string | RegExp | Url | URL): {origin: string; path: string} {
  if (basePath instanceof RegExp) {
    // A regex origin can't carry a base path.
    return {origin: basePath as unknown as string, path: ''};
  }

  if (typeof basePath === 'string') {
    const url = new URL(basePath);

    return {origin: url.origin, path: trimTrailingSlash(url.pathname)};
  }

  if (basePath instanceof URL) {
    return {origin: basePath.origin, path: trimTrailingSlash(basePath.pathname)};
  }

  return {origin: basePath.protocol + '//' + basePath.host, path: trimTrailingSlash(basePath.pathname ?? '')};
}

function trimTrailingSlash(path: string): string {
  return path === '/' ? '' : path.replace(/\/$/, '');
}

function nock(basePath: string | RegExp | Url | URL): Scope {
  const {origin, path} = splitOrigin(basePath);

  return new Scope(origin, path);
}

Object.assign(nock, {
  active: true,
  activate() {
    mockAgent.activate();

    this.active = true;
  },
  restore() {
    mockAgent.deactivate();

    this.active = false;
  },
  isActive() {
    return this.active;
  },
  disableNetConnect() {
    mockAgent.disableNetConnect();
  },
  enableNetConnect(host?: string | RegExp | ((host: string) => boolean)) {
    // undici's overloads don't accept `undefined` for the "allow everything" form.
    return host === undefined ? mockAgent.enableNetConnect() : mockAgent.enableNetConnect(host as string);
  },
  pendingMocks() {
    return mockAgent.pendingInterceptors();
  },
  /** Drop every interceptor registered so far, on every origin. */
  cleanAll() {
    for (const pool of pools.values()) {
      (pool as unknown as {cleanMocks(): void}).cleanMocks();
    }

    // The pools themselves are done with too - holding them meant the map only ever grew over
    // a suite's lifetime. `Scope` re-fetches from the agent on the next `nock(...)`.
    pools.clear();
  },
  abortPendingRequests() {
    // undici has no equivalent; interceptors are removed instead.
    this.cleanAll();
  },
});

type NockApi = typeof nock & {
  active: boolean;
  activate(): void;
  restore(): void;
  isActive(): boolean;
  disableNetConnect(): void;
  enableNetConnect(host?: string | RegExp | ((host: string) => boolean)): void;
  pendingMocks(): ReturnType<MockAgent['pendingInterceptors']>;
  cleanAll(): void;
  abortPendingRequests(): void;
};

export default nock as NockApi;

// Also named, so plain CommonJS `require('gotlike/nock').nock` works - a bare
// `require()` of an ESM module yields the namespace, not the default export.
const nockExport = nock as NockApi;

export {nockExport as nock, mockAgent, Scope, Interceptor};

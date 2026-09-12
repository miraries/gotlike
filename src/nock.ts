import type {Url} from 'node:url';
import {getGlobalDispatcher, MockAgent, setGlobalDispatcher} from 'undici';
import type {MockInterceptor} from 'undici/types/mock-interceptor.js';
import type {Dispatcher, Interceptable} from 'undici';

const mockAgent = new MockAgent();

/**
 * Whatever was global before this module replaced it, so `restore()` can put it back.
 *
 * `deactivate()` alone makes the mock pass requests through, which looks like a restore until
 * the caller had set a dispatcher of their own - a proxy agent, or a pool tuned for their
 * workload. That one stayed replaced for the lifetime of the process.
 */
const originalDispatcher: Dispatcher = getGlobalDispatcher();

if (process.env.NOCK_OFF !== 'true') {
  setGlobalDispatcher(mockAgent);
}

/** A nock origin as undici keys it: an exact origin, or a pattern matching several. */
type Origin = string | RegExp;

/**
 * Pools handed out by `mockAgent.get`, kept so `cleanAll()` can reach them - and, for a regex
 * origin, so the *same* pool backs every scope written with the same pattern.
 *
 * Keyed by a canonical string rather than by the origin itself, because undici keys a regex
 * origin by object identity: `nock(/api\.test/)` written twice is two RegExp objects, so the
 * second missed this map and registered a second mock pool. undici resolves a request's origin
 * against the first regex pool it finds and caches *that* pool's dispatch list under the
 * concrete origin, so everything on the second pool was invisible - and an unmatched
 * interceptor falls through to the real network. Real nock matches both; measured against
 * nock 14.
 */
const pools = new Map<string, {pool: Interceptable; origin: Origin}>();

function poolKey(origin: Origin): string {
  // The pattern, not the object: `\u0000` can appear in neither half, so no two distinct
  // patterns collide.
  return typeof origin === 'string' ? origin : `re\u0000${origin.source}\u0000${origin.flags}`;
}

/**
 * undici's per-pool dispatch list, if this version still keeps it where we expect.
 *
 * Reaching for it at all is about `cleanAll()` on a regex origin. `cleanMocks()` replaces the
 * array rather than emptying it, while the concrete-origin pool undici derives from a regex
 * one keeps a reference to the array it had at derivation time - so cleaning the pool we
 * registered on left the derived one still matching everything registered before it, and
 * every interceptor registered *after* the clean landed on an array nothing was reading. That
 * is why a regex origin used to work exactly once per host per process: measured, a second
 * `nock(/host/)` after a `cleanAll()` matched nothing at all.
 *
 * Emptying the array in place keeps every sharer in step. The symbol is looked up by
 * description because undici's mock symbols are module-local; if a future undici moves or
 * renames it the lookup fails and `cleanAll` falls back to `cleanMocks()`, which is what it
 * always did.
 */
function dispatchesOf(pool: Interceptable): unknown[] | undefined {
  const key = Object.getOwnPropertySymbols(pool).find((symbol) => symbol.description === 'dispatches');

  const dispatches = key && (pool as unknown as Record<symbol, unknown>)[key];

  return Array.isArray(dispatches) ? dispatches : undefined;
}

type HeaderMatcher = string | RegExp | ((fieldValue: string) => boolean);
type PathMatcher = string | RegExp | ((path: string) => boolean);

/**
 * An object or array matches the request body parsed as JSON, field by field, as it does in
 * nock. undici compares a non-RegExp, non-function matcher with `===`, so an object never
 * matched anything - and because an unmatched interceptor falls through to the real network,
 * a test written that way quietly made a live outbound request.
 */
type BodyMatcher = string | RegExp | Record<string, any> | unknown[] | ArrayBufferView | ((body: string) => boolean);

/**
 * `true` matches any query string, an object matches those exact params.
 *
 * `true` rather than `boolean`: nock throws `Argument Error: false` for `.query(false)`, so
 * accepting one here would take a call nock rejects outright and silently apply no query
 * expectation at all.
 */
type QueryMatcher = true | Record<string, any> | URLSearchParams | QueryPredicate;

/** nock's `.query(fn)`: the whole parsed query at once, repeated keys as arrays. */
type QueryPredicate = (query: Record<string, string | string[]>) => boolean;

/** What `queryMatches` is asked to apply: per-key expectations, or one predicate. */
type QueryExpectation = Record<string, any> | QueryPredicate;

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
 *
 * A `Buffer`/`Uint8Array` body is decoded first. nock stringifies the request body before it
 * ever reaches the callback, so `post(url, {body: Buffer.from(json)})` handed the callback a
 * raw `Buffer` here where nock gives the parsed object - and a callback reading
 * `requestBody.id` got `undefined` against the mock and the right answer against the server.
 */
function parseRequestBody(body: unknown, headers: Record<string, string>): unknown {
  if (ArrayBuffer.isView(body)) {
    body = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }

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

/**
 * Deep-compare an expected body against what arrived, with nock's leaf matchers: a RegExp
 * tests the value, a function is asked about it, anything else compares by value.
 */
function bodyValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected instanceof RegExp) {
    return typeof actual === 'string' && expected.test(actual);
  }

  if (typeof expected === 'function') {
    return Boolean((expected as (value: unknown) => unknown)(actual));
  }

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, i) => bodyValueMatches(item, actual[i]))
    );
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return false;
    }

    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);

    // Exact, as nock's object body matching is: every field named and nothing besides -
    // and the field has to be *there*. Reading it and comparing was not the same thing:
    // `{a: undefined}` matched a body of `{b: 'foo'}`, because the key counts agreed and
    // `actual.a` read back as `undefined` just as the expectation did.
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every(
        (key) =>
          Object.hasOwn(actual, key) &&
          bodyValueMatches((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key]),
      )
    );
  }

  return expected === actual;
}

/**
 * Turn an object/array body matcher into the function matcher undici can actually apply.
 * Strings, RegExps and functions are already shapes undici understands, so they pass through.
 */
function toBodyMatcher(body?: BodyMatcher): string | RegExp | ((body: string) => boolean) | undefined {
  if (body === null || body === undefined || typeof body !== 'object' || body instanceof RegExp) {
    return body;
  }

  // A Buffer/Uint8Array is an object too, and would otherwise fall into the JSON matcher below -
  // where `JSON.parse` on binary data always throws, so a buffer body matcher never matched
  // anything. undici hands a body-carrying request's body back as a Buffer already (not the
  // string the type below promises) and a bodyless one as `undefined`, so this goes byte-for-
  // byte via a Buffer built from whatever arrived, not from JSON - guarded the same way the JSON
  // matcher below is, since `Buffer.from(undefined)` throws rather than returning a mismatch.
  if (ArrayBuffer.isView(body)) {
    const expected = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

    return (requestBody: string) => {
      try {
        return Buffer.from(requestBody).equals(expected);
      } catch {
        return false;
      }
    };
  }

  return (requestBody: string) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(requestBody);
    } catch {
      return false;
    }

    return bodyValueMatches(body, parsed);
  };
}

/** Whether a reply body is one nock would label `application/json`. */
function isJsonReplyBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
}

function hasContentType(headers: ReplyHeaders): boolean {
  for (const key in headers) {
    if (key.toLowerCase() === 'content-type') {
      return true;
    }
  }

  return false;
}

/**
 * The response headers undici should send.
 *
 * nock labels an object or array reply `application/json`; undici's MockAgent serialises the
 * body but sets no content-type at all, so anything under test that branches on the response's
 * content-type behaved differently against the mock than against the real server - which is
 * the one thing a mocking shim must not do.
 */
function replyOptions(body: unknown, headers?: ReplyHeaders): {headers?: ReplyHeaders} {
  if (!isJsonReplyBody(body)) {
    return headers ? {headers} : {};
  }

  if (!headers) {
    return {headers: {'content-type': 'application/json'}};
  }

  return {headers: hasContentType(headers) ? headers : {...headers, 'content-type': 'application/json'}};
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
  expectedQuery?: QueryExpectation,
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

    // Through the same leaf matcher as a single value: a RegExp or a predicate is legal
    // inside a repeated key too, and comparing `String(/news/)` could only ever fail.
    return values.length === expected.length && expected.every((item, i) => queryLeafMatches(values[i]!, item));
  }

  const value = actual.get(name);

  return value !== null && queryLeafMatches(value, expected);
}

/** One expected query value against one that arrived, with nock's leaf matchers. */
function queryLeafMatches(value: string, expected: unknown): boolean {
  if (expected instanceof RegExp) {
    return expected.test(value);
  }

  if (typeof expected === 'function') {
    return Boolean((expected as (v: string) => unknown)(value));
  }

  return value === String(expected);
}

/** nock's default is an exact match: every param the interceptor named, and nothing else. */
function queryMatches(requestPath: string, expected: QueryExpectation): boolean {
  const index = requestPath.indexOf('?');
  const actual = new URLSearchParams(index === -1 ? '' : requestPath.slice(index + 1));

  // `.query(fn)` is handed the whole parsed query and decides for itself, exactness included.
  if (typeof expected === 'function') {
    return Boolean(expected(searchParamsToObject(actual)));
  }

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
function isSerialisableQuery(query?: QueryExpectation): boolean {
  if (!query) {
    return true;
  }

  // A predicate over the whole query is never undici's to apply.
  if (typeof query === 'function') {
    return false;
  }

  // Inside an array as well as at the top level - undici serialises each element, so a
  // `{tags: [/news/, 'updates']}` slipped past a top-level-only check and was handed over.
  return Object.values(query).every((value) =>
    (Array.isArray(value) ? value : [value]).every((item) => !(item instanceof RegExp) && typeof item !== 'function'),
  );
}

function queryToObject(query: QueryExpectation | URLSearchParams): QueryExpectation {
  return query instanceof URLSearchParams ? searchParamsToObject(query) : query;
}

/**
 * Split a literal `?` out of a nock path matcher, the way `nock(origin).get('/search?type=user')`
 * carries it. Only a string path can carry one - a regex or predicate path has no query of its
 * own to speak of.
 */
function splitPathQuery(path: PathMatcher): {path: PathMatcher; query?: Record<string, string | string[]>} {
  if (typeof path !== 'string') {
    return {path};
  }

  const index = path.indexOf('?');

  if (index === -1) {
    return {path};
  }

  return {path: path.slice(0, index), query: searchParamsToObject(new URLSearchParams(path.slice(index + 1)))};
}

/**
 * Compare one of the path's own literal query values against what a request actually carried.
 * Both sides come from `searchParamsToObject`, so a repeated key is an array on each - a fresh
 * one built per request, which `===` can never see as equal to the literal's own array even when
 * every element matches.
 */
function ownQueryValueMatches(actual: string | string[] | undefined, expected: string | string[]): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => actual[i] === value)
    );
  }

  return actual === expected;
}

/**
 * Fold a path's own literal query into a separately chained `.query()` expectation, so both have
 * to be satisfied - `nock(origin).get('/search?type=user').query({q: 'test'})` requires both
 * `type=user` and `q=test`. Passing the two straight to undici throws (`serializePathWithQuery`
 * refuses a path that already has a `?`), and folding the literal one into the path string while
 * ignoring it in the query check let a request missing it match regardless.
 */
function mergeQueryExpectations(
  own: Record<string, string | string[]> | undefined,
  extra?: QueryExpectation,
): QueryExpectation | undefined {
  if (!own) {
    return extra;
  }

  if (extra === undefined) {
    return own;
  }

  if (typeof extra === 'function') {
    return (actual: Record<string, string | string[]>) =>
      Object.entries(own).every(([key, value]) => ownQueryValueMatches(actual[key], value)) && Boolean(extra(actual));
  }

  return {...own, ...extra};
}

/**
 * A `URLSearchParams` as the plain object nock deals in.
 *
 * Not `Object.fromEntries`, which keeps only the last of a repeated key - so
 * `.query(new URLSearchParams('a=1&a=2'))` silently became `{a: '2'}` and matched the wrong
 * requests. `queryValueMatches` and `.query(fn)` both understand an array.
 */
function searchParamsToObject(query: URLSearchParams): Record<string, string | string[]> {
  const object: Record<string, string | string[]> = {};

  for (const [key, value] of query.entries()) {
    const existing = object[key];

    if (existing === undefined) {
      object[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      object[key] = [existing, value];
    }
  }

  return object;
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

  /**
   * nock's `.query()`: an object or `URLSearchParams` of expected params, `true` to ignore the
   * query entirely, or a predicate handed the whole parsed query (repeated keys as arrays).
   */
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
    const explicitQuery = this.#query !== undefined && this.#query !== true ? queryToObject(this.#query) : undefined;

    // A literal `?` on the path itself - `nock(origin).get('/search?type=user')` - can't be
    // handed to undici alongside a `query`: `serializePathWithQuery` throws outright when the
    // path it's folding a query into already has one. Splitting it off here and folding it into
    // the query expectation instead means both requirements are enforced and undici only ever
    // sees a bare path.
    const {path, query: ownQuery} = splitPathQuery(this.#path);
    const query = ignoreQuery ? undefined : mergeQueryExpectations(ownQuery, explicitQuery);

    // For an object query undici folds the params into the interceptor's path string and
    // compares that, which a function matcher would defeat - so those keep an ordinary string
    // path. It can only do that when the path *is* a string, though: behind the function
    // matcher a regex or function path needs, it drops the query and matches every one of them.
    //
    // It also can only do it for values it can serialise. A RegExp or a predicate value
    // stringifies to nonsense (`"/bar/"`), so those go through `queryMatches` instead - as
    // does `.query(fn)`, which is a predicate over the whole query rather than a value at all.
    const undiciAppliesQuery = typeof path === 'string' && !ignoreQuery && isSerialisableQuery(query);

    const options: MockInterceptor.Options = {
      method: this.#method,
      path: buildPathMatcher(this.#basePath, path, ignoreQuery, undiciAppliesQuery ? undefined : query),
      body: toBodyMatcher(this.#body),
      headers: Object.keys(this.#headers).length > 0 ? this.#headers : undefined,
    };

    if (query && undiciAppliesQuery) {
      // `undiciAppliesQuery` is what rules out a predicate here; `isSerialisableQuery` is the
      // one place that decides, so this narrows by hand rather than repeating the test.
      options.query = query as Record<string, any>;
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
      // `=== undefined`, not `??`: `reply(200, null)` means a body of `null`, and coercing it
      // to `''` turned a mocked null response into a parse failure.
      interceptor.reply(responseCodeOrFunction, (body === undefined ? '' : body) as any, replyOptions(body, headers)),
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

        return {
          statusCode,
          data: (data === undefined ? '' : data) as any,
          responseOptions: replyOptions(data, replyHeaders),
        };
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
  #origin: Origin;

  /** Set by `persist()`, and inherited by every interceptor registered after it. */
  #persist = false;

  constructor(origin: Origin, basePath: string) {
    const key = poolKey(origin);
    let entry = pools.get(key);

    if (!entry) {
      entry = {pool: mockAgent.get(origin as string), origin};
      pools.set(key, entry);
    }

    this.#pool = entry.pool;
    this.#basePath = basePath;
    // The origin the pool was *registered* under, which for a regex is the first RegExp object
    // written with this pattern. `isDone()` compares it by identity, as undici does.
    this.#origin = entry.origin;
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

  query(path: PathMatcher, body?: BodyMatcher, options?: Options) {
    return this.#verb('QUERY', path, body, options);
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
function splitOrigin(basePath: string | RegExp | Url | URL): {origin: Origin; path: string} {
  if (basePath instanceof RegExp) {
    // A regex origin can't carry a base path.
    return {origin: basePath, path: ''};
  }

  if (typeof basePath === 'string') {
    // `nock('mock.test')` is legal there and threw `ERR_INVALID_URL` here. Any scheme is left
    // alone; only a bare host gets one.
    const absolute = /^[a-z][a-z\d+\-.]*:\/\//i.test(basePath) ? basePath : `http://${basePath}`;
    const url = new URL(absolute);

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
    setGlobalDispatcher(mockAgent);

    this.active = true;
  },
  restore() {
    mockAgent.deactivate();
    // Put the caller's own dispatcher back, not just a pass-through mock - see
    // `originalDispatcher`.
    setGlobalDispatcher(originalDispatcher);

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
    for (const [key, {pool, origin}] of pools) {
      const dispatches = dispatchesOf(pool);

      if (dispatches) {
        // In place, so the concrete-origin pools undici derived from a regex one - which hold
        // this very array - are cleared with it. See `dispatchesOf`.
        dispatches.length = 0;
      } else {
        (pool as unknown as {cleanMocks(): void}).cleanMocks();
      }

      // String origins are dropped: holding them meant the map only ever grew over a suite's
      // lifetime, and undici hands the same pool back for the same origin anyway. A regex one
      // is kept, because handing back a *different* pool is exactly what breaks it - the
      // derived pools go on reading the array this entry owns.
      if (typeof origin === 'string') {
        pools.delete(key);
      }
    }
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

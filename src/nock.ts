import type {Url} from 'node:url';
import {Readable} from 'node:stream';
import {DecoratorHandler, Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher} from 'undici';
import type {MockInterceptor} from 'undici/types/mock-interceptor.js';
import type {Interceptable} from 'undici';

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

/**
 * Timers backing a `.delay()`ed reply that hasn't fired yet, so `abortPendingRequests()` has
 * something to cancel. undici's own `MockInterceptor.delay()` has no such hook - its timer is
 * internal to `mock-utils.js`, with no handle exposed for cancelling it after the fact - so
 * every delay is implemented here instead (see `awaitDelay`), specifically to keep this set
 * accurate. Real nock's `abortPendingRequests` does the same thing to its own wrapped timers
 * (`common.removeAllTimers`): it does not deliver an abort error to the caller, it just makes
 * sure the timer holding a reply back never fires, which is what "pending" means once a request
 * has already matched an interceptor and is only waiting on its delay.
 */
const pendingDelayTimers = new Set<NodeJS.Timeout>();

function awaitDelay(ms: number | undefined): Promise<void> {
  if (ms === undefined) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDelayTimers.delete(timer);
      resolve();
    }, ms);

    pendingDelayTimers.add(timer);
  });
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
const pools = new Map<string, {pool: Interceptable; origin: Origin; active: boolean}>();

function poolKey(origin: Origin): string {
  // The pattern, not the object: `\u0000` can appear in neither half, so no two distinct
  // patterns collide.
  return typeof origin === 'string' ? origin : `re\u0000${origin.source}\u0000${origin.flags}`;
}

/**
 * Whether an origin with registered mocks owns this request origin.
 *
 * MockAgent normally falls through to the real dispatcher when nothing matches. Real nock
 * instead owns an origin once it has a scope, so a typo in a path, body or query fails closed
 * rather than becoming a live request. Hosts without a scope still retain MockAgent's default
 * pass-through behaviour.
 */
function hasMockedOrigin(requestOrigin: string): boolean {
  for (const {origin, active} of pools.values()) {
    if (!active) {
      continue;
    }

    if (typeof origin === 'string') {
      if (new URL(origin).origin === requestOrigin) {
        return true;
      }

      continue;
    }

    origin.lastIndex = 0;

    if (origin.test(requestOrigin)) {
      return true;
    }
  }

  return false;
}

type NetConnectMatcher = string | RegExp | ((host: string) => boolean);

/**
 * What `nock.enableNetConnect()`/`disableNetConnect()` asked for: every host, none, or the ones one
 * matcher accepts. In nock this governs *unmocked* hosts only - an origin with a scope fails closed
 * on a miss whatever it says.
 *
 * It used to be applied to mocked origins as well: calling either function switched the
 * per-origin check below off for the rest of the process, so after the ordinary teardown
 * `nock.enableNetConnect()` a typo'd path on a mocked host became a live request to the real
 * one - silently, and in every test file mocha ran after it.
 *
 * **One matcher, and nock's.** This used to hand each call to undici's own `enableNetConnect(host)`,
 * which differs from nock's in all three ways that matter (nock 14, `lib/intercept.js`): nock turns
 * a string into a `RegExp` where undici compares it exactly, nock tests it against `host:port` with
 * the default port filled in where undici drops a default port, and each nock call *replaces* the
 * matcher where undici's add to a list. The last is the one that failed open - `enableNetConnect('a')`
 * then `enableNetConnect('b')` still let `a` through, a live request nock would have refused - and
 * the first two failed closed, so `enableNetConnect('127.0.0.1')` blocked `127.0.0.1:3000`, which nock
 * allows. `netConnectAllows` now answers for every request itself.
 */
let netConnectPolicy: boolean | {test: (host: string) => boolean} = true;

/** Which setting MockAgent currently holds, so a dispatch only switches it when it has to. */
let appliedNetConnect: boolean | undefined;

/*
 * MockAgent's public network matcher receives only `host`, which loses the scheme - so it cannot
 * tell `http://example.test` from `https://example.test`, nor fill in the default port nock matches
 * on. The whole decision is made here instead, synchronously at dispatch time while the complete
 * origin is still available, and MockAgent is simply switched open or closed to match: closed for an
 * origin with registered mocks, `netConnectAllows` for any other. The mock match (or miss) is decided
 * before `dispatch()` returns, so another request cannot observe the temporary setting between these
 * two calls.
 */
const mockDispatch = mockAgent.dispatch.bind(mockAgent);

mockAgent.dispatch = (options, handler) => {
  const origin = String(options.origin);
  const open = !hasMockedOrigin(origin) && netConnectAllows(origin);

  if (appliedNetConnect !== open) {
    if (open) {
      mockAgent.enableNetConnect();
    } else {
      mockAgent.disableNetConnect();
    }

    appliedNetConnect = open;
  }

  return mockDispatch(options, new NockErrorHandler(handler, options));
};

/**
 * Delivers a miss as nock reports it (`asNockError`). undici's dispatcher catches the
 * `MockNotMatchedError` its mock pool throws and hands it to the handler's `onResponseError`.
 */
class NockErrorHandler extends DecoratorHandler {
  #options: Dispatcher.DispatchOptions;

  constructor(handler: Dispatcher.DispatchHandler, options: Dispatcher.DispatchOptions) {
    super(handler);
    this.#options = options;

    // `DecoratorHandler` always has the body hooks, and undici's mock drains a streamed body
    // itself when a handler has them - changing when, and in what form, a reply callback sees an
    // upload (see `resolveRequestBody`). Hidden unless the handler being wrapped has them too.
    const self = this as unknown as Record<string, unknown>;

    if (typeof handler.onBodySent !== 'function') {
      self.onBodySent = undefined;
    }

    if (typeof handler.onRequestSent !== 'function') {
      self.onRequestSent = undefined;
    }
  }

  onResponseError(controller: Dispatcher.DispatchController, error: Error): void {
    (DecoratorHandler.prototype as unknown as Required<Dispatcher.DispatchHandler>).onResponseError.call(
      this,
      controller,
      asNockError(error, this.#options) as Error,
    );
  }
}

/**
 * undici's miss as nock reports it.
 *
 * undici throws `MockNotMatchedError` (`UND_MOCK_ERR_MOCK_NOT_MATCHED`, `Mock dispatch not matched
 * ...`) for both a miss on a mocked origin and a request to a host net connect refuses. Suites
 * written against nock assert on nock's spelling - `/Nock: No match for request/`, `ERR_NOCK_NO_MATCH`,
 * `ENETUNREACH` - and every one of those failed here although the mock had behaved exactly as
 * nock's would. The message and code are nock's (`lib/intercepted_request_router.js`,
 * `lib/common.js`); undici's error stays on `cause`, where its detail - which interceptors were
 * left - is still useful. Found by running nock's own suite (`conformance/`).
 */
function asNockError(error: unknown, options: Dispatcher.DispatchOptions): unknown {
  if ((error as {code?: string})?.code !== 'UND_MOCK_ERR_MOCK_NOT_MATCHED') {
    return error;
  }

  const origin = String(options.origin);

  if (!hasMockedOrigin(origin)) {
    const url = new URL(options.path, origin);
    const port = url.port === '' ? (url.protocol === 'http:' ? '80' : '443') : url.port;

    return Object.assign(
      new Error(`Nock: Disallowed net connect for "${url.hostname}:${port}${url.pathname}"`, {cause: error}),
      {
        name: 'NetConnectNotAllowedError',
        code: 'ENETUNREACH',
      },
    );
  }

  const request = {method: options.method, url: new URL(options.path, origin).href, headers: options.headers};

  return Object.assign(new Error(`Nock: No match for request ${JSON.stringify(request, null, 2)}`, {cause: error}), {
    code: 'ERR_NOCK_NO_MATCH',
    statusCode: 404,
    status: 404,
  });
}

/**
 * nock's net-connect test: the matcher is asked about `hostname:port`, lower-cased, with the port
 * filled in (80 for http, 443 otherwise) - `normalizeRequestOptions` in nock's `lib/common.js`. An
 * IPv6 literal is matched without its brackets, since that is how got hands nock the hostname.
 */
function netConnectAllows(origin: string): boolean {
  if (netConnectPolicy === true || netConnectPolicy === false) {
    return netConnectPolicy;
  }

  const url = new URL(origin);
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === '' ? (url.protocol === 'http:' ? '80' : '443') : url.port;

  if (netConnectPolicy instanceof RegExp) {
    netConnectPolicy.lastIndex = 0;
  }

  return netConnectPolicy.test(`${hostname}:${port}`.toLowerCase());
}

/**
 * A client built with its own agent - `agent`, `connections`, `keepAliveTimeout` and the rest -
 * dispatches through that agent, never through the global one this module replaced. So the mock
 * never saw its requests: a matching interceptor was skipped and `disableNetConnect()` did nothing,
 * and a test that looked mocked made a live request with the real credentials. Real nock sits under
 * every agent, so it never had this gap.
 *
 * The client asks for this route whenever the global dispatcher is the mock. A request goes to the
 * mock when nock would have a say in it - a mocked origin, or one net connect doesn't allow - and
 * through the client's own agent otherwise, so an allowed live request keeps the pool it was
 * configured with, as it would under nock.
 */
class OwnAgentRoute extends Dispatcher {
  #own: Dispatcher;

  constructor(own: Dispatcher) {
    super();
    this.#own = own;
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = String(options.origin);

    if (hasMockedOrigin(origin) || !netConnectAllows(origin)) {
      return mockAgent.dispatch(options, handler);
    }

    return this.#own.dispatch(options, handler);
  }

  override close(...args: unknown[]): any {
    return (this.#own.close as (...args: unknown[]) => unknown)(...args);
  }

  override destroy(...args: unknown[]): any {
    return (this.#own.destroy as (...args: unknown[]) => unknown)(...args);
  }
}

/** One route per agent, so the client's memoised interceptor chain survives across requests. */
const routes = new WeakMap<Dispatcher, OwnAgentRoute>();

function routeOwnAgent(own: Dispatcher): Dispatcher {
  // Someone else's MockAgent is already a mock; routing it here would second-guess it.
  if (own instanceof MockAgent) {
    return own;
  }

  let route = routes.get(own);

  if (route === undefined) {
    route = new OwnAgentRoute(own);
    routes.set(own, route);
  }

  return route;
}

// Found by `Symbol.for` from `index.ts`, which never imports this module.
Object.defineProperty(mockAgent, Symbol.for('gotlike.nock.routeOwnAgent'), {value: routeOwnAgent});

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
type BodyMatcher = string | RegExp | Record<string, any> | unknown[] | ArrayBufferView | ((body: any) => boolean);

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

/** `nock(host, options)` - the scope-wide options the shim supports. See `scopeHeaders`. */
export type ScopeOptions = Options & {
  /** Accepted, not applied: an unmatched request is refused rather than passed through. */
  allowUnmocked?: boolean;
  /** Accepted, not applied: the scope matches only its own host. */
  filteringScope?: (scope: string) => boolean;
  /** Headers whose presence makes a request *not* match. */
  badheaders?: string[];
  /** Asked on every request; the scope's interceptors only match while it returns `true`. */
  conditionally?: () => boolean;
};

export type ReplyHeaders = Record<string, string | string[]>;
export type ReplyBody = string | number | boolean | Buffer | Record<string, any> | unknown[] | null;

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
 * The request body a reply callback should be handed, as bytes.
 *
 * For `gotlike.stream.post()`/`.put()`, and for a `FormData` body on the plain promise API,
 * `undici.pipeline`/`undici.request` hand the mock a live `Readable` rather than the bytes that
 * will eventually flow through it - the duplex's writable side (or the encoded `FormData`) is
 * read lazily. What arrives here depends on whether any composed interceptor implements
 * `onBodySent`/`onRequestSent` (`decompress`, `retry`, `redirect`, `dedupe`, `cache` all do, via
 * the pass-through `DecoratorHandler` base every one of them wraps the real handler in - even
 * the ones that never call it):
 *
 * - **one does**: undici has already drained the `Readable` itself (`dispatchRequestBody` in its
 *   own `mock-utils.js`) and hands over the result - not the bytes, but a fresh plain object
 *   exposing them as a replayable `{[Symbol.asyncIterator]}`, which is what `[object Object]`
 *   was made of.
 * - **none does** (a plain client, `decompress: false` and nothing else composed): undici passes
 *   the body through untouched, so this is still the live, unread `Readable`.
 *
 * Either way, a reply callback used to see something with no bytes in it at all.
 *
 * **The stream is drained, not tee'd.** It used to be piped into two `PassThrough`s - one to
 * read, one put back on `opts.body` for a later read by undici - on the belief that undici reads
 * the body again after this callback resolves. It does not: `dispatchRequestBody` runs *before*
 * `sendReply()` and is the only thing that ever touches it, so nothing drained the second
 * `PassThrough` and, past its 16KB high-water mark, `pipe` paused the source, the half being
 * read stopped receiving, and the callback's `await` never resolved. Measured: a `stream.post`
 * of 200KB never settled, and the reply callback was never called at all. The drained bytes go
 * back on `opts.body` as a `Buffer`, which is replayable, so a reader appearing later still
 * finds the body rather than an exhausted stream.
 *
 * A body *matcher* (`nock(host).post(path, matcher)`) deciding which interceptor answers a
 * streamed request stays broken regardless: undici picks the interceptor before either path
 * above ever runs, against the same unread stream, so a matcher on a streamed upload never
 * matches and the request falls through to the real network. Not fixed here; a caller who needs
 * to assert on a streamed body's content still has to do it from the reply callback.
 */
async function resolveRequestBody(opts: {body?: unknown}): Promise<unknown> {
  const body = opts.body;

  if (body instanceof Readable) {
    const collected = await collectAsyncIterable(body);

    // Back onto the options as bytes: the stream is spent now, and a `Buffer` is what anything
    // reading it after us can still make sense of.
    opts.body = collected;

    return collected;
  }

  if (isAsyncIterable(body)) {
    return collectAsyncIterable(body);
  }

  return body;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Buffer | string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {[Symbol.asyncIterator]?: unknown})[Symbol.asyncIterator] === 'function'
  );
}

async function collectAsyncIterable(source: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

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
    // The same expected value is reused across every request a persisted interceptor answers,
    // so a `/g`/`y` matcher's `lastIndex` survived from the previous call: a body matched on
    // request 1, advanced `lastIndex` past the match, and request 2 with an identical body
    // missed because `test()` resumed searching from there instead of the start. Reset the way
    // the origin matcher already does.
    expected.lastIndex = 0;

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
  // undici would hand a predicate the body as it arrived - a Buffer, or nothing at all - where
  // nock hands it the parsed body. So `(body) => body.method === 'x'`, the most natural way to
  // match one JSON-RPC call among several on the same path, read `undefined` and never matched.
  if (typeof body === 'function') {
    // Typed as undici types it; see the Buffer branch below for what actually arrives.
    return (requestBody: string) => Boolean(body(predicateBody(requestBody as string | ArrayBufferView | undefined)));
  }

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
    const text = bodyText(requestBody);
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON, so perhaps a form - see `formBody`.
      const form = formBody(text);

      return form !== undefined && bodyValueMatches(stringifyLeaves(body), form);
    }

    return bodyValueMatches(body, parsed);
  };
}

/**
 * An urlencoded body as the object nock compares an object matcher against, a repeated key as an
 * array; `undefined` for a body that is not a form at all.
 *
 * nock parses a form body before matching (`lib/match_body.js`), so `nock(host).post('/login',
 * {user: 'a'})` matches `form: {user: 'a'}`. Here only JSON was parsed, so every such interceptor
 * missed - and a miss on a mocked origin fails closed, as `Mock dispatch not matched`, which reads
 * like the mock was written wrong. nock decides by the request's content-type, which never reaches a
 * body matcher here (see `predicateBody`); deciding by the body alone is the same answer on both of
 * undici's calls, which is what a matcher has to give. Nested `qs` keys (`a[b]=1`) are not expanded.
 */
function formBody(text: string): Record<string, string | string[]> | undefined {
  if (text === '' || !text.includes('=')) {
    return undefined;
  }

  const form: Record<string, string | string[]> = {};

  for (const [key, value] of new URLSearchParams(text)) {
    const previous = form[key];

    form[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }

  return form;
}

/** A matcher with its scalar leaves as strings, which is how a form carries them - as nock compares. */
function stringifyLeaves(expected: unknown): unknown {
  if (Array.isArray(expected)) {
    return expected.map(stringifyLeaves);
  }

  if (typeof expected === 'number' || typeof expected === 'boolean') {
    return String(expected);
  }

  if (expected !== null && typeof expected === 'object' && !(expected instanceof RegExp)) {
    return Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, stringifyLeaves(value)]));
  }

  return expected;
}

/** A request body as undici hands it to a matcher - a string, a Buffer, or nothing - as text. */
function bodyText(requestBody: string | ArrayBufferView | undefined): string {
  if (requestBody === undefined) {
    return '';
  }

  return typeof requestBody === 'string'
    ? requestBody
    : Buffer.from(requestBody.buffer, requestBody.byteOffset, requestBody.byteLength).toString('utf8');
}

/**
 * The body a nock predicate is handed (`lib/match_body.js`): parsed as JSON if it parses, else the
 * text itself - `''` for a request with no body.
 *
 * nock also parses an urlencoded body into an object when the content-type says it is one. That
 * half is not done here: undici hands a body matcher the body alone, and it applies the matcher a
 * second time after `dispatch()` has returned (`matchKey`, removing the consumed interceptor), so
 * there is no moment the content-type could be read from that covers both calls. A predicate that
 * answered differently on the two would match and then never be consumed. Pinned as a divergence
 * in `nock-parity.spec.ts`.
 */
function predicateBody(requestBody: string | ArrayBufferView | undefined): unknown {
  const text = bodyText(requestBody);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Header matchers undici applies the way nock does (`reqheaderMatches` in nock's `interceptor.js`).
 *
 * Each becomes a function, because undici's own comparison differs from nock's in three places,
 * all found once scope-level `reqheaders` started being applied (they had been dropped - see
 * `scopeHeaders`):
 * - undici tests a RegExp with `re.test(value)` whether or not the header was sent, and
 *   `/./.test(undefined)` is `true` - so `.matchHeader('x-key', /./)` matched a request that never
 *   carried `x-key`. A string or RegExp only matches a header that is there.
 * - a header sent as an array or a number reaches the matcher as one; nock compares node's string
 *   form (`['a', 'b']` as `a, b`, `0` as `'0'`), and a number expectation as a string too.
 * - a `host` requirement is skipped when the request set no `host` header, as nock skips it: undici
 *   derives the host rather than carrying one, so it would otherwise never match.
 * A function is handed the (string) value, or `undefined` when absent - `badheaders` relies on that.
 */
function headerMatchers(headers: Record<string, HeaderMatcher>): Record<string, HeaderMatcher> {
  const result: Record<string, HeaderMatcher> = {};

  for (const [name, matcher] of Object.entries(headers)) {
    const isHost = name.toLowerCase() === 'host';

    result[name] = (sent: string | number | string[] | undefined) => {
      const value = sent === undefined ? undefined : Array.isArray(sent) ? sent.join(', ') : String(sent);

      if (typeof matcher === 'function') {
        return Boolean(matcher(value as string));
      }

      if (value === undefined) {
        return isHost;
      }

      if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;

        return matcher.test(value);
      }

      return value === String(matcher);
    };
  }

  return result;
}

/**
 * A reply body as undici should send it.
 *
 * `=== undefined`, not `??`: `reply(200, null)` means a body of `null`, and coercing it to `''`
 * turned a mocked null response into a parse failure. A boolean or number is sent as its text,
 * as nock sends it - undici's MockAgent sends a falsy one as an empty body, so `reply(200, false)`
 * answered `''`.
 */
function replyData(body: unknown): any {
  if (body === undefined) {
    return '';
  }

  return typeof body === 'boolean' || typeof body === 'number' ? String(body) : body;
}

/** Whether a reply body is one nock would label `application/json`. */
function isJsonReplyBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
}

function hasContentType(headers: ReplyHeaders): boolean {
  for (const key in headers) {
    // Own properties only, as everywhere else something a caller handed us is walked: an
    // enumerable `Object.prototype` property named like a content-type would otherwise read as
    // one the reply already sets, and suppress the `application/json` an object body needs.
    if (Object.hasOwn(headers, key) && key.toLowerCase() === 'content-type') {
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

  // A `persist()`ed interceptor reuses this same RegExp for every request it answers, so a
  // `/g`/`y` pattern's `lastIndex` carried over from the previous call and made it alternate
  // between matching and missing an identical path. Reset first, as the origin matcher does.
  matcher.lastIndex = 0;

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
    // Same reset, same reason: this RegExp is reused across every request a persisted
    // interceptor answers, so a `/g`/`y` matcher's `lastIndex` otherwise survived from the
    // previous call and made an identical query value alternate between matching and missing.
    expected.lastIndex = 0;

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
      headers: Object.keys(this.#headers).length > 0 ? headerMatchers(this.#headers) : undefined,
    };

    if (query && undiciAppliesQuery) {
      // `undiciAppliesQuery` is what rules out a predicate here; `isSerialisableQuery` is the
      // one place that decides, so this narrows by hand rather than repeating the test.
      options.query = query as Record<string, any>;
    }

    return this.#pool.intercept(options);
  }

  #applyScopeOptions(mockScope: {times(n: number): any; persist(): any}): Scope {
    if (this.#times !== undefined) {
      mockScope.times(this.#times);
    }

    if (this.#persist) {
      mockScope.persist();
    }

    // Not applied here: undici's own `.delay()` has no way to cancel the timer it starts, which
    // is exactly what `abortPendingRequests()` needs to do. Both reply paths await `awaitDelay`
    // themselves instead - see `pendingDelayTimers`.

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

  reply(responseCode?: number, body?: ReplyBody | ReplyBodyFunction, headers?: ReplyHeaders): Scope;
  reply(replyFunction: ReplyFunction): Scope;
  reply(
    // nock defaults the status to 200: a bare `.reply()` is how its docs mock an empty OK, and it
    // used to reach undici as `statusCode: undefined` and fail every request it matched.
    responseCodeOrFunction: number | ReplyFunction = 200,
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
      interceptor.reply(async () => {
        // Own timer rather than undici's `.delay()` - see `awaitDelay`.
        await awaitDelay(this.#delay);

        return {
          statusCode: responseCodeOrFunction,
          data: replyData(body),
          responseOptions: replyOptions(body, headers),
        };
      }),
    );
  }

  /** The single place that builds nock's callback context, parses the body and calls back. */
  #replyWith(interceptor: MockInterceptor, resolve: ReplyFunction): Scope {
    return this.#applyScopeOptions(
      interceptor.reply(async (opts: any) => {
        const context = this.#context(opts);
        // See `resolveRequestBody`: a streamed upload arrives here as the live `Readable`
        // undici hands straight over, so the bytes have to be collected before the callback
        // can be shown anything.
        const body = await resolveRequestBody(opts);

        // Own timer rather than undici's `.delay()` - see `awaitDelay`.
        await awaitDelay(this.#delay);

        const [statusCode, data, replyHeaders] = await resolve.call(
          context,
          /*
           * The request's whole path, base path and query included - what nock hands over
           * (`options.path`). This used to strip the scope's base path, so
           * `nock('http://h/api').get('/x')` gave the callback `/x?a=1` where nock 14 gives
           * `/api/x?a=1` (measured) - and a test verifying a signature computed over the path,
           * as the aggregator's Spribe suite does, checked it against the wrong string.
           */
          opts.path,
          parseRequestBody(body, context.req.headers),
        );

        return {
          statusCode,
          data: replyData(data),
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
  #poolKey: string;

  /** Set by `persist()`, and inherited by every interceptor registered after it. */
  #persist = false;

  /** Header matchers from the scope's options, under every interceptor's own - see `scopeHeaders`. */
  #headers: Record<string, HeaderMatcher>;

  constructor(origin: Origin, basePath: string, headers: Record<string, HeaderMatcher> = {}) {
    this.#headers = headers;
    const key = poolKey(origin);
    let entry = pools.get(key);

    if (entry) {
      entry.active = true;
    } else {
      entry = {pool: mockAgent.get(origin as string), origin, active: true};
      pools.set(key, entry);
    }

    this.#pool = entry.pool;
    this.#poolKey = key;
    this.#basePath = basePath;
    // The origin the pool was *registered* under, which for a regex is the first RegExp object
    // written with this pattern. `isDone()` compares it by identity, as undici does.
    this.#origin = entry.origin;
  }

  #verb(method: string, path: PathMatcher, body?: BodyMatcher, options?: Options): Interceptor {
    // A regex pool is retained across `cleanAll()` to keep undici's derived concrete pools
    // attached to the same dispatch array. Reusing an old Scope must make it active again.
    const entry = pools.get(this.#poolKey);

    if (entry) {
      entry.active = true;
    } else {
      /*
       * Put back, not skipped. `cleanAll()` drops string origins from the map, so a Scope
       * captured once and reused across one - `const scope = nock(host)` at the top of a file
       * with `cleanAll()` in a `beforeEach` - went on registering interceptors that matched
       * while `hasMockedOrigin` no longer knew the origin was ours. Anything that *missed*
       * those interceptors then fell through to the real network instead of failing closed,
       * which is the one thing this shim owns an origin to prevent, and it did so silently.
       */
      pools.set(this.#poolKey, {pool: this.#pool, origin: this.#origin, active: true});
    }

    const interceptor = new Interceptor(this, this.#pool, this.#basePath, method, path, body, {
      ...options,
      reqheaders: {...this.#headers, ...options?.reqheaders},
    });

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

/**
 * nock's scope options, as the header matchers every interceptor on the scope inherits.
 *
 * `allowUnmocked` and `filteringScope` are accepted and not applied. Both fail *closed* that way -
 * an unmatched request is refused rather than passed through, a scope matches only its own host -
 * so a suite written against them still runs; it is recorded as a gap in `conformance/`.
 *
 * `nock(host, options)` used to drop its second argument, and three of these fail *open* when
 * dropped: without `reqheaders`, `badheaders` or `conditionally` an interceptor matched requests
 * nock would have refused, so a test asserting that an auth header was sent passed without it.
 * All three reuse undici's own header matching: a function matcher is handed the header's value,
 * `undefined` when it is absent - which is exactly `badheaders` - and `conditionally` is asked on a
 * header name no request carries. Found by running nock's own suite (`conformance/`).
 */
function scopeHeaders(options: ScopeOptions | undefined): Record<string, HeaderMatcher> {
  if (options === undefined) {
    return {};
  }

  const headers: Record<string, HeaderMatcher> = {...options.reqheaders};

  for (const name of options.badheaders ?? []) {
    headers[name] = (value: string | undefined) => value === undefined;
  }

  const {conditionally} = options;

  if (conditionally !== undefined) {
    headers[conditionallyHeader] = () => Boolean(conditionally());
  }

  return headers;
}

/** A header name no request can carry - the hook `conditionally` hangs off. See `scopeHeaders`. */
const conditionallyHeader = 'x-gotlike-nock-conditionally\u0000';

function nock(basePath: string | RegExp | Url | URL, options?: ScopeOptions): Scope {
  const {origin, path} = splitOrigin(basePath);

  return new Scope(origin, path, scopeHeaders(options));
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
  // Both only record the policy; the next dispatch applies it. See `netConnectPolicy`.
  disableNetConnect() {
    netConnectPolicy = false;
  },
  enableNetConnect(host?: NetConnectMatcher) {
    // Replaces whatever was allowed before, as nock's does - a string is a pattern, not a literal
    // host, and no argument allows everything.
    netConnectPolicy =
      typeof host === 'string'
        ? new RegExp(host)
        : host instanceof RegExp
          ? host
          : typeof host === 'function'
            ? {test: host}
            : true;
  },
  pendingMocks() {
    return mockAgent.pendingInterceptors();
  },
  /** Drop every interceptor registered so far, on every origin. */
  cleanAll() {
    for (const [key, entry] of pools) {
      const {pool, origin} = entry;
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
      } else {
        entry.active = false;
      }
    }
  },
  abortPendingRequests() {
    // A request already matched to an interceptor and now only waiting on `.delay()` never
    // gets a reply: its timer is cancelled without ever resolving, so `mockDispatch` never
    // completes it - the same "leave it hanging" behaviour real nock's own
    // `removeAllTimers`-based `abortPendingRequests` has. Registered-but-unused interceptors
    // are dropped too, as this shim has always done.
    for (const timer of pendingDelayTimers) {
      clearTimeout(timer);
    }

    pendingDelayTimers.clear();

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

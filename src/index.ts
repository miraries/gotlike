import dns from 'node:dns';
import {STATUS_CODES} from 'node:http';
import zlib from 'node:zlib';
import {Duplex, Readable} from 'node:stream';
import undici, {DecoratorHandler, Dispatcher, errors, getGlobalDispatcher, interceptors} from 'undici';
import type {IncomingHttpHeaders} from 'undici/types/header.js';

const {BodyTimeoutError, HeadersTimeoutError, RequestRetryError} = errors;

/**
 * Raise a synthetic stream's failure as soon as anything is listening for it, rather than
 * only when the stream is read.
 *
 * got emits a stream's error whether or not the stream is ever read, and the pattern that
 * relies on it is ordinary: attach `error` and `response` listeners, and pipe from inside the
 * `response` handler. A request that failed before any response never fires `response`, so
 * nothing ever read the stream, so the error was never raised and the caller waited for a
 * stream that had already failed.
 *
 * Destroying it unconditionally is what can't be done: an `error` no one is listening for is
 * an uncaught exception, and `await stream.response` - which reports this same failure, and
 * is what the README tells callers to await - attaches no listener at all. So the error is
 * raised when a listener exists and left to read time when none does, which covers both
 * without turning either into a crash.
 *
 * `setImmediate` rather than a microtask, for the reason the `response` event uses one: a
 * caller attaches its listeners after `await stream(...)`, which a queued microtask beats.
 */
function raiseWhenListening(stream: Readable, raise: () => void): void {
  function onNewListener(event: string | symbol) {
    if (event !== 'error') {
      return;
    }

    stream.off('newListener', onNewListener);
    // The listener being added isn't registered until this handler returns, so it would miss
    // an error emitted from inside it.
    setImmediate(raise);
  }

  setImmediate(() => {
    if (stream.listenerCount('error') > 0) {
      raise();
    } else {
      stream.on('newListener', onNewListener);
    }
  });
}

/**
 * A readable with no body, standing in for a request that failed. It raises the failure when
 * read, and `arm` hands it to `raiseWhenListening` as well - separately, so `asStream` can
 * order that behind the `response` event it may also have to emit.
 */
function failedReadable(error: Error): {stream: Readable; arm: () => void} {
  let raised = false;

  const raise = () => {
    if (raised) {
      return;
    }

    raised = true;
    stream.destroy(error);
  };

  const stream = new Readable({read: raise});

  return {stream, arm: () => raiseWhenListening(stream, raise)};
}

/**
 * Emit the `response` event, and emit it *before* any of the body reaches the caller.
 *
 * The head is already in hand by the time `stream()` resolves, so the emit has to be deferred
 * or the caller has no stream to have attached a listener to yet. `setImmediate` alone was not
 * enough: attaching a `data` listener - which `pipe()`, `on('data')` and `for await` all do, in
 * the same synchronous block as the `response` listener - starts the body flowing on a
 * `process.nextTick`, which runs first. Measured against got 16 on the same server, the got-shaped
 * proxy (`on('response', copyHead); pipe(res)`) saw `data` then `response` here and `response`
 * then `data` there - so a status and headers copied onto an outgoing response landed *after*
 * body bytes had already been written to it.
 *
 * `newListener` is what closes that gap: it fires before the listener is registered and before
 * `resume()` is called, so emitting from inside it puts the head in front of the first chunk for
 * the very consumer that is about to start the flow. The `setImmediate` stays as the path for a
 * caller that only ever awaits `stream.response` or listens for `response` alone.
 *
 * The one ordering this cannot fix is a `data` listener attached *before* a `response` one:
 * emitting then would throw the event away, so it is left to the `setImmediate` - which that
 * caller has already opted out of caring about by asking for data first.
 */
function announceHead(stream: Readable, head: StreamHead): void {
  let announced = false;

  const announce = (): void => {
    if (announced) {
      return;
    }

    announced = true;
    stream.off('newListener', onNewListener);
    stream.emit('response', head);
  };

  function onNewListener(event: string | symbol): void {
    // The two events that start a readable flowing. `pipe()` registers `data`; `for await`
    // and `on('readable')` register `readable`.
    if (event !== 'data' && event !== 'readable') {
      return;
    }

    // Nothing is waiting for the head yet, so emitting here would only discard it. The
    // `setImmediate` below still reaches a listener attached later.
    if (stream.listenerCount('response') > 0) {
      announce();
    }
  }

  stream.on('newListener', onNewListener);

  // On setImmediate, not a microtask: callers attach their listener after `await stream(...)`,
  // and a microtask queued before that await resolves fires first.
  setImmediate(announce);
}

/**
 * Present a response body as the stream `stream()` resolves to.
 *
 * A failure is raised by the readable itself - when first read, or when something starts
 * listening for it - rather than by destroying the stream outright. Destroying has no good
 * moment: synchronously, the error is emitted before an awaiting caller has attached a
 * listener; on a later tick, a small body has already been consumed and the read finished
 * cleanly. See `raiseWhenListening`.
 */
function asStream(readable: Readable, head: StreamHead | undefined, error?: Error): GotlikeStream {
  // Only built for a failure, so an ordinary response body allocates nothing extra here.
  const failed = error === undefined ? undefined : failedReadable(error);
  const stream = (failed?.stream ?? readable) as GotlikeStream;

  stream.response = head ? Promise.resolve(head) : Promise.reject(error ?? new Error('Request failed'));
  // Nothing is obliged to await this; an unhandled rejection would take the process down.
  stream.response.catch(() => undefined);

  if (head) {
    announceHead(stream, head);
  }

  // Armed after the `response` emit above is queued, so a caller listening for both sees them
  // in that order - the head first, then the failure it carries.
  failed?.arm();

  return stream;
}

/** Deliberate no-op, used where a rejection is already reported somewhere else. */
function noop(): void {}

/**
 * Errors that have already been through `toRequestError` - hooks run, class and code
 * assigned. `normaliseStreamErrors` skips these so a failure it already built (or one a
 * `beforeError` hook replaced it with) isn't wrapped, and the hooks aren't fired twice.
 *
 * A WeakSet rather than a marker property: a hook may hand back any error it likes,
 * including a frozen one, and tagging that would throw.
 */
const normalisedErrors = new WeakSet<object>();

/** The stream internals Node exposes for this but doesn't type. */
type DestroyableStream = Readable & {
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
  _readableState?: {errored?: unknown};
  _writableState?: {errored?: unknown};
};

/**
 * Make a stream report failures the way the promise API does: as a `RequestError` subclass,
 * with the `beforeError` hooks applied.
 *
 * Both stream paths hand back a stream undici owns - the response `Readable` on the bodyless
 * path, the `pipeline` `Duplex` on the upload path - and undici destroys it with its own raw
 * error. A connection refused arrived as a bare `Error`, a `timeout.request` as a
 * `DOMException` whose `code` is the number 23, and a socket reset mid-body as a
 * `SocketError`; none of them ran the `beforeError` hooks. got normalises every one of these,
 * and the README promises the same.
 *
 * `_destroy` is the seam for it. Node emits whatever error that callback is given rather than
 * the one it was called with, and the callback may be called asynchronously - which is what
 * makes awaiting the async `beforeError` hooks possible. undici's own `_destroy` still runs
 * first and does its cleanup; only the error handed onwards is replaced. Verified against
 * `for await`, an `error` listener and `stream.pipeline`.
 */
function normaliseStreamErrors<T extends Readable>(
  stream: T,
  normalise: (error: Error) => Promise<Error>,
  /** Whether this failure is the request's, rather than the consumer's. See `isRequestFailure`. */
  owns: (cleanupError: Error, destroyedWith: Error | null) => boolean,
): T {
  const target = stream as unknown as DestroyableStream;
  const original = target._destroy;

  target._destroy = function destroyNormalised(error, callback) {
    original.call(this, error, (cleanupError) => {
      if (!cleanupError || normalisedErrors.has(cleanupError) || !owns(cleanupError, error)) {
        callback(cleanupError);

        return;
      }

      normalise(cleanupError).then(
        (normalised) => {
          // `stream.errored` is public API and is latched from the raw error before `_destroy`
          // runs, so it would otherwise disagree with the error every listener is about to see.
          if (this._readableState?.errored) {
            this._readableState.errored = normalised;
          }

          if (this._writableState?.errored) {
            this._writableState.errored = normalised;
          }

          callback(normalised);
        },
        () => callback(cleanupError),
      );
    });
  };

  return stream;
}

/**
 * A `stream()` duplex for a request that failed before it could be dispatched.
 *
 * Both halves report the failure. The writable one used to accept and discard writes, on the
 * reasoning that a caller piping into it shouldn't get a second, less useful error - but that
 * made `await pipeline(readable, upload)` *resolve successfully* for a request that was never
 * sent, which is a far worse way to find out. The write callback is given the real error, so a
 * pipe rejects with it; the readable half still raises it at read time the way `asStream` does.
 */
function failedUploadStream(error: Promise<Error>): GotlikeUploadStream {
  error.catch(noop);

  let raised = false;

  const raise = () => {
    if (raised) {
      return;
    }

    raised = true;
    error.then((failure) => stream.destroy(failure), noop);
  };

  const stream = new Duplex({
    read: raise,
    write(_chunk, _encoding, callback) {
      // `error` always resolves - `toStreamError` returns the error rather than throwing it -
      // but a rejection handler keeps a write from hanging if that ever stops being true.
      error.then(callback, callback);
    },
    final(callback) {
      error.then(callback, callback);
    },
  }) as GotlikeUploadStream;

  stream.response = error.then<StreamHead>((failure) => {
    throw failure;
  });
  stream.response.catch(noop);

  // As on the readable path: a caller listening for `error` and never writing would otherwise
  // wait on a request that was never dispatched.
  raiseWhenListening(stream, raise);

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
    const name = String(headers[i]).toLowerCase();
    // A multi-valued header has to survive as an array. `String(['one', 'two'])` flattened it
    // to the single value `one,two`, so a request carrying `{'x-a': ['one', 'two']}` went out
    // as two headers before a redirect and one after it - and only for clients that have a
    // `beforeRedirect` hook, since nothing else reaches this. A name repeated across the flat
    // array is collected the same way.
    const raw = headers[i + 1];
    const value = Array.isArray(raw) ? raw.map(String) : String(raw);
    const existing = object[name];

    object[name] = existing === undefined ? value : ([] as string[]).concat(existing, value);
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

type RedirectState = DispatchState & {
  /**
   * The url of the most recent hop - which, once the chain has finished, is the url the
   * response actually came from. undici follows redirects inside its own interceptor and
   * never reports where it ended up, so `response.url` used to name the url that redirected
   * rather than the one that answered. got documents `response.url` as the *final* url.
   */
  lastUrl?: string;
};

type AttemptState = DispatchState & {
  onRetry?: (error: Error | undefined, statusCode: number | undefined, retryCount: number) => void;
  /** Starts the request deadline over for a new attempt. See `requestSignal`. */
  restartDeadline?: () => void;
  /**
   * Stops the attempt deadline while the retry interceptor is waiting to redispatch.
   *
   * Only ever a *guess* that a retry is coming - see `willRetryStatus`. `resumeDeadline`, called
   * the moment a response reaches the caller, is what makes a wrong guess harmless.
   */
  pauseDeadline?: () => void;
  /** Whether a response will be retried rather than exposed to the caller. */
  willRetryStatus?: (statusCode: number) => boolean;
  /**
   * Whether undici could still retry a *transport* failure on this attempt - which is what
   * decides whether the deadline waits for undici's own timeout instead of aborting. Only
   * present on a client whose `errorCodes` cover a timeout at all. See `requestSignal`.
   */
  canRetryError?: () => boolean;
};

/**
 * undici's typings don't expose `maxRedirections` as a per-request option, but the `redirect`
 * interceptor reads it off the dispatch options at runtime (see lib/interceptor/redirect.js).
 * Composing the interceptor once per client and overriding per request is what keeps
 * `followRedirect` a request option without rebuilding a dispatcher on every call.
 *
 * `attempts` and `redirects` are ours - the state holders the two trackers record onto.
 *
 * The retry interceptor reads a per-request `retryOptions` the same way, but `retry` is a
 * client-only option here, so nothing ever sets one and the field is not declared.
 */
type InterceptorOptions = {
  maxRedirections?: number;
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

    const attempts = this.#state as AttemptState;

    if (attempts.willRetryStatus?.(statusCode)) {
      attempts.pauseDeadline?.();
    }

    return super.onResponseStart(controller, statusCode, headers, statusMessage);
  }

  override onResponseError(controller: Dispatcher.DispatchController, error: Error) {
    this.#state.lastError = error;
    // Cleared, not left behind: an attempt that failed before its headers arrived produced no
    // status at all, and the previous one's survived here. A 503 followed by a socket reset
    // told `beforeRetry` that the reset had come with a 503 - a status the hook was free to
    // branch on, from a response it was never sent.
    this.#state.lastStatusCode = undefined;
    this.#state.lastHeaders = undefined;

    // There is no response body left to bound after a transport error. If undici retries it,
    // `countAttempts` starts a fresh deadline; if it does not, the request settles and releases
    // the timer anyway. Leaving it armed while the retry policy sleeps turns the backoff into
    // part of `timeout.request`, unlike got's per-attempt timeout.
    (this.#state as AttemptState).pauseDeadline?.();

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

/**
 * Drives `response.retryCount`, and `beforeRetry` when the client has such hooks.
 *
 * It also starts the redirect chain over, because a retry is a fresh chain: undici's
 * `RedirectHandler` counts hops per attempt and so must the tracker. This is composed
 * *outside* the redirect interceptor, so it runs before the re-dispatched attempt's first
 * hop, and the holder is the same object every hop sees - which is what makes resetting it
 * from here work at all. Left alone, the re-dispatch looked to the tracker like one more hop
 * of the previous attempt's chain: `beforeRedirect` fired with the status that caused the
 * retry (`503 -> /the-original-url`, which is not a redirect and no hook should be told
 * about), and `lastUrl` only came out right by accident, because that bogus hop happened to
 * overwrite it with the url the attempt was starting from.
 */
const countAttempts = trackDispatches(
  (opts) => opts.attempts,
  (state, opts) => {
    const redirects = (opts as InterceptorOptions).redirects;

    if (redirects) {
      redirects.count = 0;
      redirects.lastStatusCode = undefined;
      redirects.lastHeaders = undefined;
      redirects.lastError = undefined;
      // Cleared rather than kept: with no hop recorded for this attempt, `response.url`
      // falls back to the url that was requested, which is where the answer came from.
      redirects.lastUrl = undefined;
    }

    // A fresh attempt gets the whole of `timeout.request`, not what the last one left over.
    (state as AttemptState).restartDeadline?.();

    (state as AttemptState).onRetry?.(state.lastError, state.lastStatusCode, state.count - 1);

    /*
     * Consumed, so the attempt about to run starts with no outcome recorded. `canRetryError`
     * reads `lastStatusCode` to ask whether *this* attempt's head has already been delivered
     * (undici propagates rather than retries once it has), and the status of the attempt being
     * retried would answer "yes" for a request that has not even been sent - so a 503 followed
     * by a hang lost its retry. Nothing else reads these between here and the next dispatch.
     */
    state.lastStatusCode = undefined;
    state.lastHeaders = undefined;
    state.lastError = undefined;
  },
);

/**
 * Records where a redirect chain ended up, and fires `beforeRedirect` hooks. The hop's
 * outgoing options are still mutable at this point, which is what lets a hook re-add a header
 * undici stripped on a cross-origin redirect.
 *
 * Composed whenever the client follows redirects at all, not only when it has hooks: the
 * final url is needed either way, since undici never reports it and `response.url` has to.
 *
 * The state holder has to arrive with the dispatch options rather than be attached on the
 * first hop: `RedirectHandler` copies the options in its constructor - before hop 1 reaches
 * here - and re-dispatches later hops with that copy, so anything attached on hop 1 is
 * invisible to hop 2.
 */
function makeRedirectTracker(hooks?: Hooks['beforeRedirect']): Dispatcher.DispatcherComposeInterceptor {
  return trackDispatches(
    (opts) => opts.redirects,
    (state, opts) => {
      /*
       * Unreachable in practice, and kept anyway: `countAttempts` resets `redirects.count` to 0
       * on a retry, so a retried attempt's first hop never reaches this callback and there is no
       * re-dispatch left that carries no status. It still earns its place as the narrowing that
       * makes `lastStatusCode` a `number` for the hook call below - removing it is a type error,
       * not a no-op - and as the second guard on the bug in the comment above.
       */
      if (state.lastStatusCode === undefined) {
        return;
      }

      // The hop about to be dispatched. The last one recorded is where the response came
      // from, which is what `response.url` and `StreamHead.url` report.
      const origin = String(opts.origin ?? '');
      const path = String(opts.path ?? '');

      (state as RedirectState).lastUrl =
        origin.endsWith('/') && path.startsWith('/') ? origin + path.slice(1) : origin + path;

      if (!hooks) {
        return;
      }

      const request: RedirectRequest = {
        origin,
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

/**
 * Keeps one caller's abort from failing every other request `dedupe` collapsed onto it.
 *
 * undici's deduplicate interceptor sends the first of a group of identical in-flight requests and
 * parks the rest on it, and the dispatch it sends is controlled by *that first caller alone*: its
 * `abort` tears the shared request down, and the error it aborted with is handed to every parked
 * request (`DeduplicationHandler.onResponseError`). Here every request with a `timeout.request`
 * or a `signal` aborts through its own controller, so - measured - one caller's `abort()` failed
 * a second, unrelated caller with `AbortError`, and a 100ms deadline failed a request that had
 * asked for 5s with `TimeoutError` at 100ms. Nothing on the second request had been aborted.
 *
 * Two interceptors, one either side of `dedupe`. `outer` wraps every request dedupe could group
 * in an `IsolatedAbortHandler`, whose controller is the only way anything above reaches the
 * dispatch. `inner` sees what dedupe actually sends: a group's first request arrives wrapped in
 * dedupe's own handler, and `lead` counts every request dedupe then parks on it, through that
 * handler's own `addWaitingHandler`. An abort ends *this* caller's request at once, with its own
 * reason, and leaves the dispatch running only while something is parked on it; otherwise it is
 * aborted for real, exactly as before. A parked request's controller is already its own (dedupe
 * gives each one a separate controller), so aborting it never needs isolating.
 *
 * Counted through dedupe rather than by a key of our own. A key of origin, method and path - what
 * this used to count - is coarser than dedupe's, which also compares headers, and dedupe also
 * sends a request independently once the first one's body has started streaming. Both counted as
 * parked when nothing was: an aborted request with a different `authorization` was left running,
 * holding its socket and draining its body, until undici's 300s default timeout if no
 * `timeout.request` was set. A consumer destroying a response body goes through the same `abort`,
 * and is covered by the same rule.
 */
function isolateDedupedAborts(methods: readonly string[]): {
  inner: Dispatcher.DispatcherComposeInterceptor;
  outer: Dispatcher.DispatcherComposeInterceptor;
} {
  /**
   * The request passing through `dedupe` right now. dedupe dispatches synchronously, so `inner`
   * reads it before anything else can dispatch.
   */
  let entering: IsolatedAbortHandler | undefined;

  const outer: Dispatcher.DispatcherComposeInterceptor = (dispatch) =>
    function IsolateDedupedAborts(opts, handler) {
      // Nothing dedupe would not group, which is also why the handler has no upgrade path.
      if (!methods.includes(opts.method) || opts.upgrade) {
        return dispatch(opts, handler);
      }

      const isolated = new IsolatedAbortHandler(handler);
      const previous = entering;

      entering = isolated;

      try {
        return dispatch(opts, isolated);
      } finally {
        entering = previous;
      }
    };

  const inner: Dispatcher.DispatcherComposeInterceptor = (dispatch) =>
    function WatchDedupeLeaders(opts, handler) {
      const leader = entering;

      entering = undefined;

      // dedupe passes a request it sends on its own through unchanged; one it wrapped leads a group.
      if (leader !== undefined && handler !== leader) {
        leader.lead(handler as unknown as DedupeGroup);
      }

      return dispatch(opts, handler);
    };

  return {inner, outer};
}

/** The part of undici's `DeduplicationHandler` that parks a request on the one it sent. */
type DedupeGroup = {addWaitingHandler?: (handler: Dispatcher.DispatchHandler) => boolean};

/**
 * The controller an `IsolatedAbortHandler` hands upwards in place of the shared dispatch's.
 * Everything but `abort` goes straight through; `abort` asks the handler first.
 */
class IsolatedController {
  /** The shared dispatch's controller, once it has started. */
  target?: Dispatcher.DispatchController;
  /** Set once this caller has been failed on its own; the handler drops everything after. */
  detached = false;
  #aborted = false;
  #reason: Error | null = null;
  #onAbort: (reason: Error) => void;

  constructor(onAbort: (reason: Error) => void) {
    this.#onAbort = onAbort;
  }

  pause(): void {
    this.target?.pause();
  }

  resume(): void {
    this.target?.resume();
  }

  abort(reason: Error): void {
    if (this.#aborted) {
      return;
    }

    this.#aborted = true;
    this.#reason = reason;
    this.#onAbort(reason);
  }

  get aborted(): boolean {
    return this.#aborted || (this.target?.aborted ?? false);
  }

  get reason(): Error | null {
    return this.#reason ?? this.target?.reason ?? null;
  }

  get paused(): boolean {
    return !this.detached && (this.target?.paused ?? false);
  }

  // undici's request handler reads these off the controller it was given.
  get rawHeaders(): unknown {
    return (this.target as {rawHeaders?: unknown} | undefined)?.rawHeaders;
  }

  get rawTrailers(): unknown {
    return (this.target as {rawTrailers?: unknown} | undefined)?.rawTrailers;
  }
}

class IsolatedAbortHandler implements Dispatcher.DispatchHandler {
  #handler: Dispatcher.DispatchHandler;
  /** Requests dedupe has parked on this one's dispatch and that are still reading it. */
  #waiters = 0;
  /** The request this one is parked on, when it is parked. */
  #leader?: IsolatedAbortHandler;
  #settled = false;
  #controller = new IsolatedController((reason) => this.#abort(reason));

  constructor(handler: Dispatcher.DispatchHandler) {
    this.#handler = handler;
  }

  /**
   * Count the requests dedupe parks on this one, by wrapping the `addWaitingHandler` of the
   * handler dedupe sent it with. If undici ever renames that, nothing is counted and an abort
   * tears the dispatch down as it would without this interceptor - which the dedupe tests catch.
   * Uncovered by design, like nock's `cleanMocks()` fallback.
   */
  lead(group: DedupeGroup): void {
    const add = group.addWaitingHandler;

    if (typeof add !== 'function') {
      return;
    }

    // Every request dedupe can park came through `outer`, which is keyed on the same methods.
    group.addWaitingHandler = (parked) => {
      const handler = parked as IsolatedAbortHandler;

      // Counted before the call: dedupe starts the parked request inside it, and a caller that
      // aborts right there is counted back out through `#settle`.
      handler.#leader = this;
      this.#waiters++;

      const added = add.call(group, handler);

      // Not parked - dedupe sends it on its own - so it never started and never settles here.
      if (!added) {
        handler.#leader = undefined;
        this.#waiters--;
      }

      return added;
    };
  }

  /** Counted out of its leader exactly once, however the request ended. */
  #settle(): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;

    if (this.#leader !== undefined) {
      this.#leader.#waiters--;
    }
  }

  #abort(reason: Error): void {
    const controller = this.#controller;
    const target = controller.target;

    // Nothing parked on this dispatch, or it is a parked request's own: abort it as undici would.
    if (target === undefined || this.#settled || this.#waiters === 0) {
      target?.abort(reason);

      return;
    }

    controller.detached = true;
    this.#settle();

    // Backpressure this caller applied must not stall the requests still reading the dispatch.
    if (target.paused) {
      target.resume();
    }

    this.#handler.onResponseError?.(controller as unknown as Dispatcher.DispatchController, reason);
  }

  get #upstream(): Dispatcher.DispatchController {
    return this.#controller as unknown as Dispatcher.DispatchController;
  }

  onRequestStart(controller: Dispatcher.DispatchController, context: any): void {
    this.#controller.target = controller;
    this.#handler.onRequestStart?.(this.#upstream, context);
  }

  onResponseStart(
    controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    statusMessage?: string,
  ): void {
    if (!this.#controller.detached) {
      this.#handler.onResponseStart?.(this.#upstream, statusCode, headers, statusMessage);
    }
  }

  onResponseData(controller: Dispatcher.DispatchController, chunk: Buffer): void {
    if (!this.#controller.detached) {
      this.#handler.onResponseData?.(this.#upstream, chunk);
    }
  }

  onResponseEnd(controller: Dispatcher.DispatchController, trailers: IncomingHttpHeaders): void {
    this.#settle();

    if (!this.#controller.detached) {
      this.#handler.onResponseEnd?.(this.#upstream, trailers);
    }
  }

  onResponseError(controller: Dispatcher.DispatchController, error: Error): void {
    this.#settle();

    if (!this.#controller.detached) {
      this.#handler.onResponseError?.(this.#upstream, error);
    }
  }
}

type RetryHandlerOptions = NonNullable<Parameters<typeof interceptors.retry>[0]>;

type UndiciRequestOptions = NonNullable<Parameters<typeof undici.request>[1]> & InterceptorOptions;
type UndiciPipelineOptions = NonNullable<Parameters<typeof undici.pipeline>[1]> & InterceptorOptions;

/** The fields both `undici.request` and `undici.pipeline` accept. */
type SharedDispatchOptions = UndiciRequestOptions &
  UndiciPipelineOptions & {
    /**
     * Cancels the request deadline's timer. Must be called once the request is settled - for a
     * stream, once the stream is done rather than once the head has arrived. A no-op when no
     * `timeout.request` was set. See `requestSignal`.
     */
    release: () => void;

    /**
     * Puts back a deadline the retry bookkeeping paused for a retry that never came. Must be
     * called as soon as a response reaches the caller, on every path. A no-op when nothing is
     * paused, which is every ordinary request. See `requestSignal`.
     */
    resume: () => void;
  };

/** The `release` of a request that has no deadline to cancel. */
const noRelease = (): void => {};

/**
 * Cancel a stream's deadline once the request is really over.
 *
 * `close` rather than `end`: it fires whether the stream finished or was destroyed, so a
 * failed download releases as surely as a completed one. An unconsumed stream never closes,
 * and that is correct - the request is still in flight and still wants its deadline.
 */
function releaseOnClose(stream: Readable, release: () => void): void {
  if (release !== noRelease) {
    stream.once('close', release);
  }
}

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

const leadingSlashes = /^\/+/;

/**
 * What `options.url` is set to once resolved: a `URL`, as got hands handlers and hooks, so
 * `options.url.href`, `.pathname` and an in-place `options.url.searchParams.set('sig', …)` all
 * work as they do there. `String()` of it is also what undici puts on the wire - percent-encoded,
 * host lower-cased, a bare origin given its `/`. It used to be the raw string, so a hook signing
 * it signed `/a b/ü` while the server received `/a%20b/%C3%BC`, and `.href` was `undefined`.
 * ~300ns a call; the url is parsed here instead of only inside undici.
 *
 * Lenient: a url `new URL` rejects is handed back as the string, so it still fails where it
 * always did - inside the dispatch, as `ERR_INVALID_URL`, or on the stand-in stream for `stream()`.
 */
function asUrl(url: string): URL | string {
  try {
    return new URL(url);
  } catch {
    return url;
  }
}

/** Credentials carried in a url's authority, and the url with them removed. */
type Userinfo = {
  url: string;
  username: string;
  password: string;
};

/**
 * Whether this character ends `scheme://authority`.
 *
 * **`\` is one of them**, and leaving it out changed which host a request went to. WHATWG URL
 * treats a backslash as a path separator for the special schemes (http/https/ws/wss/ftp) this
 * client ever sends, so `http://allowed.host\@attacker.host/p` parses to host `allowed.host`
 * with the path `/@attacker.host/p`. A scan that stopped only at `/?#` ran the authority all
 * the way to the `/`, found the `@` inside it, and rewrote the url to
 * `http://attacker.host/p` - handing the request, and an `Authorization` minted out of the
 * fake userinfo, to a host no URL parser ever named. An application that allowlists
 * `new URL(input).hostname` and then passes the string to the client - which is how an SSRF
 * filter is written - saw the allowed host and reached the other one. Only reachable with
 * `parseUserinfo` on, which is the default, so the default was the unsafe setting.
 *
 * A query directly on the host (`http://host?a=1`) is legal, so `?` and `#` bound it too.
 */
function isAuthorityEnd(code: number): boolean {
  // `/`, `?`, `#`, `\`
  return code === 47 || code === 63 || code === 35 || code === 92;
}

/**
 * ASCII tab, LF and CR, which WHATWG URL strips out of a url *before* parsing it - so they can
 * never reach `URL.username`/`URL.password`, and must not reach the credentials derived here
 * either. They cannot move the host: undici re-parses the url this hands back and strips them
 * itself, so only the extracted userinfo needs the cut.
 */
const urlWhitespace = /[\t\n\r]/g;

/**
 * Pull `user:pass@` out of `http://user:pass@host/path`.
 *
 * got promotes a url's userinfo to Basic auth - it keeps `username`/`password` *on* the `URL`
 * object, and node's `urlToHttpOptions` turns those into the `Authorization` header. undici
 * does no such thing, so the credentials were dropped and the request went out anonymous; all
 * the caller saw was a 401 with nothing pointing at the cause.
 *
 * Scans rather than parses: the authority is located by index and `@` is only looked for
 * inside it, so a url with an `@` in its path (`/users/@me`) costs no more than the two
 * `indexOf`s every url already pays, and nothing is allocated unless credentials are there.
 * `isAuthorityEnd` is what keeps that scan agreeing with WHATWG about where the authority
 * stops - read its note before narrowing it.
 */
function splitUserinfo(url: string): Userinfo | undefined {
  const scheme = url.indexOf('://');

  if (scheme === -1) {
    return undefined;
  }

  const start = scheme + 3;
  let end = url.length;

  for (let i = start; i < url.length; i++) {
    if (isAuthorityEnd(url.charCodeAt(i))) {
      end = i;
      break;
    }
  }

  // Last `@`, since the password may legally contain one.
  const at = url.lastIndexOf('@', end - 1);

  if (at < start) {
    return undefined;
  }

  const userinfo = url.slice(start, at).replace(urlWhitespace, '');
  const separator = userinfo.indexOf(':');

  return {
    url: url.slice(0, start) + url.slice(at + 1),
    // Percent-decoded, the way node decodes `url.username`/`url.password` before base64ing
    // them - so a credential containing `@` or `:` round-trips as got's does.
    username: decodeURIComponent(separator === -1 ? userinfo : userinfo.slice(0, separator)),
    password: separator === -1 ? '' : decodeURIComponent(userinfo.slice(separator + 1)),
  };
}

/**
 * Whether a username/password pair is worth an `Authorization` header.
 *
 * Empty is not the same as absent. got keeps credentials on a `URL` and node's
 * `urlToHttpOptions` derives `auth` only when `url.username || url.password`, so `{username:
 * ''}` and `http://@host/` both go out anonymous there. Testing `!== undefined` sent
 * `Authorization: Basic Og==` for both - an anonymous credential an upstream is free to reject
 * or log - for a `{username: config.user ?? ''}` that meant "no credentials at all".
 */
function hasCredentials(username?: string, password?: string): boolean {
  return (username !== undefined && username !== '') || (password !== undefined && password !== '');
}

/** A single `searchParams` / `form` value. Arrays of these repeat the key. */
export type QueryValue = string | number | boolean | null | undefined;

/** got's default. undici's is 5, which is a lot more load on an upstream that is already failing. */
const defaultRetryLimit = 2;

/** undici's defaults, named here too so deadline bookkeeping follows its retry decision. */
const defaultRetryMethods: readonly Dispatcher.HttpMethod[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
  'TRACE',
  'QUERY',
];
const defaultRetryStatusCodes: readonly number[] = [500, 502, 503, 504, 429];

/**
 * How undici spells a timeout. got spells the same failure `ETIMEDOUT`, and that is the name a
 * caller migrating from got writes into `retry.errorCodes` - so a list carrying got's name has
 * to cover undici's two as well or it matches nothing at all. See `resolveErrorCodes`.
 */
const timeoutErrorCodes = ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'] as const;

/**
 * undici's own default `errorCodes` (`lib/handler/retry-handler.js`), **plus the two timeout
 * codes**.
 *
 * got retries a timed-out request by default (`ETIMEDOUT` is in its default `retry.errorCodes`)
 * and undici does not, so a client configured `{retry: {limit: n}, timeout: {request: ms}}` -
 * which is the ordinary shape for a flaky upstream - got no retries at all for the one failure
 * it was most likely configured for. Measured against got 16: an upstream that never answers
 * ran four attempts there and one here.
 *
 * Spelled out rather than left to undici so the timeouts can be added; the rest of the list is
 * undici's verbatim. See also `requestSignal`, which is what gives undici's own timeout the
 * chance to fire at all.
 */
const defaultRetryErrorCodes: readonly string[] = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  ...timeoutErrorCodes,
];

/**
 * The `errorCodes` undici is given: the defaults above, or the caller's list with got's
 * `ETIMEDOUT` translated into undici's two codes.
 *
 * Translated rather than passed through, because `retry.errorCodes: ['ETIMEDOUT', ...]` is what
 * a got call site already says, and undici never raises that code - so the option was accepted,
 * validated, and then matched nothing. Both names are left in the list: `ETIMEDOUT` is harmless
 * there and removing it would be a surprise for anyone reading the client back.
 */
function resolveErrorCodes(errorCodes?: string[]): string[] {
  if (errorCodes === undefined) {
    return [...defaultRetryErrorCodes];
  }

  // Copied either way, like every other option a client keeps: `mergeRecords` copies the `retry`
  // object but not the arrays inside it, so this was undici holding the caller's own array and a
  // later `codes.push(...)` widening what an already-built client retried.
  if (!errorCodes.includes('ETIMEDOUT')) {
    return [...errorCodes];
  }

  return [...errorCodes, ...timeoutErrorCodes.filter((code) => !errorCodes.includes(code))];
}

/**
 * `RESOLUTION_MS` from undici's `lib/util/timers.js`, which is also the *floor* on when undici
 * can report a timeout of its own. Measured against undici 8.10.2: a `headersTimeout` of 100,
 * 300 or 900 all fired at ~1000ms, and one of 1200 fired at ~1500.
 */
const undiciTimerResolution = 1000;

/** How late past its nominal delay an undici timer may fire (`TICK_MS` is `RESOLUTION_MS / 2 - 1`). */
const undiciTimerLateness = 500;

/**
 * How long the request deadline waits past `timeout.request` before aborting an attempt undici
 * could still retry, or `undefined` when it should not wait at all. See `requestSignal`.
 *
 * Long enough to clear undici's own lateness, so its retryable `UND_ERR_HEADERS_TIMEOUT` /
 * `UND_ERR_BODY_TIMEOUT` is what fires. Not attempted below undici's timer floor: undici cannot
 * report a timeout before ~1s however small `headersTimeout` is, so waiting there would multiply
 * a bound the caller set deliberately - a `timeout: {request: 100}` would fail at 1700ms instead
 * of 100ms - which is a worse trade than the missing retry. Recorded in the README.
 */
function retryGrace(timeout: number): number | undefined {
  return timeout < undiciTimerResolution ? undefined : undiciTimerLateness + 200;
}

/** Hops followed before undici gives up and hands back the redirect itself. got's default too. */
const maxRedirections = 10;

/**
 * The code on an `HTTPError`, and got's own spelling of it.
 *
 * This used to be `ERR_HTTP_ERROR`. got says `ERR_NON_2XX_3XX_RESPONSE`, and the difference is
 * not cosmetic for a drop-in: a consumer that hand-writes got's code for its own synthetic
 * errors - which `igd-aggregator-api` does in four places - ends up reporting one condition
 * under two codes, half from the client and half from itself.
 */
const httpErrorCode = 'ERR_NON_2XX_3XX_RESPONSE';

/**
 * A url with its query and its fragment removed.
 *
 * Whichever marker comes first wins, which is all either caller needs: a `?` after a `#` is
 * inside the fragment and goes with it, and a `#` after a `?` is after the query and goes too.
 *
 * This sits on the hot path through `resolveUrl`, and cutting once is measurably *cheaper* than
 * what it replaced - which sliced the fragment off and then searched that copy for the `?`,
 * allocating an intermediate string for every url carrying a fragment. Measured over a mix of
 * urls with and without each marker, each implementation in a fresh process with a monomorphic
 * call site: 18.6 ns/call here against 21.5 for the old inline version and 24.6 for the same old
 * logic extracted into a function.
 *
 * Measure it that way if you change it. A single-process comparison that calls each candidate
 * through the same variable makes that call site polymorphic and reports whichever ran first as
 * twice as fast - two implementations with byte-identical bodies measured 8.6 and 20.2 ns that
 * way, which is the same position bias `benchmark/` documents.
 */
function withoutQuery(url: string): string {
  const fragment = url.indexOf('#');
  const query = url.indexOf('?');

  const cut = fragment === -1 ? query : query === -1 ? fragment : Math.min(fragment, query);

  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Headers that must not follow a request across an origin boundary, in got's own list.
 *
 * `host` is here because a stale one addresses the previous origin's vhost; the other four are
 * credentials, and handing them to a host the caller did not authorise them for is the whole
 * problem. undici already strips these when *it* follows a cross-origin redirect. Nothing did
 * when a `beforeRequest` hook or an `afterResponse` retry moved the origin, which is the same
 * leak by a route the client controls.
 */
const crossOriginHeaders = ['authorization', 'cookie', 'cookie2', 'host', 'proxy-authorization'] as const;

/** The index just past `scheme://authority`, by the same rule `splitUserinfo` scans with. */
function authorityEnd(url: string): number {
  const scheme = url.indexOf('://');

  if (scheme === -1) {
    return 0;
  }

  for (let index = scheme + 3; index < url.length; index++) {
    if (isAuthorityEnd(url.charCodeAt(index))) {
      return index;
    }
  }

  return url.length;
}

/**
 * Whether two absolute urls share an origin.
 *
 * The common case - a hook that rewrote the path or appended a signature to the query - is
 * answered by comparing the authority text in place, which allocates nothing and parses
 * nothing. Only when that text actually differs is `URL` reached for, and then it is answering
 * the question properly: a default port written out (`http://h:80/` against `http://h/`), a
 * host in a different case, or userinfo on one side are all the same origin, and got compares
 * `URL.origin` for exactly that reason.
 *
 * A url that cannot be parsed is treated as a *different* origin. This decides whether
 * credentials travel, so the unparseable case has to fail towards stripping them.
 */
function sameOrigin(previous: string, next: string): boolean {
  const end = authorityEnd(previous);

  if (end !== 0 && end === authorityEnd(next)) {
    let identical = true;

    for (let index = 0; index < end; index++) {
      if (previous.charCodeAt(index) !== next.charCodeAt(index)) {
        identical = false;
        break;
      }
    }

    if (identical) {
      return true;
    }
  }

  try {
    return new URL(previous).origin === new URL(next).origin;
  } catch {
    return false;
  }
}

/**
 * What the cross-origin headers held before the `beforeRequest` hooks ran.
 *
 * The *values*, not just whether they were set, because they are the second of two signals
 * `stripCrossOrigin` needs. `trackHookWrites` answers "did a hook touch this" and is the better
 * answer where it applies - but it only sees writes made *through* `options.headers`, and a hook
 * is free to replace that object outright (`options.headers = {authorization: ...}`), which
 * throws the Proxy away along with everything it recorded. Comparing values catches that case,
 * and comparing writes catches the case values cannot (a hook re-asserting an identical string).
 * Neither alone is enough; see `stripCrossOrigin`.
 *
 * One small object, and only for a client that has `beforeRequest` hooks at all - a client
 * without them cannot move the origin here, and allocates nothing. It has to be taken eagerly:
 * whether the origin moved is only known after the hooks have run, and by then the headers it
 * records have been overwritten.
 */
type CrossOriginState = {
  authorization: unknown;
  cookie: unknown;
  cookie2: unknown;
  host: unknown;
  proxyAuthorization: unknown;
};

function crossOriginState(options: FormedOptions): CrossOriginState {
  const headers = options.headers;

  return {
    authorization: headers['authorization'],
    cookie: headers['cookie'],
    cookie2: headers['cookie2'],
    host: headers['host'],
    proxyAuthorization: headers['proxy-authorization'],
  };
}

/** What `beforeRequest` hooks explicitly wrote, as opposed to what they merely left standing. */
type HookWrites = {
  /** Header names, lower-cased, that a hook assigned or deleted - regardless of the value. */
  headers: Set<string>;
  body: boolean;
  /**
   * Take the instrumentation back off, leaving plain data properties behind. Must be called
   * once the hooks have finished - see `trackHookWrites`.
   */
  restore: () => void;
};

/**
 * Wraps `options.headers` and the `body` property of `options` for the duration of the
 * `beforeRequest` hook loop, so `stripCrossOrigin` can ask "did a hook touch this" instead of
 * "does it still equal what it was before the hooks ran".
 *
 * That equality check is what `crossOriginState`/`stripCrossOrigin` used on their own: a hook
 * that explicitly re-asserted the very same `authorization` string, or rebuilt a body that
 * happened to serialise identically, read as untouched and was stripped anyway - the opposite
 * of what "values set by the hook survive" promises. got tells the two apart with its own
 * `trackStateMutations`, a Proxy over the options being merged; this is the same idea scoped to
 * the handful of fields the cross-origin boundary cares about, and only ever installed for a
 * client that has `beforeRequest` hooks in the first place.
 *
 * **For the duration of the hook loop, and no longer.** The Proxy used to stay on
 * `options.headers` all the way to the dispatch, so undici read every header of every request
 * through it - measured at ~780ns a request against ~19ns for the plain object, on a client
 * whose entire documented overhead is under 500ns, and paid by the one kind of client that
 * always has hooks. `restore()` puts the plain objects back the moment the hooks are done, so
 * the cost is the two allocations and the handful of writes a hook actually makes. It leaves a
 * `headers` a hook replaced wholesale alone, since the Proxy is no longer what is there.
 */
function trackHookWrites(options: FormedOptions): HookWrites {
  const names = new Set<string>();
  const target = options.headers;

  // No `receiver`: passing the Proxy back as one sends the write round through
  // `[[DefineOwnProperty]]` on the Proxy again, which is the slow path and buys nothing here -
  // `target` is a plain object with no accessors of its own.
  const proxy = new Proxy(target, {
    set(obj, prop, value) {
      if (typeof prop === 'string') {
        names.add(prop.toLowerCase());
      }

      return Reflect.set(obj, prop, value);
    },
    deleteProperty(obj, prop) {
      if (typeof prop === 'string') {
        // Added, not removed: a hook that *deletes* a header has said what the request should
        // carry just as surely as one that assigns it, and the strip below must not put its
        // own interpretation back over the top.
        names.add(prop.toLowerCase());
      }

      return Reflect.deleteProperty(obj, prop);
    },
  });

  options.headers = proxy;

  let body = options.body;
  const writes: HookWrites = {
    headers: names,
    body: false,
    restore: () => {
      if (options.headers === proxy) {
        options.headers = target;
      }

      /*
       * `delete options.body` takes the accessor away with the value, so the setter never fires
       * and nothing below would know the hook had said anything at all. Re-defining `body` from
       * the closure then put the body the hook had just removed straight back on the wire - and
       * only on a client that *has* `beforeRequest` hooks, since one without them never installs
       * the accessor and the delete works there. Read as a write of `undefined`, which is what a
       * hook deleting a *header* already counts as (see the `deleteProperty` trap above): both
       * are the hook saying what the request should carry.
       */
      if (!Object.hasOwn(options, 'body')) {
        writes.body = true;
        body = undefined;
      }

      Object.defineProperty(options, 'body', {
        value: body,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  };

  Object.defineProperty(options, 'body', {
    configurable: true,
    enumerable: true,
    get: () => body,
    set: (value: FormedOptions['body']) => {
      writes.body = true;
      body = value;
    },
  });

  return writes;
}

/**
 * Drop what must not cross an origin boundary, keeping whatever the hook set for the new one.
 *
 * A header the hook wrote - assigned or deleted, tracked by `trackHookWrites` rather than
 * compared by value - is the hook saying "these are the credentials for where I am sending
 * this", so it survives; one it never touched was meant for the origin being left, and goes.
 * Equality used to stand in for "did a hook touch this", which mistook a hook explicitly
 * re-asserting the very same `authorization` string (or rebuilding a body that happened to
 * serialise identically) for one that had left it alone, and stripped it anyway - the opposite
 * of what "values set by the hook survive" promises. The body follows the same rule: a hook
 * that assigned it, even back to an equal value, built it for the new origin. `content-type`
 * and `content-length` describe the body being dropped, and a stale `content-length` would fail
 * the dispatch outright under undici's `strictContentLength`.
 *
 * Measured against got 16, which strips the same five headers, keeps a hook-set `authorization`
 * and a hook-set body, and drops an unchanged one along with its `content-type`.
 */
function stripCrossOrigin(options: FormedOptions, before: CrossOriginState, writes: HookWrites): void {
  const headers = options.headers;

  /*
   * A header goes only when *both* signals say the hook left it alone - it recorded no write
   * through `options.headers`, and the value standing there is still the one from before.
   *
   * Either test alone gets a real case wrong, in opposite directions. Writes alone miss a hook
   * that assigned a whole new headers object (`options.headers = {authorization: ...}`), which
   * discards the Proxy and everything it had recorded: measured, such a hook's freshly minted
   * credentials for the *new* origin were deleted and the request went out anonymous, where got
   * 16 sends them. Values alone miss a hook that re-asserted an identical string, which is the
   * bug `trackHookWrites` was added for. Requiring both keeps each one's case.
   */
  if (
    before.authorization !== undefined &&
    !writes.headers.has('authorization') &&
    headers['authorization'] === before.authorization
  ) {
    delete headers['authorization'];
  }

  if (before.cookie !== undefined && !writes.headers.has('cookie') && headers['cookie'] === before.cookie) {
    delete headers['cookie'];
  }

  if (before.cookie2 !== undefined && !writes.headers.has('cookie2') && headers['cookie2'] === before.cookie2) {
    delete headers['cookie2'];
  }

  if (before.host !== undefined && !writes.headers.has('host') && headers['host'] === before.host) {
    delete headers['host'];
  }

  if (
    before.proxyAuthorization !== undefined &&
    !writes.headers.has('proxy-authorization') &&
    headers['proxy-authorization'] === before.proxyAuthorization
  ) {
    delete headers['proxy-authorization'];
  }

  /*
   * The body needs only the one signal: its accessor sits on `options` itself, which a hook
   * cannot replace the way it can replace `options.headers`, so `writes.body` never goes blind.
   * `content-type` and `content-length` are dropped on the write test alone for the same reason
   * they are dropped at all - there is no body left for them to describe, whoever set them.
   */
  if (options.body !== undefined && !writes.body) {
    options.body = undefined;
    options.json = undefined;
    options.form = undefined;

    if (!writes.headers.has('content-type')) {
      delete headers['content-type'];
    }

    if (!writes.headers.has('content-length')) {
      delete headers['content-length'];
    }
  }
}

function basicAuthorization(username?: string, password?: string): string {
  return 'Basic ' + Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64');
}

/**
 * `url` carrying `searchParams` as its query, replacing whatever query it had - the rule
 * `resolveUrl` applies, for a url that is already resolved.
 *
 * For a `beforeRequest` hook that wrote to `options.searchParams` and left `options.url` alone.
 * The url is resolved *before* the hooks run, so the write was read by nothing: in got 12 both
 * `options.searchParams = {...}` and `options.searchParams.set(...)` land on the request url,
 * and here a signature or an api key added that way silently never left the process. Compared
 * against the query the url already carries rather than tracked, because an in-place `.set()` on
 * the `URLSearchParams` is invisible to any accessor - and the comparison hands back `url`
 * untouched for a hook that never went near the query. Only reached by a client that has
 * `beforeRequest` hooks and a request that carries `searchParams`.
 */
function withQuery(url: string, searchParams: SearchParams): string {
  const search = stringifyQuery(searchParams);
  const query = url.indexOf('?');

  if (search === (query === -1 ? '' : url.slice(query + 1))) {
    return url;
  }

  return search ? withoutQuery(url) + '?' + search : withoutQuery(url);
}

/**
 * Honour a `beforeRequest` hook that set `options.username`/`options.password`.
 *
 * The Basic-auth header is derived before the hooks run, so a hook supplying credentials this way
 * sent the request anonymously - or with the credentials it was replacing. got 12 keeps them on the
 * request url and node derives the header at dispatch, so the hook's are the ones that go out.
 *
 * The header is only re-derived when it is the one derived from the previous credentials (or there
 * is none): an `authorization` the caller or the hook set explicitly wins, as it does everywhere
 * else - node likewise only applies `auth` when no `Authorization` header is set.
 */
function applyHookCredentials(
  options: FormedOptions,
  before: {username?: string; password?: string},
  derived: string | undefined,
  writes: HookWrites,
): void {
  if (options.username === before.username && options.password === before.password) {
    return;
  }

  const current = options.headers['authorization'];

  if (writes.headers.has('authorization') || (current !== undefined && current !== derived)) {
    return;
  }

  if (hasCredentials(options.username, options.password)) {
    options.headers['authorization'] = basicAuthorization(options.username, options.password);
  } else {
    delete options.headers['authorization'];
  }
}

/**
 * got's phrasing for an HTTP error, **without the query string**.
 *
 * got names the full url, which is genuinely useful in a log line and is also how a signature,
 * an api key or a session token in a query string ends up in every log and APM group that
 * prints the error. The path is what identifies the request; the query is what leaks. So the
 * url goes in and the query comes off, and that is the one deliberate difference from got's
 * message left.
 *
 * The status text is node's canonical one rather than the wire's: undici surfaces a response's
 * real `statusMessage` only to a dispatch handler, not through `undici.request()`. The two
 * differ only for a server sending a non-standard reason phrase.
 *
 * Cost lives entirely on the failure path - nothing here runs for a request that succeeds, or
 * for one that fails with `throwHttpErrors` off.
 */
function httpErrorMessage(statusCode: number, options: FormedOptions): string {
  const status = STATUS_CODES[statusCode];

  return (
    `Request failed with status code ${statusCode}` +
    (status === undefined ? '' : ` (${status})`) +
    `: ${options.method} ${withoutQuery(String(options.url))}`
  );
}

/**
 * How many times an `afterResponse` hook may call `retryWithMergedOptions` for one request.
 * Generous enough that no real refresh-and-retry flow reaches it, and finite so that a hook
 * which always sees the status it retries on fails with this error instead of recursing until
 * the process dies.
 */
const maxAfterResponseRetries = 20;

/** Carries the `retryWithMergedOptions` depth on the options. A symbol, so option spreads
 * copy it while `for...in` validation and `Object.keys` never see it. */
const retryDepth = Symbol('gotlike.retryDepth');

/**
 * How far into the `afterResponse` array a hook-driven retry should run, carried the same way.
 *
 * A retry re-enters `call()`, which used to run *every* `afterResponse` hook again from the
 * start - so with `[log, refreshAuth]` a refreshed request logged twice, and `refreshAuth` saw
 * its own retry and could go round again. got cuts the array at the hook that retried
 * (`hooks.afterResponse.slice(0, index)`), so the hooks before it run again and it does not.
 */
const afterResponseLimit = Symbol('gotlike.afterResponseLimit');

/**
 * The url `handle()` resolved before running the handler chain, carried the same way, so `call()`
 * can tell a url a handler rewrote from the one it was handed. See `call()`.
 */
const resolvedForHandlers = Symbol('gotlike.resolvedForHandlers');

type RetryDepth = {[retryDepth]?: number; [afterResponseLimit]?: number; [resolvedForHandlers]?: string};

/**
 * Serialise `searchParams` / `form` values.
 *
 * An entry that is `undefined` is dropped and one that is `null` is sent with an empty value,
 * rather than either being stringified into a literal `?foo=undefined` / `?foo=null`. That is
 * got's rule for `searchParams`; for `form` got builds the body with
 * `new URLSearchParams(form)`, which stringifies both, and the difference is recorded in the
 * README's divergence table rather than copied - see `appendQuery`.
 *
 * An array value repeats the key (`?a=1&a=2`). Falling through to `String(value)` joined it
 * with a comma into a single `?a=1%2C2` instead - a wrong query string, produced silently.
 * That is a second, deliberate divergence on `form`, and on `searchParams` a place where this is
 * simply more permissive than got: got *rejects* an array `searchParams` value (one string,
 * number, boolean or null per key) and stringifies an array `form` value to `a=1%2C2`, the same
 * `new URLSearchParams(form)` artefact as the nullish rule above. Both halves are pinned in the
 * parity suite and in the README's divergence table.
 */
function stringifyQuery(input: SearchParams): string {
  /*
   * A string is re-encoded, not handed over as written.
   *
   * `resolveUrl` concatenates the result straight onto the url, so anything the caller's string
   * contains lands in the url as a url *character*: the first `#` opened a fragment, everything
   * after it went with the fragment, and a fragment is never sent - so
   * `searchParams: 'next=/home#top&b=2'` reached the server as `?next=/home` with `b` gone
   * entirely, silently and on the wire. That is the same failure `withoutQuery` fixed for the
   * *joined* url; it was never fixed for the query being appended to it.
   *
   * `URLSearchParams` is what got runs a string through too, so this also settles a divergence
   * the suites could not see: `a=1;b=2` and `q=a b` now encode as got encodes them. And it makes
   * the option self-consistent - `mergeSearchParams` already round-trips a string, so a string
   * query behaved one way on a client that also had one and another way on a client that didn't.
   *
   * The constructor strips a leading `?` itself, so the manual slice this replaces is redundant.
   */
  if (typeof input === 'string') {
    return new URLSearchParams(input).toString();
  }

  if (input instanceof URLSearchParams) {
    return input.toString();
  }

  const params = new URLSearchParams();

  appendQuery(params, input);

  return params.toString();
}

type SearchParams = NonNullable<RequestOptions['searchParams']>;

/**
 * Append one `searchParams` value onto a `URLSearchParams`.
 *
 * Split out of `stringifyQuery` so that merging two of them applies exactly the rules
 * serialising one does, rather than a second copy of them.
 */
function appendQuery(params: URLSearchParams, input: SearchParams): void {
  if (typeof input === 'string' || input instanceof URLSearchParams) {
    for (const [key, value] of typeof input === 'string' ? new URLSearchParams(stringifyQuery(input)) : input) {
      params.append(key, value);
    }

    return;
  }

  for (const key in input) {
    // Own properties only, here and at every other `for...in` over something a caller handed
    // us. The prototype chain is walked too, so a library that had put an enumerable property
    // on `Object.prototype` added it to the query of every request that went out.
    if (!Object.hasOwn(input, key)) {
      continue;
    }

    const value = input[key];

    /*
     * `undefined` is dropped and `null` is sent as an empty value, which is got's rule for
     * `searchParams` (`Options.set searchParams` appends `''` for a null and skips an
     * undefined) and the distinction JavaScript already draws between the two.
     *
     * Dropping `null` as well is what this used to do, and it lost a parameter off the wire
     * with nothing said: `{a: null, b: 1}` went out as `?b=1` where got sends `?a=&b=1`, so an
     * upstream that tells "absent" from "present and empty" - a filter being cleared, a
     * tri-state flag, anything signing over the canonical query - saw a different request.
     */
    if (value === undefined) {
      continue;
    }

    if (value === null) {
      params.append(key, '');

      continue;
    }

    if (Array.isArray(value)) {
      // Per item, by the same rule: an array is how a key is repeated, so a `null` in one is
      // still a value of that key and an `undefined` is still nothing at all.
      for (const item of value) {
        if (item === undefined) {
          continue;
        }

        params.append(key, item === null ? '' : queryValue(key, item));
      }

      continue;
    }

    params.append(key, queryValue(key, value));
  }
}

/**
 * Merge a client's `searchParams` with a call's, the way got merges them.
 *
 * The shallow spread `formOptions` and `extend` are built on replaced the whole query, so a
 * client carrying an api key, a tenant id or a version flag lost it the moment a call named a
 * parameter of its own - silently, and on the wire rather than at the call site. got merges
 * the two (`Options.searchParams` under `_merging`): keys the override names replace every
 * occurrence of that key, keys it doesn't are kept, and a key it names as `undefined` is
 * dropped rather than replaced. Measured against got 16 - `{apiKey, v}` plus `{page: 2}` goes
 * out as `?apiKey=secret&v=1&page=2`, and a replaced key moves to the end.
 *
 * Only ever called with both sides present: when one is missing there is nothing to merge and
 * the spread has already picked the right one, which is what keeps the usual request free.
 */
function mergeSearchParams(base: SearchParams, override: SearchParams): URLSearchParams {
  const merged = new URLSearchParams();

  appendQuery(merged, base);

  /*
   * An object override is walked by its own keys, not by what it serialises to, so a key it
   * sets to `undefined` still clears the base's - that is got's spelling of "drop the one the
   * client set", and `appendQuery` contributes nothing for it afterwards.
   */
  if (typeof override === 'object' && !(override instanceof URLSearchParams)) {
    for (const key in override) {
      if (Object.hasOwn(override, key)) {
        merged.delete(key);
      }
    }

    appendQuery(merged, override);

    return merged;
  }

  // A string or a `URLSearchParams` is parsed once and then used for both halves.
  const updated = override instanceof URLSearchParams ? override : new URLSearchParams(stringifyQuery(override));

  for (const key of updated.keys()) {
    merged.delete(key);
  }

  for (const [key, value] of updated) {
    merged.append(key, value);
  }

  return merged;
}

/**
 * Snapshot a client's own `searchParams` at create/extend time, so mutating the object the
 * caller passed in afterwards cannot reach back into the client.
 *
 * `mergeOptions`'s spread, and `extend()`'s one-sided fallback, both handed back the caller's
 * own `URLSearchParams`/object *by reference* - `createClient({searchParams: params})` followed
 * by `params.set(...)` changed every request the client made afterwards, silently and on the
 * wire, which is exactly the failure mode `mergeRecords`/`concatHooks`/`mergeHooks` already
 * guard `context`/`handlers`/`hooks` against. `mergeSearchParams` itself always builds a fresh
 * `URLSearchParams`, so only the case where one side is absent - the one the shallow spread was
 * relying on to be cheap - needed this. A string is immutable and returned as-is.
 */
function cloneSearchParams(value?: SearchParams): SearchParams | undefined {
  if (value === undefined || typeof value === 'string') {
    return value;
  }

  return value instanceof URLSearchParams ? new URLSearchParams(value) : {...value};
}

/**
 * One query/form value as a string.
 *
 * An object has no sensible serialisation here and `String(value)` produced the literal
 * `a=%5Bobject+Object%5D` - a wrong query string, sent without complaint. got rejects the same
 * input; one `typeof` per value is nothing against the request it is about to make.
 */
function queryValue(key: string, value: QueryValue | readonly QueryValue[]): string {
  if (typeof value === 'object') {
    invalid(`\`${key}\` must be a string, number, boolean or an array of those, got an object`);
  }

  return String(value);
}

/**
 * Apply `queryValue`'s rule to every entry of a `searchParams` / `form`, eagerly.
 *
 * `validateOptions` checks the container's shape and stops there, so a bad *value* was only
 * found when the query was serialised - which for a client option meant not at create time but
 * once per request, for the life of the client, with nothing said at the call site that built
 * it. Everything else a client is configured with is rejected where it is written.
 *
 * Create/extend only (`atCreation`), which is what keeps it off the hot path: a per-request
 * `searchParams` is still checked lazily by `queryValue`, and reports the same message.
 */
function validateQueryValues(input: SearchParams | NonNullable<RequestOptions['form']>): void {
  if (typeof input === 'string' || input instanceof URLSearchParams) {
    return;
  }

  for (const key in input) {
    // Own properties only, as everywhere else something a caller handed us is walked.
    if (!Object.hasOwn(input, key)) {
      continue;
    }

    const value = input[key];

    // `null`/`undefined` are dropped rather than serialised, so they are not values to reject.
    if (value === null || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && item !== undefined) {
          queryValue(key, item);
        }
      }

      continue;
    }

    queryValue(key, value);
  }
}

/** Status codes that cannot carry a response body, per RFC 9110. */
const bodylessStatusCodes = new Set([204, 205, 304]);

function isOk(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/**
 * What `throwHttpErrors` acts on.
 *
 * A 3xx is an error only when the client was *following* redirects: reaching the caller then
 * means undici gave up - a chain longer than `maxRedirections` - and the response is the
 * redirect itself rather than the thing it points at. That used to resolve as a success with
 * the redirect page as its body. got draws the line in exactly the same place (`limitStatusCode`
 * is 299 when following and 399 when not), 304 excepted, since a conditional request that is
 * answered "not modified" succeeded.
 */
function isHttpError(statusCode: number, followsRedirects: boolean): boolean {
  if (statusCode === 304) {
    return false;
  }

  return statusCode < 200 || statusCode >= (followsRedirects ? 300 : 400);
}

function hasNoBody(statusCode: number, method: string): boolean {
  return method === 'HEAD' || bodylessStatusCodes.has(statusCode);
}

function hasHeader(headers: IncomingHttpHeaders, name: string): boolean {
  // Own properties throughout: an enumerable `Object.prototype` property would otherwise read
  // as a header this request already carries, and suppress the `content-type` a body needs.
  if (Object.hasOwn(headers, name) && headers[name] !== undefined) {
    return true;
  }

  for (const key in headers) {
    if (!Object.hasOwn(headers, key)) {
      continue;
    }

    // The value has to be defined, not just the key present. `{'content-type': undefined}` is
    // how "unset" reaches undici everywhere else here, and counting it as a header that was
    // already set sent a json body with no `content-type` at all.
    if (headers[key] !== undefined && key.toLowerCase() === name) {
      return true;
    }
  }

  return false;
}

/**
 * Whether an `afterResponse` hook handed back something usable.
 *
 * A hook that falls off the end returns `undefined`, and the next thing to touch it was
 * `response.statusCode` - so the whole request failed with `Cannot read properties of
 * undefined`, naming neither the hook nor the request. got makes the same check.
 *
 * Only `statusCode` is tested, deliberately: got also insists on a non-null `body`, which
 * here would reject the perfectly good `undefined` body of a 204 read as json.
 */
function isResponseLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Response).statusCode === 'number';
}

/** Dispatches minus the first attempt. */
function retriesFrom(attempts?: {count: number}): number {
  return attempts ? Math.max(attempts.count - 1, 0) : 0;
}

/**
 * Fold header names to lower case. Header names are case-insensitive on the wire, but an
 * object merge is not: `{...{Authorization: old}, ...{authorization: new}}` keeps both, undici
 * sends both, and which one the server honours is anyone's guess.
 */
function lowercaseHeaders(headers?: IncomingHttpHeaders): IncomingHttpHeaders {
  const normalised: IncomingHttpHeaders = {};

  for (const key in headers) {
    // Dropped rather than copied when unset, so `{'Content-Type': undefined}` doesn't survive
    // as a key that `hasHeader` would have to keep second-guessing. Own properties only: an
    // enumerable property on `Object.prototype` was otherwise copied in here and sent as a
    // header on every request - and a non-writable one made `new Gotlike(...)` itself die with
    // a raw `TypeError` out of this loop.
    if (Object.hasOwn(headers, key) && headers[key] !== undefined) {
      normalised[key.toLowerCase()] = headers[key];
    }
  }

  return normalised;
}

/**
 * Whether any header name still carries an upper-case letter.
 *
 * `formOptions` folds everything it merges, so the only way one gets in is a handler or a
 * `beforeRequest` hook writing `options.headers.Authorization` directly - and then undici sends
 * both that and the `authorization` already there, leaving the server to pick. Checked by
 * scanning rather than by folding blindly: the scan allocates nothing, and the answer is almost
 * always no.
 */
function hasUnfoldedName(headers: IncomingHttpHeaders): boolean {
  for (const key in headers) {
    if (!Object.hasOwn(headers, key)) {
      continue;
    }

    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);

      if (code >= 65 && code <= 90) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Fold a method to upper case, the way got's `set method` does.
 *
 * Methods are upper-case on the wire, and `httpMethods` is the upper-case list - so a caller
 * writing `{method: 'post'}` got a `ValidationError` here where got would have normalised it
 * and sent the request, which is a hard stop for code migrating over. Worse with
 * `validate: false`, where the lower-case value slipped past the check and then missed
 * `isBodyMethod`/`hasNoBody`, routing a POST down the bodyless path.
 *
 * Scanned before folding, as `hasUnfoldedName` scans: the answer is almost always "already
 * upper case", and the scan allocates nothing where `toUpperCase()` may.
 */
function normaliseMethod<T extends string>(method: T): T {
  for (let i = 0; i < method.length; i++) {
    const code = method.charCodeAt(i);

    if (code >= 97 && code <= 122) {
      return method.toUpperCase() as T;
    }
  }

  return method;
}

/**
 * Merge per-call headers over a set that is already lower-cased, folding the override's names
 * as they go in. Only the override is walked - the instance defaults are normalised once, at
 * construction, so re-folding them on every request would be wasted work on the hot path.
 */
function mergeHeaders(base: IncomingHttpHeaders, override?: IncomingHttpHeaders): IncomingHttpHeaders {
  const merged: IncomingHttpHeaders = {...base};

  for (const key in override) {
    if (!Object.hasOwn(override, key)) {
      continue;
    }

    merged[key.toLowerCase()] = override[key];
  }

  return merged;
}

/** The one timeout got's `timeout` object supports here. See `RequestOptions.timeout`. */
type Timeout = {request?: number};

/**
 * Merge two `timeout` objects, keeping the base's `request` when the override names none.
 *
 * `mergeRecords` would not do: `{request: undefined}` is a key that is *present*, so a plain
 * spread clobbers the parent's deadline with nothing - which is exactly the shape a config
 * that didn't set a timeout produces (`{request: config.timeout}`). Only `request` is
 * supported, so this is the whole merge; `formOptions` applies the same rule per request
 * without allocating.
 */
function mergeTimeout(base?: Timeout, override?: Timeout): Timeout | undefined {
  if (override === undefined) {
    return base && {...base};
  }

  return {...base, ...override, request: override.request ?? base?.request};
}

/**
 * Spread `override` over `base` into a fresh object, ignoring keys the override names as
 * `undefined`.
 *
 * A key that is *present* with the value `undefined` wins a plain spread, and that is the
 * shape a caller writes constantly: `{throwHttpErrors: opts.throwHttpErrors}`, forwarded from
 * a config that didn't set one. got skips `undefined` when it merges options, so a plain
 * spread was a silent divergence on every option at once - `throwHttpErrors` resolving a 500
 * as a success, `responseType` falling past the `json`/`text` arms to the buffer one,
 * `followRedirect` leaving a 302 to resolve as a success whose body is the redirect page,
 * `handlers` skipping the client's own chain, and `searchParams`/`timeout` dropping the
 * client's query and deadline. That last pair is the bug `mergeSearchParams` and `mergeTimeout`
 * exist to prevent, arriving by the other route: both are guarded on `!== undefined`, which is
 * exactly the case that never fires here.
 *
 * Repaired after the spread rather than replacing it. The spread is what carries the symbol
 * keys `retryWithMergedOptions` tracks depth with, and the usual request names no `undefined`
 * option at all - so the loop walks a handful of keys, finds nothing and writes nothing. The
 * `undefined` test comes before `Object.hasOwn` for that reason: it rejects almost every key
 * on one property read, and the ownership check only has to rule out an inherited key for the
 * rare one that gets past it.
 */
function mergeOptions<T extends object>(base: T, override?: object): T {
  const merged = {...base, ...override} as Record<string, unknown>;

  for (const key in override) {
    if (Object.hasOwn(override, key) && (override as Record<string, unknown>)[key] === undefined) {
      merged[key] = (base as Record<string, unknown>)[key];
    }
  }

  return merged as T;
}

/** Shallow-merge two optional records into a fresh object. */
function mergeRecords<T extends object>(base?: T, override?: T): T | undefined {
  if (!base) {
    // Copied, not handed back: returning `override` made the client's `context`/`retry` the
    // caller's own object, so mutating what was passed to `extend()` afterwards changed the
    // client. The same reasoning as the base-only case below, from the other side.
    return override && {...override};
  }

  // Copied even when only the base is present. Returning `base` itself made an extended
  // client's `context` the *same object* as its parent's, so writing through the child's
  // `baseOptions` changed the parent too. Only ever runs on the create/extend path.
  return override ? {...base, ...override} : {...base};
}

const hookNames = ['beforeRequest', 'afterResponse', 'beforeError', 'beforeRetry', 'beforeRedirect'] as const;

/**
 * Every key `RetryOptions` declares, checked the same way `knownOptionMap` checks the
 * top-level options - a typo here does not throw the way a top-level one does otherwise.
 * `retry: {limt: 0}` used to be accepted outright and silently enabled the *default* two
 * retries instead of the caller's intended zero, since nothing ever read the misspelled key.
 */
const knownRetryKeys = new Set<keyof RetryOptions>([
  'limit',
  'methods',
  'statusCodes',
  'errorCodes',
  'backoffLimit',
  'maxRetryAfter',
]);

/**
 * got options this does not implement, and the reason, so they report themselves as missing
 * rather than as misspelled.
 *
 * got accepts all of these (measured against got 16), and the retry pair is documented here as
 * "not implemented" - which reads as "ignored", not "the client will not construct". A caller
 * dropping gotlike into a `got-cjs@12` call site that tunes its backoff deserves to be told
 * which it is. Still a hard failure, because the alternative is a `calculateDelay` that silently
 * never runs and an `init` hook that silently never fires, which is the very thing the
 * unknown-key check was added to stop. Recorded in the README's divergence table.
 */
const unimplementedOptions = new Map<string, string>([
  ['retry.calculateDelay', "undici's RetryHandler owns the backoff schedule; use `retry.backoffLimit` to cap it"],
  ['retry.noise', "undici's RetryHandler owns the backoff schedule"],
  ['hooks.init', 'no equivalent stage - `beforeRequest` receives the formed options instead'],
  // got's per-phase timeouts. Accepting and ignoring one left the request bounded by whatever
  // else was set, or by nothing at all - `extend({timeout: {response: 100_000}})` is how the
  // aggregator writes it. `extend()` is generic, so the type does not stop it either.
  ...['lookup', 'connect', 'secureConnect', 'socket', 'send', 'response', 'read'].map(
    (phase) =>
      [
        `timeout.${phase}`,
        phase === 'connect' || phase === 'secureConnect'
          ? 'bound the connection with the client-level `connectTimeout`, or the whole request with `timeout.request`'
          : 'only `timeout.request` is supported, and it bounds every phase of the request',
      ] as const,
  ),
]);

/** Reject a known got option this does not implement, saying so. Falls through for a typo. */
function rejectUnimplemented(qualified: string): void {
  const reason = unimplementedOptions.get(qualified);

  if (reason !== undefined) {
    invalid(`\`${qualified}\` is not implemented by gotlike - ${reason}`);
  }
}

/** Concatenates every hook array, so extending a client adds to its hooks rather than replacing them. */
function mergeHooks(base?: Hooks, override?: Hooks): Hooks | undefined {
  if (!base && !override) {
    return undefined;
  }

  /*
   * No early return for either side being absent: `concatHooks` below copies each array, and
   * returning one side unchanged skips that. Returning `base` left the child sharing the
   * parent's `hooks` object and every array in it; returning `override` - which is what
   * extending a *hookless* client did, the default singleton included - handed the child the
   * caller's own object, so a later `hooks.beforeRequest.push(...)` added a hook to a client
   * that had already been built. Both directions contradict what this file promises about
   * extend(), and the second was the likelier one to hit, since most parents have no hooks.
   */
  const merged: Hooks = {};

  for (const name of hookNames) {
    // Assigned through a cast because each hook name has its own signature; `concatHooks`
    // is generic over the element type and the names do not unify.
    (merged as Record<string, unknown[] | undefined>)[name] = concatHooks(
      base?.[name] as unknown[] | undefined,
      override?.[name] as unknown[] | undefined,
    );
  }

  return merged;
}

/**
 * The array a client runs a hook kind from, or `undefined` when there is nothing to run - which
 * is what lets `call()` check one truthy field per request instead of a length.
 *
 * **A copy, not the array on `baseOptions`.** Handing the same array back made
 * `client.baseOptions.hooks.beforeRequest` *be* `client.beforeRequestHooks`, and `formOptions`
 * aliases `hooks` onto the formed options deliberately - so the live chain was reachable from
 * `response.request.options.hooks` and `error.options.hooks`, both of which this package hands to
 * every caller. A `push` through either added a hook to the client permanently, and because
 * `call()` walks `this.beforeRequestHooks` with `for...of`, one made during the loop also ran in
 * the request that made it. The comment justifying the aliasing said the opposite ("both are
 * consumed at construction, so a write through them cannot change the client"); this is what
 * makes that true. Once per client, so it costs nothing that matters.
 */
function usedHooks<T>(hooks?: T[]): T[] | undefined {
  return hooks?.length ? [...hooks] : undefined;
}

function concatHooks<T>(base?: T[], added?: T[]): T[] | undefined {
  if (!base) {
    // Copied, not handed back: the array the caller passed to `extend()` stayed live inside
    // the client (`usedHooks` doesn't copy either), so pushing to it afterwards changed the
    // client's hooks or handlers underneath it.
    return added && [...added];
  }

  // A fresh array either way, so an extended client never shares the parent's: pushing onto
  // `child.baseOptions.handlers` used to add a handler to the parent as well.
  return added ? [...base, ...added] : [...base];
}

/**
 * The signal a dispatch actually runs under.
 *
 * got's `timeout.request` caps the *whole* request. undici's `headersTimeout`/`bodyTimeout`
 * are per-phase, and `bodyTimeout` restarts on every chunk received - so a response that
 * trickles a byte at a time never trips either one, and a request under a 1.5s timeout was
 * measured still running at 4.9s. Both are still set, since they produce the more specific
 * error when they do fire, but the deadline below is what actually bounds the request.
 *
 * It also sidesteps undici's coarse timer wheel (`lib/util/timers.js`, `RESOLUTION_MS = 1000`),
 * which used to round every sub-second timeout up to roughly a second.
 *
 * **The deadline waits, once, for an attempt undici could still retry.** Aborting through a
 * signal is the one failure undici will never retry: `RetryHandler.onResponseError` propagates
 * outright when the connection's controller was aborted, and the signal stays aborted for every
 * later attempt anyway. Since the deadline is armed before the dispatch and undici arms its own
 * `headersTimeout` only once the request has been *sent*, the deadline always won that race - so
 * a request under `{retry: {limit: n}, timeout: {request: ms}}` was never retried at all, however
 * `retry.errorCodes` was set. Measured against got 16: an upstream that never answers ran four
 * attempts there and one here.
 *
 * So when `canRetryError` says undici would retry this attempt's transport failure, the abort is
 * deferred by `retryGrace` to let undici's own (retryable) timeout fire first. Deferred at most
 * once per attempt, and only while a retry is genuinely possible - the last attempt, a
 * non-replayable body, a method outside the retry list, a client with no `retry` at all, a
 * `timeout.request` under undici's timer floor, and a failure *after* the response head (which
 * undici propagates rather than retries, and which is the trickling-body case this deadline
 * exists for) all keep the exact deadline. Only the *failure* of an attempt is ever delayed by
 * this; nothing about a request that succeeds changes.
 */
function requestSignal(
  options: FormedOptions,
  attempts?: AttemptState,
): {
  signal?: AbortSignal;
  release: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
} {
  const timeout = options.timeout?.request;

  if (timeout === undefined) {
    return {
      signal: options.signal,
      release: noRelease,
      pause: noRelease,
      resume: noRelease,
      restart: noRelease,
    };
  }

  // Built from an `AbortController` rather than `AbortSignal.timeout`, which cannot be
  // cancelled: an abandoned one is retained until its timer fires, so a request that finished
  // in 5ms under a 30s timeout held its signal for the remaining 29995ms. Measured at ~885
  // bytes a piece, which is ~265MB of uncollectable heap at 10k requests/second - and the
  // longer the timeout, the worse it gets. Releasing on settle keeps it to the requests
  // actually in flight.
  const controller = new AbortController();
  /** Only a client that retries transport failures has anything to wait for. */
  const grace = attempts?.canRetryError ? retryGrace(timeout) : undefined;
  /** Whether this attempt has already used its one deferral. Reset by `restart`. */
  let deferred = false;

  const arm = (delay: number): NodeJS.Timeout =>
    setTimeout(() => {
      // Undici's own `headersTimeout`/`bodyTimeout` raise an error it *will* retry; this abort
      // is one it never will. So hand the attempt over rather than killing it - once.
      if (!deferred && grace !== undefined && attempts?.canRetryError?.()) {
        deferred = true;
        timer = arm(grace);

        return;
      }

      // The same `TimeoutError` DOMException `AbortSignal.timeout` reports, message included,
      // so `isTimeoutReason` and anything a caller matches on are unchanged.
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      // As `AbortSignal.timeout` does: a pending deadline must not hold the process open.
    }, delay).unref();

  let timer = arm(timeout);
  /** Whether a `pause` is outstanding, so `resume` knows there is a deadline owed. */
  let paused = false;

  /*
   * The caller's signal is forwarded through a listener this can take back off again, **not**
   * through `AbortSignal.any`.
   *
   * `AbortSignal.any` registers the composite in the *source* signal's internal dependant-signal
   * set, and nothing ever removes it - there is no API to. So every request made with both a
   * `signal` and a `timeout.request` left one entry behind on the caller's signal, permanently:
   * measured at 485 bytes a request that no GC can reclaim, and 1971 entries on the signal after
   * 2000 requests. A signal that lives as long as the process - the "abort everything on
   * shutdown" controller, which is exactly the shape people share across requests - therefore
   * grew without bound. That is the same failure `AbortSignal.timeout` was dropped for above,
   * except that this one never ends rather than ending when a timer fires.
   *
   * `addEventListener`/`removeEventListener` is what undici's own `addAbortListener` does for the
   * signal it is handed, and `release` - which every path already calls once the request is
   * settled - is where the listener comes off. The reason is forwarded as it stands, so
   * `isTimeoutReason` and `options.signal?.aborted` are unchanged.
   */
  let detach = noRelease;
  const source = options.signal;

  if (source) {
    if (source.aborted) {
      controller.abort(source.reason);
    } else {
      const onAbort = () => controller.abort(source.reason);

      source.addEventListener('abort', onAbort, {once: true});
      detach = () => source.removeEventListener('abort', onAbort);
    }
  }

  return {
    signal: controller.signal,
    release: () => {
      paused = false;
      clearTimeout(timer);
      detach();
    },
    pause: () => {
      paused = true;
      clearTimeout(timer);
    },
    /*
     * Put back a deadline that `pause` took away and no re-dispatch came for.
     *
     * `pause` fires on a *prediction* that undici is about to retry (`willRetryStatus`), and a
     * prediction that misses used to leave the request running with no deadline whatsoever -
     * measured, a `timeout: {request: 400}` against a trickling body was still going at 4s with
     * no error, where the same request one status code away gave up at 406ms. Every path calls
     * this the moment a response actually reaches it, which is the point at which nothing can
     * be retrying it any more, so a wrong guess costs a restarted clock rather than the whole
     * deadline. A no-op when nothing is paused, which is every ordinary request.
     */
    resume: () => {
      if (paused) {
        paused = false;
        timer = arm(timeout);
      }
    },
    /*
     * `timeout.request` bounds an *attempt*, as got's does and as undici's own
     * `headersTimeout`/`bodyTimeout` do - so a retry starts the clock again. One signal spans
     * every attempt undici makes, so without this the deadline was a cumulative budget for the
     * whole retry sequence: measured against got 16, a `timeout: {request: 400}` with
     * `retry: {limit: 4}` against an upstream answering in 150ms ran all five attempts there
     * (1045ms) and gave up after three here (404ms). A request configured to retry was being
     * denied most of its retries, which is the opposite of what either option asks for. The
     * `OutcomeHandler` pauses the old attempt's timer before undici starts its backoff, and
     * this starts it again only when the new attempt is actually dispatched.
     */
    restart: () => {
      paused = false;
      // A new attempt, so it gets its own deferral as well as its own clock.
      deferred = false;
      clearTimeout(timer);
      timer = arm(timeout);
    },
  };
}

/**
 * The message to report a failure under: the underlying error's own, when it has one.
 *
 * `fallback` covers an error thrown with an empty message, and a non-`Error` thrown value -
 * which is rare but perfectly legal, and would otherwise produce `message: undefined`.
 */
/**
 * Whether a failure is a timeout rather than a plain abort.
 *
 * Both arrive through the same seam - an aborted signal - so the reason has to be consulted:
 * `AbortSignal.timeout()` gives a `TimeoutError` DOMException, `abort()` an `AbortError`, and
 * `abort(reason)` whatever the caller passed. Checking the signal as well as the thrown value
 * covers the case where undici rethrows the reason verbatim.
 */
function isTimeoutReason(error: unknown, signal?: AbortSignal): boolean {
  return (
    (error as Error | undefined)?.name === 'TimeoutError' ||
    (signal?.aborted === true && (signal.reason as Error | undefined)?.name === 'TimeoutError')
  );
}

/**
 * Whether the error a stream is being destroyed with is the **request's** failure, rather than
 * the consumer's own.
 *
 * `normaliseStreamErrors` works by wrapping `_destroy`, which Node calls for every destroy -
 * including the ones the caller makes. So a consumer-side failure was being reported as a
 * transport failure: measured, `pipeline(stream, destinationThatThrows)` ran the client's
 * `beforeError` hooks with `RequestError/ERR_REQUEST_ERROR: disk full`, and a deliberate
 * `stream.destroy()` ran them with `AbortError/ERR_ABORTED`. In a service that proxies a
 * download - the shape the README's own `on('response'); pipe(res)` example documents - every
 * client disconnect (`ERR_STREAM_PREMATURE_CLOSE`) would have been reported as an upstream
 * failure, and `stream.errored` rewritten to a fabricated one. The hooks are awaited inside the
 * destroy callback too, so a slow hook delayed the teardown of a stream the caller had already
 * given up on, and with it `releaseOnClose`'s cancellation of the deadline.
 *
 * Three questions, in order:
 *
 * - **`destroyedWith`** is what `destroy()` was called with. undici never destroys a stream of
 *   its own without an error, so a `null` here is always the consumer abandoning the stream - a
 *   bare `stream.destroy()`, a `for await` with a `break`, a `pipeline` that finished early.
 *   undici's own `_destroy` still runs and still manufactures a `RequestAbortedError` for the
 *   request it is tearing down, but that error is a *consequence* of the destroy rather than the
 *   reason for it, and raw undici reports it the same way.
 * - **Before a response head** there is nothing for a consumer to have been reading, so every
 *   failure the stream can carry is the request's - including the raw system errors
 *   (`ECONNREFUSED` and friends) that the upload path surfaces through its duplex.
 * - **After it**, undici reports its own failures as `UndiciError`s - `UND_ERR_SOCKET` for a body
 *   cut short (verified against undici 8.10.2 with a truncated `content-length`),
 *   `UND_ERR_BODY_TIMEOUT`, `UND_ERR_ABORTED` - and a deadline or a caller abort arrives through
 *   the signal. Anything else reaching a stream that has already delivered its head came from
 *   downstream.
 */
function isRequestFailure(
  cleanupError: Error,
  destroyedWith: Error | null,
  signal: AbortSignal | undefined,
  /** A thunk, so a teardown that is settled by the first test never builds the response. */
  responded: () => boolean,
): boolean {
  if (destroyedWith === null || destroyedWith === undefined) {
    return false;
  }

  if (!responded()) {
    return true;
  }

  return (
    cleanupError instanceof errors.UndiciError || isTimeoutReason(cleanupError, signal) || signal?.aborted === true
  );
}

/**
 * The underlying error's own `code`, which is what got reports: its `RequestError` takes
 * `error.code ?? 'ERR_GOT_REQUEST_ERROR'`, so a connection refused arrives as `ECONNREFUSED`
 * and a DNS failure as `ENOTFOUND`. Every generic failure here used to be flattened to
 * `ERR_REQUEST_ERROR`, with the real code reachable only through `cause` - so the `err.code
 * === 'ECONNREFUSED'` that a got caller writes matched nothing at all.
 *
 * Whatever undici raised is passed through as it stands, which is exact for the errno codes
 * it surfaces from the socket and undici's own (`UND_ERR_SOCKET`) for the failures it
 * describes itself. The fallback covers a value with no code, and a `DOMException`, whose
 * `code` is a legacy *number* (23 for a timeout) that nothing matching on a string wants.
 */
function codeOf(error: unknown, fallback: string): string {
  const code = (error as {code?: unknown} | undefined)?.code;

  return typeof code === 'string' && code !== '' ? code : fallback;
}

function messageOf(error: unknown, fallback: string): string {
  // `throw 'boom'` is legal and says something; reporting the generic label instead loses it.
  if (typeof error === 'string' && error !== '') {
    return error;
  }

  const message = (error as Error | undefined)?.message;

  return typeof message === 'string' && message !== '' ? message : fallback;
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

/**
 * got's `retry`, minus what undici's `RetryHandler` can't express: `calculateDelay` and
 * `noise` have no equivalent, and `maxRetryAfter` degrades to a boolean (see the constructor).
 */
type RetryOptions = {
  limit: number;
  methods: Dispatcher.HttpMethod[];
  statusCodes: number[];
  errorCodes: string[];
  backoffLimit: number;
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
    // Any value may be a `cause`, not only an `Error` - and a hook is allowed to
    // `throw 'Unauthorized'`, which used to arrive with `cause` unset. Still omitted entirely
    // when there is no underlying error, rather than set to `undefined` as an own property.
    super(message, error === undefined ? undefined : {cause: error});

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
  timeout?: Timeout;

  /** The HTTP method used to make the request. */
  method?: Dispatcher.HttpMethod;

  /**
   * JSON body. If the `Content-Type` header is not set, it will be set to `application/json`.
   *
   * __Note__: read from the per-call options only. A body belongs to one request, so a `json`
   * set on a client is dropped rather than inherited - got behaves the same way.
   */
  json?: unknown;

  /**
   * Raw request body. Overridden by `json` and `form`.
   *
   * A `FormData` is encoded as `multipart/form-data` with its boundary, which is got 15's
   * documented way to send multipart. undici's `request()` cannot take one directly.
   *
   * __Note__: per-call only, like `json`.
   */
  body?: string | Buffer | Uint8Array | FormData | Readable | null;

  /** The parsing method. `buffer` resolves to a Node `Buffer`. */
  responseType?: 'text' | 'json' | 'buffer';

  /**
   * Query string to add to the request URL. Overrides any query already present on `url`.
   *
   * Object values are stringified; a `null` entry is sent with an empty value (`?a=`) and an
   * `undefined` one is dropped, both as got does. An array value repeats the key
   * (`{a: [1, 2]}` becomes `?a=1&a=2`), which got rejects outright - see the README's
   * divergence table.
   */
  searchParams?: string | URLSearchParams | Record<string, QueryValue | readonly QueryValue[]>;

  /**
   * `application/x-www-form-urlencoded` body. Sets the `Content-Type` header unless one is
   * already set. Takes precedence over `body`, and is itself overridden by `json`.
   *
   * Serialised like `searchParams`, so an array value repeats the key - got stringifies it into
   * the single value `a=1%2C2` instead, which is a recorded divergence (see the README).
   *
   * __Note__: read from the per-call options only. Like `json` and `body`, a form set on a
   * client is not inherited by the requests it makes.
   */
  form?: Record<string, QueryValue | readonly QueryValue[]> | URLSearchParams;

  /**
   * Validate options. Client options are always validated on create/extend - it happens
   * once and costs nothing. This flag controls the *per-request* check, which catches
   * things like a misspelled `responseType` on a single call.
   *
   * @default true
   */
  validate?: boolean;

  /**
   * Parse `user:pass@host` out of the url into a `Basic` `authorization` header - see
   * "Credentials in the url become Basic auth" for why this exists at all. On by default;
   * turn it off if no url passed to this client ever carries credentials, which is the
   * common case for calling a fixed set of internal APIs, to skip the bounded scan of the
   * url's authority on every request (~300-400ns, measured).
   *
   * Client-only, like `validate`: read from the instance, so a per-request value would do
   * nothing.
   *
   * @default true
   */
  parseUserinfo?: boolean;

  /**
   * Allow `client.defaults.options.merge(...)` to change this client's defaults after it has
   * been built - got's option, for the token-refresh pattern of merging a new `authorization`
   * into the client from a hook.
   *
   * Client-only, and **not inherited by `extend()`**, as in got: a child is only mutable when
   * its own options say so.
   *
   * @default false
   */
  mutableDefaults?: boolean;

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

/** Methods that can carry a request body, and so get a writable stream half. */
export type BodyMethod = (typeof bodyMethods)[number];

/** The outgoing request for a redirect hop. `headers` is mutable. */
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
   *
   * __Note__: not run for `stream()`, since there is no parsed body to hand over and no way
   * to replay a streamed request. got scopes these to its promise API for the same reason.
   * `beforeRequest`, `beforeError`, `beforeRetry` and `beforeRedirect` all do fire for streams.
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
  url: string;
  /** How many times the request was retried. Always 0 unless `retry` is configured. */
  retryCount: number;
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

/**
 * `client.stream` - callable as got's is, with got's verb helpers hanging off it.
 *
 * The bodyless verbs resolve to a `Readable`; the ones that can carry a body resolve to the
 * `Duplex` whose writable half *is* the request body, which is the same split `stream()`
 * itself makes on `method`.
 */
export type StreamClient = {
  (options: RequestOptions & {method: BodyMethod}): Promise<GotlikeUploadStream>;
  (options: RequestOptions): Promise<GotlikeStream>;
  (url: string | URL, options: RequestOptions & {method: BodyMethod}): Promise<GotlikeUploadStream>;
  (url: string | URL, options?: RequestOptions): Promise<GotlikeStream>;
  /** Each verb also takes an options object in place of the url, as got's do. */
  get(url: RequestInput, options?: RequestOptions): Promise<GotlikeStream>;
  head(url: RequestInput, options?: RequestOptions): Promise<GotlikeStream>;
  options(url: RequestInput, options?: RequestOptions): Promise<GotlikeStream>;
  post(url: RequestInput, options?: RequestOptions): Promise<GotlikeUploadStream>;
  put(url: RequestInput, options?: RequestOptions): Promise<GotlikeUploadStream>;
  patch(url: RequestInput, options?: RequestOptions): Promise<GotlikeUploadStream>;
  delete(url: RequestInput, options?: RequestOptions): Promise<GotlikeUploadStream>;
  query(url: RequestInput, options?: RequestOptions): Promise<GotlikeUploadStream>;
};

/** A verb's first argument, as got takes it: a url, or an options object standing in for one. */
type RequestInput = string | URL | RequestOptions;

/**
 * Route a verb call to `handle()`, with the first argument read the way got reads it.
 *
 * got's `got.post(options)` is ordinary - `igd-aggregator-api` fetches its GamesGlobal token that
 * way - and every verb here took its first argument as the url. The object went into
 * `options.url`, `String()` made it `[object Object]`, and the request went out as `POST
 * <prefixUrl>/[object Object]` with its `json`, headers and query dropped: no error, and a 4xx
 * from the upstream that looked like its fault. Without a `prefixUrl` it did at least fail, as
 * `Invalid URL`. got 12 and 16 both send `POST <prefixUrl>/` with the body (measured); the callable
 * form already had this rule, and now shares it.
 *
 * A second options object merges over the first, as got 12's `Options` constructor does - headers
 * (case-insensitively), `context` and `searchParams` one level deep, like every other merge here.
 * The url comes from the first object only; naming one in the second as well is the "url given
 * twice" mistake `formOptions` already rejects. got 12 kept the first and got 16 refuses a `url`
 * key in an options object at all.
 */
function handleInput(
  instance: Gotlike<any>,
  input: RequestInput | undefined,
  options: RequestOptions | undefined,
  method?: Dispatcher.HttpMethod,
  isStream?: true,
): Promise<any> {
  if (input === null || typeof input !== 'object' || input instanceof URL) {
    return instance.handle(isStream ? {...options, isStream} : (options ?? {}), input, method);
  }

  let merged = input;

  if (options !== undefined) {
    if (instance.validate && options.url !== undefined) {
      return Promise.reject(new ValidationError('`url` cannot be given both as an argument and as an option'));
    }

    merged = mergeOptions(input, options);

    if (input.headers !== undefined && options.headers !== undefined) {
      merged.headers = mergeHeaders(lowercaseHeaders(input.headers), options.headers);
    }

    if (input.context !== undefined && options.context !== undefined) {
      merged.context = {...input.context, ...options.context};
    }

    if (input.searchParams !== undefined && options.searchParams !== undefined) {
      try {
        merged.searchParams = mergeSearchParams(input.searchParams, options.searchParams);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }

  return instance.handle(isStream ? {...merged, isStream} : merged, undefined, method);
}

/** The verbs `stream` carries, each dispatching through `handle()` like the client's own. */
const streamVerbs = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete', 'query'] as const;

/**
 * Build one client's `stream` façade.
 *
 * A function rather than a method so the verb helpers can live on it, bound to the instance -
 * a prototype method is shared by every client and has nowhere to put them.
 */
function makeStreamClient(instance: Gotlike<any>): StreamClient {
  const stream = ((input?: RequestInput, options?: RequestOptions) =>
    handleInput(instance, input, options, undefined, true)) as unknown as StreamClient;

  for (const verb of streamVerbs) {
    const method = verb.toUpperCase();

    // Through an index signature: `stream[verb]` with `verb` a union of the eight names asks
    // TypeScript to satisfy all eight return types with one function. The declared
    // `StreamClient` above is what keeps the call sites honest.
    (stream as unknown as Record<string, unknown>)[verb] = (input?: RequestInput, options?: RequestOptions) =>
      handleInput(instance, input, options, method, true);
  }

  return stream;
}

/**
 * The response head both stream paths hand back, built once rather than twice.
 *
 * `callBodylessStream` and `callStream` each spelled this literal out, and each had to
 * remember that `url` is the url that *answered* (not `options.url`, which is the one that was
 * requested and is not where a redirect chain ended), that `retryCount` comes off the shared
 * attempt holder rather than from nowhere, and that `total` is measured from the request's own
 * start. Three fields, two copies, and every one of them a place to forget one.
 */
function makeStreamHead(
  statusCode: number,
  headers: IncomingHttpHeaders,
  options: FormedOptions,
  dispatch: SharedDispatchOptions,
  startTime?: [number, number],
): StreamHead {
  return {
    statusCode,
    ok: isOk(statusCode),
    headers,
    // Where the response came from, which is not `options.url` once redirects moved it.
    url: dispatch.redirects?.lastUrl ?? String(options.url),
    retryCount: retriesFrom(dispatch.attempts),
    timings: {
      phases: {
        total: elapsedMs(startTime),
      },
    },
  };
}

/*
 * The option shapes the request overloads discriminate on. Together they let a call site say
 * what it gets back without a cast: `responseType` pins the body type for `text` and
 * `buffer`, `resolveBodyOnly` decides between a `Response<T>` and a bare `T`, and everything
 * else falls through to the caller's `T` - so `get<Thing>(url)` still reads as it does in got.
 */

/** An explicit `responseType: 'text'`: the body is a string. */
export type TextCall = RequestOptions & {responseType: 'text'};

/** `responseType: 'buffer'`: the body is a Node `Buffer`. */
export type BufferCall = RequestOptions & {responseType: 'buffer'};

/** A call that names no `responseType`, so the client's own setting decides the body type. */
export type InheritCall = RequestOptions & {responseType?: undefined};

/** Resolves with the whole `Response`. */
export type WholeResponse = {resolveBodyOnly?: false};

/** Resolves with the body alone. */
export type BodyOnly = {resolveBodyOnly: true};

/**
 * `{isStream: true}` - the runtime equivalent of calling `.stream(...)` instead of a verb
 * method. Nothing about `handle()`, the verb methods or the callable form's overloads used to
 * key on it, so `client.get(url, {isStream: true})` type-checked as `Promise<Response<T>>`
 * while resolving to a `GotlikeStream` at runtime - correctly typed caller code compiled and
 * then read `undefined` off every field a `Response` declares. Kept as its own type, first in
 * each overload list, so it wins regardless of what `responseType`/`resolveBodyOnly` a call
 * also names - both are ignored once `isStream` is set (see `handle()` and `formOptions()`).
 */
export type IsStream = {isStream: true};

/**
 * The body type a client's own `responseType` implies, for a call that doesn't name one.
 * `json` lands on `unknown` rather than `any`, so it still has to be narrowed somewhere.
 */
export type ClientBody<O> = O extends {responseType: 'json'}
  ? unknown
  : O extends {responseType: 'buffer'}
    ? Buffer
    : string;

/** A whole `Response`, or the bare body when the *client* was built with `resolveBodyOnly`. */
export type ClientResult<O, Body> = O extends {resolveBodyOnly: true} ? Body : Response<Body>;

/**
 * The client options that change what a call resolves to when the call itself stays quiet.
 * Threaded through `extend()` so an extended client keeps reporting the right body type -
 * without it, `extend({responseType: 'json'}).get(url)` claimed `Response<string>` while
 * handing back a parsed object.
 */
export type ClientOptions = RequestOptions;

/** `extend()`'s merge, at the type level: the extension wins, key by key. */
export type MergeClientOptions<Base, Extension> = Omit<Base, keyof Extension> & Extension;

export type Response<T = any> = {
  /**
   * The parsed body.
   *
   * `Response` can't be a tagged union over `responseType`, because the type that settles it
   * may come from the client rather than the call - so the *call site* pins it instead: the
   * verb overloads resolve `text` to `string` and `buffer` to `Buffer`, and leave `json` (and
   * an unspecified type) to the caller's `T`, the way got does.
   */
  body: T;
  headers: IncomingHttpHeaders;
  readonly url: string;
  statusCode: number;
  /** Whether `statusCode` is in the 2xx range. */
  ok: boolean;
  /**
   * The response body as a `Buffer`.
   *
   * Computed on first access rather than eagerly: text and JSON responses are read with
   * undici's optimised `body.text()`, and materialising a Buffer for every request just in
   * case would cost more than it's worth. For a `buffer` responseType this is the body
   * itself; otherwise it's the body as received, re-encoded as UTF-8 - for `json` that is
   * the original text, not a re-serialisation of the parsed value.
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
  #rawText?: string;
  #url?: string;

  constructor(
    body: T,
    headers: IncomingHttpHeaders,
    statusCode: number,
    retryCount: number,
    total: number,
    options: FormedOptions,
    /**
     * The body exactly as it was received, when `body` is no longer it. Only the `json`
     * path needs this: re-serialising the parsed object gave back `{"a":1}` for a response
     * that was on the wire as `{\n  "a"  :  1\n}`, which quietly broke any signature
     * checked over `rawBody`.
     */
    rawText?: string,
    /**
     * Where the response actually came from, when redirects moved it. Only the redirect
     * tracker supplies this; without one `options.url` is already the right answer.
     */
    finalUrl?: string,
  ) {
    this.body = body;
    this.headers = headers;
    this.statusCode = statusCode;
    this.ok = isOk(statusCode);
    this.retryCount = retryCount;
    this.timings = {phases: {total}};
    this.request = {options};
    this.#rawText = rawText;
    this.#url = finalUrl;
  }

  /** The url the response came from - the last hop's, when redirects were followed. */
  get url(): string {
    return this.#url ?? String(this.request.options.url);
  }

  get rawBody(): Buffer {
    if (this.#rawBody === undefined) {
      this.#rawBody =
        this.#rawText === undefined
          ? Buffer.isBuffer(this.body)
            ? this.body
            : Buffer.from(typeof this.body === 'string' ? this.body : (JSON.stringify(this.body) ?? ''))
          : Buffer.from(this.#rawText);
    }

    return this.#rawBody;
  }
}

/**
 * The response a stream failure carries: the head that arrived, with no body.
 *
 * The body has been dumped, resumed, or cut off mid-flight by the time any of this runs, so there
 * is none to attach - but the head is real, and `RequestError.response` is documented as
 * `undefined` *only* when the failure happened before a response arrived. `call()` has always
 * honoured that (its catch builds a response whenever one exists); the stream paths did not, so a
 * truncated download reported `error.response` as undefined where the identical failure on the
 * promise API reported status, headers and `request.options`.
 *
 * Not the `formResponse()` wrapper this file warns against: that one took `(body, statusCode,
 * headers, ...)` and called the constructor as `(body, headers, statusCode, ...)`. This reads every
 * field off `head` by name, and its three parameters have three unrelated types, so there is no
 * positional list left to transpose.
 */
function streamResponse(
  head: StreamHead,
  options: FormedOptions,
  dispatch: SharedDispatchOptions,
): Response<undefined> {
  return new GotlikeResponse<undefined>(
    undefined,
    head.headers,
    head.statusCode,
    head.retryCount,
    head.timings.phases.total,
    options,
    undefined,
    // Read here rather than at each call site: three copies of `dispatch.redirects?.lastUrl` is
    // three places to forget that a stream's error, like its head, has to name the url that
    // actually answered rather than the one that was requested.
    dispatch.redirects?.lastUrl,
  );
}

const defaultOptions = {
  throwHttpErrors: true,
  followRedirect: false,
  headers: {},
  responseType: 'text',
  method: 'GET',
} satisfies RequestOptions;

const responseTypes = ['text', 'json', 'buffer'];
const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'QUERY'];

/**
 * The methods `stream()` hands a writable half to. `BodyMethod` is derived from this list, so
 * the two can't drift.
 *
 * Everything else is streamed through `undici.request` instead: `undici.pipeline` doesn't send
 * the request until the writable side ends, and for a method the caller can't write to there
 * would be nothing to end it.
 */
const bodyMethods = ['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'] as const;

function isBodyMethod(method?: string): boolean {
  return bodyMethods.includes(method as BodyMethod);
}

/**
 * Options that only mean anything when a client is built. Passing one per request is
 * rejected rather than ignored - a silently dropped `hooks` is very hard to notice.
 *
 * A Set, not an array: this is consulted once per option on every validated request.
 */
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
 * Marks the options object `extend()` synthesises, so `validateOptions` can tell one call
 * naming both `agent` and `connections` from an *inherited* dispatcher travelling alongside the
 * inherited agent options it was built from - which is legitimate, and which the constructor
 * has no other way to recognise, since `extend()` passes the parent's dispatcher back in as
 * `agent` whether the parent built it or was given it.
 *
 * A symbol, like `retryDepth`: option spreads carry it while `for...in` validation and
 * `Object.keys` never see it.
 */
const inheritedAgent = Symbol('gotlike.inheritedAgent');

/** Set on the nock shim's MockAgent; a registry symbol, so this module never imports the shim. */
const routeOwnAgent = Symbol.for('gotlike.nock.routeOwnAgent');

/**
 * Refuse an agent-level option that an explicit `agent` would silently swallow.
 *
 * The dispatcher is used exactly as it stands - there is no way to ask a `ProxyAgent` or an
 * `H2CClient` for a copy of itself with one option changed - so `{agent: new ProxyAgent(...),
 * connections: 128}` accepted the option and did nothing with it, with no error and nothing on
 * the wire to say so. That is the same quiet drop `extend()` already refuses from the other
 * direction (an agent option on a client that was handed a dispatcher), and the two disagreed.
 */
function validateAgentChoice(options: RequestOptions): void {
  if (options.agent === undefined || inheritedAgent in options) {
    return;
  }

  const ignored = agentOptions.find((key) => options[key] !== undefined);

  if (ignored !== undefined) {
    invalid(
      `\`${ignored}\` cannot be combined with an explicit \`agent\` - the dispatcher is used as it ` +
        'stands, so the option would be silently ignored. Configure it on the agent you pass instead.',
    );
  }
}

const clientOnlyOptions = new Set<keyof RequestOptions>([
  // Every agent-level option is client-only by definition - it decides which dispatcher gets
  // built, and that happens once per client. Spread rather than listed again so the two cannot
  // drift: an agent option missing from here would be accepted per request and then ignored,
  // which is the exact failure this set exists to prevent.
  ...agentOptions,
  'agent',
  'retry',
  'dnsCache',
  'cache',
  'dedupe',
  'decompress',
  'handlers',
  'hooks',
  // `validate` and `parseUserinfo` are read from the instance, so a per-request value would
  // do nothing.
  'validate',
  'parseUserinfo',
  // Decides what `client.defaults` allows, which is fixed when the client is built.
  'mutableDefaults',
]);

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
  parseUserinfo: true,
  mutableDefaults: true,
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
  /**
   * Every other error this package raises carries a `code`, and this one carried none - so
   * `err.code` was `undefined` for exactly the failures a caller is most likely to be
   * matching on while wiring a client up.
   */
  code = 'ERR_INVALID_OPTION';
}

function invalid(message: string): never {
  throw new ValidationError(message);
}

/**
 * The options `client.defaults.options.merge()` refuses, with why. Only what a *request* merges
 * can be merged into a built client. The rest was consumed when the client was built - the
 * dispatcher, the hook arrays, the retry handler, the interceptor chain - so merging it would
 * change `baseOptions` and nothing else, which is a silent no-op; or it belongs to one request;
 * or it decides the client's response type, which a merge cannot change the way `extend()` does.
 */
const unmergeableDefaults = new Map<string, string>([
  ...[...clientOnlyOptions, 'followRedirect'].map((key): [string, string] => [
    key,
    'is built into the client when it is created - use `extend()` instead',
  ]),
  ...['json', 'body', 'form', 'url', 'isStream'].map((key): [string, string] => [
    key,
    'belongs to a single request, not to the client',
  ]),
  ...['responseType', 'resolveBodyOnly'].map((key): [string, string] => [
    key,
    'decides the type of every response the client returns - use `extend()` instead',
  ]),
]);

/** The options `client.defaults.options.merge()` takes - see `unmergeableDefaults`. */
export type DefaultsMergeOptions = Omit<
  RequestOptions,
  | (typeof agentOptions)[number]
  | 'agent'
  | 'retry'
  | 'dnsCache'
  | 'cache'
  | 'dedupe'
  | 'decompress'
  | 'handlers'
  | 'hooks'
  | 'validate'
  | 'parseUserinfo'
  | 'mutableDefaults'
  | 'followRedirect'
  | 'json'
  | 'body'
  | 'form'
  | 'url'
  | 'isStream'
  | 'responseType'
  | 'resolveBodyOnly'
>;

/** `client.defaults`, the part of got's that the token-refresh pattern uses. */
export type ClientDefaults = {
  /** Whether `options.merge()` may change the client. Fixed when the client is built. */
  readonly mutableDefaults: boolean;
  readonly options: {
    /**
     * Merge options into the client's defaults, by the rules `extend()` merges by - headers
     * case-insensitively, `context`/`timeout`/`searchParams` one level deep, everything else
     * replaced. Every request made afterwards sees them; one already in flight does not, and
     * neither does a client extended from this one earlier.
     *
     * A `ValidationError` on a client built without `mutableDefaults: true` - got ignores the
     * merge silently there - and for an option only `extend()` can apply.
     */
    merge(options: DefaultsMergeOptions): void;
  };
};

/**
 * Catches the option mistakes that otherwise fail confusingly much later - a misspelled
 * `responseType`, `timeout: 5000` instead of `timeout: {request: 5000}`, a client-only
 * option passed per request and silently ignored.
 *
 * `atCreation` distinguishes the two call sites: `hooks` and `retry` are meaningful on a
 * client but inert on a single call, and saying so beats being quietly ignored.
 */
function validateOptions(options: RequestOptions, atCreation: boolean): void {
  for (const key in options) {
    // Own properties only. `for...in` walks the prototype chain, so anything that had added an
    // enumerable property to `Object.prototype` failed every request with `Unknown option`.
    if (!Object.hasOwn(options, key)) {
      continue;
    }

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

  // Case-insensitively: got uppercases a method rather than refusing it, and so does
  // `normaliseMethod` - validating against the raw value would reject what is about to be
  // folded into something valid.
  if (method !== undefined && !(typeof method === 'string' && httpMethods.includes(normaliseMethod(method)))) {
    invalid(`\`method\` must be a valid HTTP method, got \`${String(method)}\``);
  }

  if (timeout !== undefined) {
    if (typeof timeout !== 'object' || timeout === null) {
      invalid('`timeout` must be an object like `{request: 5000}`');
    }

    // The same unknown-key check as `retry` and `hooks`: `request` is the only key read, so any
    // other one is a bound that silently never applies.
    for (const key in timeout) {
      if (Object.hasOwn(timeout, key) && key !== 'request') {
        rejectUnimplemented(`timeout.${key}`);

        invalid(`Unknown option \`timeout.${key}\``);
      }
    }

    /*
     * Finite and above zero, not merely non-negative. Both excluded values were accepted and
     * then behaved badly: `0` made `AbortSignal.timeout(0)` fire immediately and fail every
     * request, while undici reads `bodyTimeout: 0` as *disabled* - the two halves of one
     * option meaning opposite things. `Infinity` made `AbortSignal.timeout` throw a
     * `RangeError` that surfaced as an opaque `ERR_REQUEST_ERROR`. Leave the option off to
     * have no timeout.
     */
    if (
      timeout.request !== undefined &&
      (typeof timeout.request !== 'number' || !Number.isFinite(timeout.request) || timeout.request <= 0)
    ) {
      invalid('`timeout.request` must be a finite number of milliseconds greater than 0, or left unset for none');
    }
  }

  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
    invalid('`headers` must be an object');
  }

  if (prefixUrl !== undefined) {
    if (typeof prefixUrl !== 'string') {
      invalid('`prefixUrl` must be a string');
    }

    /*
     * A prefix is joined to `url` by string concatenation, so a query or fragment on it lands
     * in the middle of the result: `http://h/base?x=1` + `p` became `http://h/base?x=1/p`,
     * and adding `searchParams` then cut everything from the `?` onwards and dropped the path
     * segment entirely. Rejected rather than silently mangled - put the query in
     * `searchParams`, which is what it is for.
     */
    if (prefixUrl.includes('?') || prefixUrl.includes('#')) {
      invalid('`prefixUrl` must not contain a query string or a fragment - use `searchParams` instead');
    }
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

  // The values too, but only here - see `validateQueryValues` for why this is create/extend only.
  if (atCreation) {
    if (searchParams !== undefined) {
      validateQueryValues(searchParams);
    }

    if (form !== undefined) {
      validateQueryValues(form);
    }

    // `agent` and the agent-level options are create/extend-only too, so this is the one place
    // that ever sees both at once.
    validateAgentChoice(options);
  }

  if (retry !== undefined) {
    if (typeof retry !== 'object' || retry === null) {
      invalid('`retry` must be an object like `{limit: 2}`');
    }

    for (const key in retry) {
      if (Object.hasOwn(retry, key) && !knownRetryKeys.has(key as keyof RetryOptions)) {
        // A got option we don't implement names itself; anything else is a typo.
        rejectUnimplemented(`retry.${key}`);

        invalid(`Unknown option \`retry.${key}\``);
      }
    }

    if (
      retry.limit !== undefined &&
      (typeof retry.limit !== 'number' ||
        !Number.isFinite(retry.limit) ||
        !Number.isInteger(retry.limit) ||
        retry.limit < 0)
    ) {
      invalid('`retry.limit` must be a finite non-negative integer');
    }
  }

  if (hooks !== undefined) {
    if (typeof hooks !== 'object' || hooks === null) {
      invalid('`hooks` must be an object');
    }

    // A misspelled hook name (`beforeReqest`) used to be accepted silently and simply never
    // called - dropping whatever signing, auth or logging it was meant to add, with nothing
    // to say why. `hookNames` is the exhaustive list, so anything else is a typo.
    for (const key in hooks) {
      if (Object.hasOwn(hooks, key) && !(hookNames as readonly string[]).includes(key)) {
        // As above: got's own `init` says so rather than reading as a misspelling.
        rejectUnimplemented(`hooks.${key}`);

        invalid(`Unknown option \`hooks.${key}\``);
      }
    }

    for (const name of hookNames) {
      const hook = hooks[name];

      if (hook !== undefined && !Array.isArray(hook)) {
        invalid(`\`hooks.${name}\` must be an array of functions`);
      }
    }
  }
}

/**
 * The per-request check, shared by the two routes into `call()`: `formOptions` and an
 * `afterResponse` retry.
 *
 * Both used to spell it out, and the retry's copy was missing the `followRedirect` half - so
 * `retry({followRedirect: true})` was silently ignored where the identical option on the call
 * that triggered the retry is a `ValidationError`. One function, so a rule added to one route
 * cannot go missing from the other.
 */
function validateRequest(options: RequestOptions, followsRedirects: boolean): void {
  validateOptions(options, false);

  // Turning redirects *on* means composing an interceptor, which is a create/extend-time
  // decision - a per-request `true` would otherwise be silently ignored. Turning them off per
  // request is fine, and just sets `maxRedirections: 0`.
  if (options.followRedirect && !followsRedirects) {
    invalid('`followRedirect: true` can only be set when creating or extending a client');
  }
}

export class Gotlike<O extends ClientOptions = ClientOptions> {
  /** The client defaults, with `defaultOptions` already folded in - never undefined. */
  baseOptions: RequestOptions;

  /** Explicit dispatcher for this client, if one was built or passed in. */
  ownAgent?: Dispatcher;

  /**
   * Whether `ownAgent` is a dispatcher the *caller* handed over, rather than one this class
   * built from the agent-level options.
   *
   * The two cannot be told apart from `ownAgent` alone - `extend()` passes the inherited one
   * back in as `agent` either way - and they have to be, because only the second is ours to
   * replace. See `extend()`.
   */
  explicitAgent = false;

  /** Per-request retry defaults, applied through the composed `retry` interceptor. */
  retryOptions?: RetryHandlerOptions;

  /**
   * Whether this client's `retry.errorCodes` cover a timeout, and so whether the request
   * deadline has anything to gain by waiting for undici's own one. See `requestSignal`.
   */
  retriesTimeouts = false;

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

  /** Whether `call()` parses `user:pass@host` credentials out of the url. */
  parseUserinfo: boolean;

  /** Whether the composed chain decompresses. Instance-level, so `call()` can't disagree. */
  decompress: boolean;

  /** Whether the client defaults carry a `json`/`body`/`form`, which must not be inherited. */
  baseHasBody: boolean;

  /** Whether anything runs between `formOptions` and the dispatch that could write a header. */
  mayRewriteHeaders: boolean;

  /** got's `client.defaults` - see `mutableDefaults`. */
  readonly defaults: ClientDefaults;

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

  /** Memoised `stream` façade; built on first use, so a client that never streams pays nothing. */
  #stream?: StreamClient;

  constructor(options?: O) {
    if (options) {
      validateOptions(options, true);
    }

    /*
     * The defaults are folded in *here*, not onto the exported singleton, so that every way of
     * building a client shares them. They used to be `createClient(defaultOptions)`'s alone,
     * which left `new Gotlike(...)` and `createClient(...)` with `throwHttpErrors` undefined -
     * silently resolving 4xx/5xx as successes - and no `responseType`, falling through to
     * `buffer` instead of `text`. `FormedOptions` declares both as required, so the rest of the
     * code was right to trust them; this is what makes that true.
     */
    const merged: RequestOptions = options ? mergeOptions(defaultOptions, options) : {...defaultOptions};

    /*
     * The same copies `extend()` makes, because a directly built client reached them by a
     * shallow spread and so kept the caller's own `hooks` object and arrays live inside it -
     * `usedHooks` doesn't copy either. Pushing to the array that was handed to
     * `createClient({hooks})` afterwards added a hook to a client that was already built.
     * Create-time only, and both helpers hand back `undefined` for an absent side.
     */
    merged.hooks = mergeHooks(undefined, merged.hooks);
    merged.handlers = concatHooks(undefined, merged.handlers);
    // Same reasoning, same one-sided gap: the spread above handed back the caller's own
    // `URLSearchParams`/object by reference, so mutating it after `createClient(...)` returned
    // silently changed every request the client made from then on. See `cloneSearchParams`.
    merged.searchParams = cloneSearchParams(merged.searchParams);
    /*
     * And the last three the spread still aliased. `formOptions` copies `context` per request -
     * but it copies it *from* this object, so a caller mutating what they passed to
     * `createClient({context})` afterwards reached every later request anyway; `timeout` is
     * handed over by reference outright, so a deadline could be moved out from under a built
     * client (measured: a `{request: 5000}` changed to `{request: 1}` afterwards started timing
     * requests out); and `retry` is snapshotted into `retryOptions` here but still travels into
     * `extend()`. Shallow, like `mergeRecords` everywhere else - it is the key-level writes that
     * were reaching through.
     */
    merged.context = mergeRecords(undefined, merged.context);
    merged.timeout = mergeRecords(undefined, merged.timeout);
    merged.retry = mergeRecords(undefined, merged.retry);
    /*
     * And `headers`, which was the worst of them because the object it aliased is not the
     * caller's - it is **`defaultOptions.headers`**, one module-level `{}` shared by every
     * client built without headers of its own. `createClient().baseOptions.headers` was the
     * same object for every client in the process, so a single write through that public field
     * would have shown up on every client created afterwards. A caller's own object is copied
     * here for the reason the four above are: `extend()` reads `base.headers`, so mutating what
     * was passed to `createClient({headers})` reached clients derived from it later.
     * `defaultHeaders` is built from this and is already its own object.
     */
    merged.headers = mergeRecords(undefined, merged.headers);
    // Describes the call that built this client, not the client - and the spread above copies
    // symbol keys, so left in place it would travel into `baseOptions`, into every formed
    // options object, and into whatever `extend()` is handed next.
    delete (merged as Record<symbol, unknown>)[inheritedAgent];

    /*
     * Read and then cleared rather than deleted, so it is not inherited: `extend()` spreads
     * `baseOptions`, and got builds every child immutable unless the child's own options say
     * otherwise. Not `delete`, which can drop an object V8 would otherwise keep in fast mode -
     * and `baseOptions` is spread on every request.
     */
    const mutableDefaults = merged.mutableDefaults === true;

    if (merged.mutableDefaults !== undefined) {
      merged.mutableDefaults = undefined;
    }

    this.defaults = Object.freeze({
      mutableDefaults,
      options: Object.freeze({merge: (extension: DefaultsMergeOptions) => this.#mergeDefaults(extension)}),
    });

    // Folded once here so `formOptions` only has to look at a per-call method.
    if (merged.method !== undefined) {
      merged.method = normaliseMethod(merged.method);
    }

    this.baseOptions = merged;
    this.followsRedirects = merged.followRedirect === true;
    this.validate = merged.validate !== false;
    this.parseUserinfo = merged.parseUserinfo !== false;
    this.decompress = merged.decompress !== false;

    // got never takes a body from the client defaults, and `json`'s own docs here say the same.
    // Checked once, so `formOptions` can skip three property reads per request in the usual
    // case where no client carries one.
    this.baseHasBody = merged.json !== undefined || merged.body !== undefined || merged.form !== undefined;

    // Handlers and `beforeRequest` hooks are the only things that write to `options.headers`
    // after it has been folded, so they are the only reason to check it again per request.
    this.mayRewriteHeaders = Boolean(merged.handlers?.length || merged.hooks?.beforeRequest?.length);

    // Lower-cased once here so the per-request merge can fold a per-call name in with a single
    // `toLowerCase()` and be sure nothing collides with a differently-cased default.
    this.defaultHeaders = lowercaseHeaders(merged.headers);

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
        ...(typeof merged.decompress === 'object' ? merged.decompress : undefined),
      };
    }

    // Left undefined when empty, so `call()` only has to check for a truthy field.
    this.beforeRequestHooks = usedHooks(merged.hooks?.beforeRequest);
    this.afterResponseHooks = usedHooks(merged.hooks?.afterResponse);
    this.beforeErrorHooks = usedHooks(merged.hooks?.beforeError);
    this.beforeRetryHooks = usedHooks(merged.hooks?.beforeRetry);
    this.beforeRedirectHooks = usedHooks(merged.hooks?.beforeRedirect);

    if (merged.agent) {
      this.ownAgent = merged.agent;
      // Corrected by `extend()` for the case it cannot see from here: a child that merely
      // *inherited* its parent's auto-built Agent is passed it as `agent` too.
      this.explicitAgent = true;
    } else if (agentOptions.some((key) => merged[key] !== undefined)) {
      this.ownAgent = new undici.Agent({
        allowH2: merged.http2,
        pipelining: merged.pipelining,
        connections: merged.connections,
        keepAliveTimeout: merged.keepAliveTimeout,
        keepAliveMaxTimeout: merged.keepAliveMaxTimeout,
        connectTimeout: merged.connectTimeout,
        connect: merged.dnsLookup
          ? {
              lookup: merged.dnsLookup,
            }
          : undefined,
      });
    }

    // `retry: {limit: 0}` is how callers disable retries; composing a RetryHandler that
    // will never retry just costs a handler allocation per request, so skip it entirely.
    if (merged.retry && merged.retry.limit !== 0) {
      // undici's own list plus the two timeout codes, or the caller's with got's `ETIMEDOUT`
      // translated into them. See `resolveErrorCodes`.
      const errorCodes = resolveErrorCodes(merged.retry.errorCodes);

      // Whether waiting for undici's own timeout can buy a retry at all - see `requestSignal`.
      // A caller who narrowed `errorCodes` to exclude timeouts gets the exact deadline back.
      this.retriesTimeouts = errorCodes.includes(timeoutErrorCodes[0]);

      this.retryOptions = {
        // Copied for the reason `errorCodes` is copied inside `resolveErrorCodes`, and it was the
        // same hole: `mergeRecords` copies the `retry` object but not the arrays inside it, so
        // `client.retryOptions.statusCodes` *was* `client.baseOptions.retry.statusCodes` - and,
        // through `extend()`'s shallow merge, the parent's too. `formOptions` aliases `retry` onto
        // the formed options, so a `push` through `response.request.options.retry.statusCodes`
        // silently widened what an already-built client (and every client derived from it)
        // retried. Once per client.
        methods: merged.retry.methods && [...merged.retry.methods],
        statusCodes: merged.retry.statusCodes && [...merged.retry.statusCodes],
        errorCodes,
        // undici would default this to 5. got's default is 2, and silently tripling the
        // load a failing upstream sees is not a difference anyone would go looking for.
        maxRetries: merged.retry.limit ?? defaultRetryLimit,
        maxTimeout: merged.retry.backoffLimit,
        // undici defaults this to `true`, and got honours `Retry-After` by default too.
        // Deriving it from `maxRetryAfter` alone turned it *off* for every caller who
        // didn't set that option, which is almost all of them - so the client ignored an
        // upstream's explicit backoff and hammered it on undici's own schedule instead.
        retryAfter: merged.retry.maxRetryAfter === undefined ? true : !!merged.retry.maxRetryAfter,
        // got resolves an exhausted retry to the last response; undici's handler
        // throws a RequestRetryError instead unless we opt out.
        throwOnError: false,
      };
    }
  }

  /**
   * Retry bookkeeping for a single dispatch, or `undefined` on a client that never retries.
   *
   * Built here rather than inline in `call()` because `dispatchOptions()` hands it to every
   * dispatch - the stream paths used to get none, which left `beforeRetry` silently unfired
   * and `retryCount` pinned at 0 on a stream that undici had in fact retried.
   */
  attemptState(options: FormedOptions): AttemptState | undefined {
    if (!this.retryOptions) {
      return undefined;
    }

    const hooks = this.beforeRetryHooks;
    const methods = this.retryOptions.methods ?? defaultRetryMethods;
    const statusCodes = this.retryOptions.statusCodes ?? defaultRetryStatusCodes;
    const maxRetries = this.retryOptions.maxRetries ?? defaultRetryLimit;
    // A Node stream is consumed while it is sent and cannot normally be replayed. The upload
    // duplex path has the same property even when no body was supplied in the options: its
    // writable side belongs to the caller, not to undici's retry handler.
    const replayableBody = !(options.body instanceof Readable) && !(options.isStream && isBodyMethod(options.method));
    const state: AttemptState = {
      count: 0,
      onRetry:
        hooks &&
        ((error, statusCode, retryCount) => {
          for (const hook of hooks) {
            hook(error, statusCode, retryCount);
          }
        }),
    };

    /*
     * Whether undici is about to retry this response rather than hand it over, which is the
     * only reason to stop the attempt's deadline (see `requestSignal`).
     *
     * It is a prediction of a decision undici makes privately, so it is wrong the moment
     * `retry-handler.js` changes - and a false positive used to mean a request with *no*
     * deadline at all, silently, for as long as the body took to arrive. `resumeDeadline` in
     * `call()` and on both stream paths is what bounds that now; this only has to be right
     * often enough to keep a real retry's backoff off the caller's clock.
     *
     * `>= 300` mirrors undici's own gate: `RetryHandler.onResponseStart` only consults the
     * retry policy for a 3xx and up, so a `retry.statusCodes` naming a 2xx - a polling client
     * listing `202`, say - is never retried there however this answers.
     */
    state.willRetryStatus = (statusCode) =>
      statusCode >= 300 &&
      replayableBody &&
      state.count <= maxRetries &&
      methods.includes(options.method) &&
      statusCodes.includes(statusCode);

    /*
     * Whether undici would retry a *transport* failure on this attempt, which is what decides
     * whether the request deadline waits for undici's own timeout rather than aborting (see
     * `requestSignal`). The same three conditions `willRetryStatus` asks about, plus one:
     *
     * `lastStatusCode === undefined` means this attempt's response head has not been delivered
     * yet. Once it has, `RetryHandler.onResponseError` propagates rather than retries, so there
     * is nothing to wait for - and that is exactly the trickling-body case the deadline exists
     * for, which keeps its exact bound. `countAttempts` clears the field on a re-dispatch so the
     * previous attempt's status cannot answer for this one.
     *
     * Left unset - and so never waited on - when the client's `errorCodes` do not cover a
     * timeout, since undici would refuse the retry whatever the deadline did.
     */
    if (this.retriesTimeouts) {
      state.canRetryError = () =>
        replayableBody &&
        state.count <= maxRetries &&
        methods.includes(options.method) &&
        state.lastStatusCode === undefined;
    }

    return state;
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
    const global = getGlobalDispatcher();
    let base = this.ownAgent ?? global;

    // While `./nock` is the global dispatcher, a client's own agent has to be routed through it
    // too, or mocks and `disableNetConnect()` never see that client's requests - see
    // `OwnAgentRoute` there. The route is memoised per agent, so the composition below still is.
    if (this.ownAgent !== undefined) {
      const route = (global as {[routeOwnAgent]?: (own: Dispatcher) => Dispatcher})[routeOwnAgent];

      if (route !== undefined) {
        base = route(this.ownAgent);
      }
    }

    if (this.#composedFrom !== base) {
      const options = this.baseOptions;
      const chain: Dispatcher.DispatcherComposeInterceptor[] = [];

      // Resolve first, so everything downstream talks to a cached address.
      if (options.dnsCache) {
        chain.push(interceptors.dns(options.dnsCache === true ? undefined : options.dnsCache));
      }

      // Skipped entirely when the client never follows redirects: the interceptor
      // rest-spreads the dispatch options on every request before it can bail out.
      if (this.followsRedirects) {
        // Must sit before `redirect` in the array: compose() wraps in order, so an earlier
        // entry ends up inside, and only something inside is re-entered per hop. Composed
        // whether or not there are hooks - it is also what records the final url.
        chain.push(makeRedirectTracker(this.beforeRedirectHooks), interceptors.redirect());
      }

      if (options.dedupe) {
        const dedupeOptions = options.dedupe === true ? undefined : options.dedupe;

        // Either side of `deduplicate`: one wraps every request it could group, the other sees
        // which of them it sent and counts what it parked on each - see `isolateDedupedAborts`.
        // Keyed on the same methods dedupe groups, `GET` by default.
        const isolated = isolateDedupedAborts(dedupeOptions?.methods ?? ['GET']);

        chain.push(isolated.inner, interceptors.deduplicate(dedupeOptions), isolated.outer);
      }

      if (options.cache) {
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
      validateRequest(options, this.followsRedirects);
    }

    const base = this.baseOptions;
    // Not a plain spread: a per-call option present with the value `undefined` must not
    // silently turn the client's own setting off. See `mergeOptions`.
    const formed = mergeOptions(base, options) as FormedOptions;

    // A body belongs to one request, never to a client. got doesn't merge `json`/`body`/`form`
    // from the defaults and neither does this - a client built with `json` was otherwise
    // sending that body on every request it made, GETs included. Guarded by a flag computed in
    // the constructor, so the usual case costs one boolean test rather than three reads.
    if (this.baseHasBody) {
      if (options.json === undefined) {
        formed.json = undefined;
      }

      if (options.body === undefined) {
        formed.body = undefined;
      }

      if (options.form === undefined) {
        formed.form = undefined;
      }
    }

    // Always a fresh object: handlers and `beforeRequest` hooks routinely write to
    // `options.headers`, and the instance defaults must not pick those up. Per-call names are
    // folded to lower case on the way in, so `{Authorization: ...}` replaces an instance
    // `authorization` rather than joining it.
    formed.headers = mergeHeaders(this.defaultHeaders, options.headers);

    // Merged rather than replaced, as got merges them. The spread has already picked the
    // right side whenever only one carries a query, so this costs one property read - and
    // reads `options` first, since a client with `searchParams` is the rarer of the two.
    if (options.searchParams !== undefined && base.searchParams !== undefined) {
      formed.searchParams = mergeSearchParams(base.searchParams, options.searchParams);
    } else if (formed.searchParams !== undefined) {
      /*
       * One-sided, so the spread handed over whichever object that was - the client's own or
       * the caller's - and a handler or hook writing `options.searchParams.foo` then reached
       * straight into it. Measured: a `beforeRequest` hook adding a parameter put it on every
       * later request the client made, and on the caller's own options literal when the query
       * came from the call. That is the same aliasing `cloneSearchParams` closed at
       * create/extend time, arriving per request instead. A string needs no copy and gets none.
       */
      formed.searchParams = cloneSearchParams(formed.searchParams);
    }

    /*
     * Only `timeout.request` is supported, so replacing the object outright is the same thing
     * as merging it - except when the override names no `request` at all. `{}`, or the
     * `{request: config.timeout}` of a config that didn't set one, then dropped the client's
     * deadline and left the request unbounded. No allocation either way.
     */
    if (options.timeout !== undefined && options.timeout.request === undefined && base.timeout !== undefined) {
      formed.timeout = base.timeout;
    }

    /*
     * The two remaining objects the spread aliases, copied for the same reason `headers` and
     * `context` always are: they are handed to code that writes to them. `timeout` was the
     * loud one - a hook doing `options.timeout.request = 5` for one request moved the
     * *client's* deadline permanently, so every later request it made timed out (measured).
     * `handlers` is the quieter half of the same hole: a push through `options.handlers`
     * lengthens the chain of every request the client makes afterwards.
     *
     * **Unconditional**, and these used to sit behind a `sharesOptions` flag - "a client with
     * neither handlers nor hooks has nothing that could write". That premise was wrong: the
     * formed options are handed to *every* caller, as `response.request.options` and
     * `error.options`, both of which this package documents. Measured on a client with no hooks
     * and no handlers, `response.request.options.timeout === client.baseOptions.timeout` and
     * the same for `searchParams` - so a caller, or any logging or retry wrapper that
     * normalises what it is shown, moved the client's deadline and added a query parameter to
     * every later request it made. The copies only run for a client that set the option at all,
     * which is what keeps them off a request that carries neither.
     */
    if (formed.timeout !== undefined) {
      formed.timeout = {...formed.timeout};
    }

    if (formed.handlers !== undefined) {
      formed.handlers = [...formed.handlers];
    }

    if (base.context && options.context) {
      formed.context = {...base.context, ...options.context};
    } else if (formed.context === undefined) {
      // Shared and frozen: `options.context.foo` should read as undefined rather than
      // throw when no context was set, without allocating an object per request. Frozen
      // so that a hook writing to it fails loudly instead of leaking across requests.
      formed.context = emptyContext;
    } else {
      // Only one side carried a context, so `formed` is aliasing whichever object that was.
      // Hooks write to `options.context`, and that write must not land on the client's own
      // context (where it would leak into every later request) or on the caller's object.
      formed.context = {...formed.context};
    }

    if (url !== undefined) {
      // got refuses this rather than picking a winner, and two urls in one call is always a
      // mistake worth hearing about - the argument used to quietly overwrite the option.
      // Measured against got 16, which goes further: since got 15 a `url` key in any options
      // object is a TypeError (`The \`url\` option is not supported in options objects. Pass
      // it as the first argument instead.`), with or without an argument beside it, and in
      // `extend()` too. The options-only callable form is built on that option, so it stays.
      // Inside the `url !== undefined` branch and behind `validate`, so the hot path pays one
      // property read for it.
      if (this.validate && options.url !== undefined) {
        invalid('`url` cannot be given both as an argument and as an option');
      }

      formed.url = url;
    }

    if (method !== undefined) {
      // The verb methods pass an upper-case literal, so the hot path needs no folding at all.
      formed.method = method;
    } else if (options.method !== undefined) {
      // The only method that can still be unfolded: the client's was folded at construction.
      formed.method = normaliseMethod(options.method);
    } else if (formed.method === undefined) {
      // `stream()` and the callable form pass no method, and a client built without the
      // exported defaults carries none either. undici would fill this in, but `call()` routes
      // the two stream paths on it - a missing method used to land a GET on the upload path,
      // where nothing ends the writable half and the request is never even sent.
      formed.method = 'GET';
    }

    return formed;
  }

  handle(
    options: RequestOptions & IsStream,
    url?: string | URL,
    method?: Dispatcher.HttpMethod,
  ): Promise<GotlikeStream | GotlikeUploadStream>;
  handle(options: TextCall & BodyOnly, url?: string | URL, method?: Dispatcher.HttpMethod): Promise<string>;
  handle(options: BufferCall & BodyOnly, url?: string | URL, method?: Dispatcher.HttpMethod): Promise<Buffer>;
  handle<T>(options: RequestOptions & BodyOnly, url?: string | URL, method?: Dispatcher.HttpMethod): Promise<T>;
  handle<T>(options?: RequestOptions, url?: string | URL, method?: Dispatcher.HttpMethod): Promise<Response<T>>;
  handle<T>(options: RequestOptions = {}, url?: string | URL, method?: Dispatcher.HttpMethod): Promise<any> {
    let formed: FormedOptions;

    // A synchronous throw out of a promise-returning method escapes `.catch()`, so a bad
    // option surfaces as a rejection like every other failure. Construction still throws
    // synchronously - `new Gotlike(...)` isn't async.
    try {
      formed = this.formOptions(options, url, method);

      /*
       * got hands handlers a url already resolved against `prefixUrl` and `searchParams`, and
       * the aggregator's logging handler reads it before calling `next`. It used to see the
       * bare `'games/launch'` here and the full url only after `next` resolved, since `call()`
       * resolves onto the same object. Recorded, so `call()` can tell whether a handler rewrote
       * the url - see the matching read there.
       */
      if (formed.handlers) {
        formed.url = asUrl(this.resolveUrl(formed));
        (formed as RetryDepth)[resolvedForHandlers] = String(formed.url);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    // handler merging only supported during client create or extend
    const handlers = formed.handlers;

    if (handlers) {
      /*
       * The options the request is finally made with. A handler may change anything on the way
       * down, `resolveBodyOnly` included, and the unwrap has to read the decision that reached
       * `call()` rather than the one the caller started with.
       */
      let dispatched = formed;

      /*
       * The index travels with the call instead of living in one shared counter: a handler
       * that called `next` twice used to advance the counter twice and silently skip the
       * handler after it.
       */
      const iterateHandlers = (newOptions: FormedOptions, index: number): Promise<Response> => {
        const handler = handlers[index];

        if (!handler) {
          dispatched = newOptions;

          return this.call(newOptions);
        }

        return handler(newOptions, (nextOptions) => iterateHandlers(nextOptions, index + 1));
      };

      // Read once the chain has resolved, not before it starts: a handler may await something
      // of its own, so `dispatched` isn't settled until the request has actually been made.
      return iterateHandlers(formed, 0).then((response) =>
        dispatched.resolveBodyOnly && !dispatched.isStream ? response.body : response,
      );
    }

    const result = this.call<T>(formed);

    // Unwrapped out here rather than in `call()` so that handlers and `afterResponse` hooks
    // always see a full Response. Unwrapping earlier means a handler doing
    // `response.timings` blows up whenever a caller asks for `resolveBodyOnly`.
    if (formed.resolveBodyOnly && !formed.isStream) {
      return result.then((response) => response.body) as Promise<Response<T>>;
    }

    return result;
  }

  /**
   * Whether *this* request follows redirects: the interceptor has to be composed (a
   * create/extend-time decision) and the call must not have opted out.
   *
   * `this.followsRedirects` alone is not enough - undici rejects `maxRedirections` outright
   * when the interceptor isn't in the chain, so with `validate: false` a per-request `true`
   * used to slip past the ValidationError and fail every request with an opaque
   * `UND_ERR_INVALID_ARG`. It also decides whether a 3xx reaching the caller is an error.
   */
  follows(options: FormedOptions): boolean {
    return this.followsRedirects && Boolean(options.followRedirect);
  }

  /**
   * The options every dispatch shares. `call()`, `callBodylessStream()` and `callStream()`
   * built this same literal three times over, which is three places to forget a field.
   */
  dispatchOptions(options: FormedOptions): SharedDispatchOptions {
    // Only clients with a handler or a `beforeRequest` hook can have picked up an unfolded
    // name since `formOptions` folded them; everyone else skips even the scan.
    if (this.mayRewriteHeaders && hasUnfoldedName(options.headers)) {
      options.headers = lowercaseHeaders(options.headers);
    }

    // Built first: the deadline consults `attempts.canRetryError` before it aborts, so that an
    // attempt undici could still retry is handed to undici's own timeout instead of being
    // killed by a signal it will never retry. See `requestSignal`.
    const attempts = this.attemptState(options);
    const deadline = requestSignal(options, attempts);

    if (attempts) {
      // Only a client that retries has anything to restart, and `attemptState` only allocates
      // for one - so the assignment costs nothing on a client without `retry`.
      attempts.restartDeadline = deadline.restart;
      attempts.pauseDeadline = deadline.pause;
    }

    return {
      dispatcher: this.agent,
      headers: options.headers,
      method: options.method,
      bodyTimeout: options.timeout?.request,
      headersTimeout: options.timeout?.request,
      signal: deadline.signal,
      release: deadline.release,
      resume: deadline.resume,
      maxRedirections: this.follows(options) ? maxRedirections : 0,
      // Only when redirects are actually in play. Allocating it for any client that merely
      // *had* a `beforeRedirect` hook meant a per-request object the tracker never read.
      redirects: this.follows(options) ? {count: 0} : undefined,
      // Handed to every dispatch, streams included: this is what drives `retryCount` and
      // fires `beforeRetry`.
      attempts,
    };
  }

  /**
   * Join `prefixUrl` and `url`: the prefix keeps exactly one trailing slash and the path never
   * contributes a leading one, so neither side can produce the `//` that plain concatenation
   * used to.
   *
   * An empty `url` is the prefix *with* that slash, which is got's answer too - it normalises
   * `prefixUrl` to end in `/` and resolves `''` against it. Handing back the prefix verbatim
   * instead put a different path on the wire for `client.get('')`: `GET /api` where got sends
   * `GET /api/`, which a server is free to answer with a 301 (not followed by default here, so
   * it surfaces as the redirect itself) or a 404. Silent, and only for a `prefixUrl` written
   * without a trailing slash - which is the form the README's own examples use.
   */
  resolveUrl(options: FormedOptions): string {
    const url = options.url === undefined ? '' : String(options.url);

    // An absolute url wins over the prefix. got would refuse the combination outright;
    // silently concatenating the two is the worse failure mode, since callers do mix
    // absolute urls and prefixed clients.
    const joined =
      !options.prefixUrl || absoluteUrl.test(url)
        ? url
        : (options.prefixUrl.endsWith('/') ? options.prefixUrl : options.prefixUrl + '/') +
          // Every leading slash, not just the first: stripping one left `//evil/x` as
          // `prefix//evil/x`, which is the `//` this is supposed to rule out.
          url.replace(leadingSlashes, '');

    if (options.searchParams === undefined) {
      return joined;
    }

    /*
     * The fragment has to come off with the query, and never goes back on: it is not sent to the
     * server anyway. Splitting on `?` alone appended the query *inside* a fragment -
     * `http://h/p#frag` became `http://h/p#frag?a=1`, the server saw `/p`, and the search params
     * vanished off the wire with no error at all. `withoutQuery` is what takes both off, and the
     * HTTP-error message uses it for its own reason.
     */
    const search = stringifyQuery(options.searchParams);

    // got's `searchParams` replaces the url's own query rather than merging into it.
    const base = withoutQuery(joined);

    return search ? base + '?' + search : base;
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
      /*
       * A throwing hook - or one that rejects - used to escape this function entirely: nothing
       * here caught it, so `await this.toRequestError(...)` itself rejected with the hook's raw
       * throw, skipping the `RequestError` wrapper for a failure that already had one built.
       * Every call site does `throw await this.toRequestError(...)`, so that raw value became
       * the error every caller saw - indistinguishable from a network failure to anything
       * matching on `instanceof RequestError`, and never reaching `normalisedErrors` either,
       * so a stream failure fell back to the *original*, unnormalised transport error too (see
       * `normaliseStreamErrors`). got wraps the same failure in a `RequestError` rather than
       * letting it through raw, so this does too.
       */
      try {
        for (const hook of this.beforeErrorHooks) {
          const replacement = await hook(error as RequestError);

          if (replacement instanceof Error) {
            error = replacement;
          }
        }
      } catch (hookError) {
        error = new RequestError(
          messageOf(hookError, 'beforeError hook failed'),
          codeOf(hookError, 'ERR_REQUEST_ERROR'),
          hookError as Error,
          options,
          response,
        );
      }
    }

    // Recorded so `normaliseStreamErrors` lets it through untouched rather than wrapping it
    // again and re-firing the hooks.
    normalisedErrors.add(error);

    return error;
  }

  async call<T = unknown>(options: FormedOptions): Promise<Response<T>> {
    let undiciResponse;
    let responseBody;
    let rawText;
    let startTime;
    let attempts: AttemptState | undefined;
    let redirects: RedirectState | undefined;
    let parseFailed = false;
    // Cancels the deadline once the body has been read, however that turned out. The stream
    // paths own theirs, so this stays a no-op on the branch that hands off to them.
    let release = noRelease;
    let url = '';

    /*
     * Everything that runs before the request gets its own try: a throwing `beforeRequest`
     * hook (or a circular `json`) used to reject with the raw error, skipping both the
     * `RequestError` wrapper and the `beforeError` hooks, so a caller matching on
     * `instanceof RequestError` silently missed it.
     */
    try {
      // The resolved URL is what hooks and handlers should see and what request signing
      // needs, so write it back before anything gets a look at the options.
      const handed = (options as RetryDepth)[resolvedForHandlers];

      if (handed === undefined) {
        options.url = asUrl(this.resolveUrl(options));
      } else {
        /*
         * `handle()` already resolved the url for the handler chain. Resolving it again is
         * idempotent unless a handler rewrote it - and then `searchParams` replaced the query the
         * handler had just built: `options.url.searchParams.set('sig', …)`, the got way to sign a
         * url, was silently dropped off the wire whenever the request also carried
         * `searchParams` (got 16 sends both). The rule the `beforeRequest` hooks get below: a
         * url rewritten to an absolute one is taken as written, a relative one is resolved again.
         * A handler that only changed `searchParams` leaves the url equal and is re-resolved as
         * before. Cleared once read, so a retry spreading these options does not inherit it.
         */
        (options as RetryDepth)[resolvedForHandlers] = undefined;

        const current = String(options.url ?? '');

        options.url = asUrl(current !== handed && absoluteUrl.test(current) ? current : this.resolveUrl(options));
      }

      url = String(options.url);

      // `http://user:pass@host/` carries credentials that undici ignores, so they have to
      // come off the url and go into the header here - before hooks see either. got gets this
      // for free by keeping them on a `URL`, which node then turns into `Authorization`.
      // Skipped entirely with `parseUserinfo: false`, for a client whose urls never carry
      // credentials and would rather not pay for the scan.
      const userinfo = this.parseUserinfo ? splitUserinfo(url) : undefined;

      if (userinfo) {
        options.url = asUrl(userinfo.url);
        url = String(options.url);
      }

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

      /*
       * got derives an `accept` from `responseType`, and sending none meant an upstream doing
       * content negotiation could answer a gotlike request with HTML where it answered got's
       * with JSON - a difference in what comes *back*, which is the one thing a drop-in
       * replacement must not have. Measured against got 16: `application/json` for `json` and
       * nothing at all for `text`, `buffer` or an unset `responseType`, with an explicit
       * `accept` always winning.
       *
       * Per request rather than folded into `defaultHeaders` like `accept-encoding`, because
       * `responseType` can be overridden per call: a json client making one text call must not
       * still ask for json. The header scan only runs when the call is a json one.
       */
      if (options.responseType === 'json' && !hasHeader(options.headers, 'accept')) {
        options.headers['accept'] = 'application/json';
      }

      // Explicit options win over the url's own userinfo, as they do in got - setting
      // `username` there overwrites whatever the url carried.
      const username = options.username ?? userinfo?.username;
      const password = options.password ?? userinfo?.password;

      // `hasCredentials`, not `!== undefined`: an empty username and password are no
      // credentials at all, and got sends no header for them.
      /** The header derived here, if any, so a hook changing the credentials can replace it. */
      let derivedAuthorization: string | undefined;

      if (hasCredentials(username, password) && !hasHeader(options.headers, 'authorization')) {
        derivedAuthorization = basicAuthorization(username, password);
        options.headers['authorization'] = derivedAuthorization;
      }

      if (this.beforeRequestHooks) {
        // What the url and the header above were derived from, so a hook that changes either
        // without touching `options.url` is still honoured - see `withQuery` and
        // `applyHookCredentials`.
        const credentialsBefore = {username: options.username, password: options.password};
        // Taken before the hooks run because that is the only moment it exists - see
        // `crossOriginState`. One allocation, and only for a client that has hooks.
        const before = crossOriginState(options);
        // Installed for the same reason and the same audience - see `trackHookWrites`.
        const writes = trackHookWrites(options);

        /*
         * `finally`, because a hook that *throws* leaves the request just as instrumented as one
         * that returns. The restore used to sit after the loop, so a throwing hook left the
         * `Proxy` on `options.headers` and the accessor on `options.body` - and that options
         * object is handed straight to the `beforeError` hooks and out on `error.options`, where
         * every header read went through a trap that had no business still being there.
         */
        try {
          for (const hook of this.beforeRequestHooks) {
            await hook(options);
          }
        } finally {
          // The instrumentation is only needed while the hooks can still write, and `writes` is
          // settled now - so everything below, undici included, reads plain objects again.
          writes.restore();
        }

        /*
         * A hook may rewrite `options.url` - request signing does exactly that. The dispatch
         * used a local captured *before* the hooks ran, so the rewrite was read by nothing and
         * the original url went out regardless.
         *
         * A url the hook left absolute is taken exactly as written: re-resolving it would put
         * `searchParams` back over the top and wipe a query the hook had just built, which is
         * the whole point of signing it. Only a relative one is resolved again, so a hook can
         * still rewrite the path and have `prefixUrl` applied.
         */
        // Compared by value: the url is a `URL`, and a hook may rewrite it in place
        // (`options.url.searchParams.set('sig', …)`) rather than assign a new one.
        const rewritten = String(options.url ?? '');

        if (rewritten !== url) {
          const next = String(asUrl(absoluteUrl.test(rewritten) ? rewritten : this.resolveUrl(options)));

          /*
           * A hook that moves the request to another origin does not take the credentials with
           * it. The `authorization` a caller set for their own api, the `cookie` their session
           * lives in, and the body they meant for that api all went to whatever host the hook
           * named - and a hook is exactly where a url comes from somewhere else (a signing
           * service, a discovered endpoint, a redirect the caller resolves themselves). undici
           * strips these when it follows a cross-origin redirect; this is the same boundary
           * reached by the other route. got 16 does it too, which is what fixed it there.
           */
          if (!sameOrigin(url, next)) {
            stripCrossOrigin(options, before, writes);
          }

          /*
           * `splitUserinfo` only ever ran on the url this request started with, before the
           * hooks saw it - so a hook that rewrote the url to `http://new-user:new-pass@host/`
           * (signing onto a discovered endpoint, say) had those credentials go out anonymous:
           * undici ignores userinfo in the url outright, and nothing derived a header for it a
           * second time. Skipped under `parseUserinfo: false`, same as the pre-hook parse this
           * mirrors. A hook that set its own `authorization` explicitly still wins.
           */
          const rewrittenUserinfo = this.parseUserinfo ? splitUserinfo(next) : undefined;

          if (rewrittenUserinfo) {
            // The userinfo comes off the url either way - `http://@host/` is `http://host/` to
            // every parser - but only real credentials earn a header. See `hasCredentials`.
            if (
              hasCredentials(rewrittenUserinfo.username, rewrittenUserinfo.password) &&
              !hasHeader(options.headers, 'authorization')
            ) {
              options.headers['authorization'] = basicAuthorization(
                rewrittenUserinfo.username,
                rewrittenUserinfo.password,
              );
            }

            options.url = asUrl(rewrittenUserinfo.url);
          } else {
            options.url = asUrl(next);
          }

          url = String(options.url);
        } else if (options.searchParams !== undefined) {
          const updated = withQuery(url, options.searchParams);

          // Unchanged is the common case, and it keeps the hook's `URL` rather than reparsing.
          if (updated !== url) {
            options.url = asUrl(updated);
            url = String(options.url);
          }
        }

        applyHookCredentials(options, credentialsBefore, derivedAuthorization, writes);
      }

      /*
       * A `FormData` body is encoded here, not passed through: `undici.request()` does not
       * accept one. It does not reject it either - measured, the request simply never leaves
       * and the caller waits forever, which is the worst way to find out. got 15 made the
       * `FormData` global the documented way to send multipart, so a caller migrating writes
       * exactly this.
       *
       * `Response` is the encoder node already ships: it produces the multipart bytes and the
       * `content-type` carrying the boundary, which has to be the one that encoding generated.
       * The body goes out as a stream rather than a buffer so a large upload is not
       * materialised in memory - with the consequence, as in got, that it cannot be replayed
       * across a redirect or a retry.
       *
       * After the hooks, so a hook still sees the `FormData` it was given and can add to it.
       */
      if (options.body instanceof FormData) {
        const encoded = new Response(options.body);
        const contentType = encoded.headers.get('content-type');

        if (contentType !== null && !hasHeader(options.headers, 'content-type')) {
          options.headers['content-type'] = contentType;
        }

        options.body = Readable.fromWeb(encoded.body as Parameters<typeof Readable.fromWeb>[0]);
      }
    } catch (error) {
      /*
       * A `ValidationError` passes through untouched, for the reason the `afterResponse` catch
       * below lets one through: it says the caller configured something wrong rather than that a
       * request failed, and the class is kept distinct from `RequestError` everywhere else - it
       * is a pinned divergence from got, and the README tells callers to match on it.
       *
       * `searchParams`/`form` *values* are what reach here. `validateOptions` checks the
       * container's shape, `queryValue` checks each value as the query is serialised, and
       * wrapping the second made one kind of bad option report itself as a transport failure -
       * `beforeError` hooks and all - while the identical mistake one option along threw a
       * `ValidationError`.
       */
      if (error instanceof ValidationError) {
        throw error;
      }

      // The hook's own message, not a generic one - it is the only thing that says what
      // actually went wrong. Via `messageOf`, since `throw 'string'` and `throw null` are both
      // legal and `(error as Error).message` threw a TypeError of its own on the second.
      throw await this.toRequestError(
        messageOf(error, 'Request error'),
        codeOf(error, 'ERR_REQUEST_ERROR'),
        error as Error,
        options,
      );
    }

    // make request
    try {
      const body = options.body;

      if (options.isStream) {
        /*
         * The method alone decides, not whether a body happens to be present. The pipeline
         * path exists so the *caller* can write the request body into the duplex's writable
         * half; a body that came in through the options needs none of that, and paid for it
         * dearly - `RedirectHandler` refuses to follow a redirect whose body it cannot
         * replay, so `stream(url, {body})` on a GET resolved with the bare 302 and an empty
         * body however `followRedirect` was set. Routed through `undici.request` the body is
         * an ordinary replayable one and the chain is followed. The `stream()` overloads
         * already typed a non-body method as a `Readable`, so this is also what they claim.
         */
        const stream = isBodyMethod(options.method) ? this.callStream(options) : await this.callBodylessStream(options);

        return stream as unknown as Response<T>;
      }

      startTime = process.hrtime();

      const dispatch = this.dispatchOptions(options);

      // Only allocated for clients that actually retry; everyone else reports 0.
      attempts = dispatch.attempts;
      // Only allocated when redirects are being followed; records where the chain ended.
      redirects = dispatch.redirects;
      release = dispatch.release;

      const requestOptions: UndiciRequestOptions = {
        ...dispatch,
        body,
      };

      undiciResponse = await undici.request(url, requestOptions);

      // The response is ours, so nothing is going to retry it - if the retry bookkeeping paused
      // the deadline expecting one, the body read below would otherwise run unbounded.
      dispatch.resume();

      if (hasNoBody(undiciResponse.statusCode, options.method)) {
        // 204/205/304 and HEAD cannot carry a body, so there is nothing to parse. Attempting
        // it anyway turned every empty 204 into a parse failure.
        await undiciResponse.body.dump();

        responseBody =
          options.responseType === 'json' ? undefined : options.responseType === 'buffer' ? Buffer.alloc(0) : '';
      } else if (options.responseType === 'json') {
        const text = await undiciResponse.body.text();

        // Keep the raw text reachable: it is what `error.response.body` should show on a
        // parse failure, and what `response.rawBody` has to hand back on a successful one.
        responseBody = text;
        rawText = text;

        /*
         * An empty body is never a parse failure, whatever the status.
         *
         * `hasNoBody` above only covers the statuses that *cannot* carry one - 204, 205, 304 and
         * HEAD - so every other status with a zero-length body fell into `JSON.parse('')` and
         * came back out as a `ParseError`. That is an ordinary response: a `201 Created` with
         * nothing in it, a `200` with `content-length: 0`, a `302` read with `followRedirect`
         * off. Measured against got 16, which resolves all three with `body: ''` - its
         * `parseBody` tests `rawBody.length === 0` before it ever reaches the JSON codec, and
         * this is the same test one decoding later.
         *
         * `''` rather than `undefined`, because that is what got hands back. The bodyless
         * statuses keep their `undefined` (see `hasNoBody`, and the README), which stays a
         * deliberate, recorded divergence - this is the case that was never meant to be one.
         */
        if (text !== '') {
          try {
            responseBody = JSON.parse(text);
          } catch (error) {
            /*
             * On an error status the parse failure is not the story - the status is. An upstream
             * answering a 500 with an HTML error page used to fail with `ERR_BODY_PARSE_FAILURE`
             * *before* the `afterResponse` hooks ran, so a token-refresh hook never saw the 401
             * that a proxy had wrapped in HTML. The body is left as the text that arrived, the
             * hooks get to look at it, and `throwHttpErrors` decides from there.
             *
             * Measured against got 16: a 500 with an unparseable body runs the hooks and throws
             * `HTTPError`, and with `throwHttpErrors: false` it *resolves*, body and all. Only a
             * parse failure on an otherwise-ok response is a `ParseError`.
             */
            if (!isHttpError(undiciResponse.statusCode, this.follows(options))) {
              // Flagged rather than recognised by message. V8 words this differently depending
              // on the input ("Unexpected end of JSON input" vs "... is not valid JSON"), and
              // matching on the wording misfiled empty bodies as generic request errors.
              parseFailed = true;

              throw error;
            }

            // Otherwise `responseBody` keeps the text assigned above, which is what arrived.
          }
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
          rawText,
          redirects?.lastUrl,
        );

      if (err instanceof HeadersTimeoutError || err instanceof BodyTimeoutError) {
        throw await this.toRequestError(err.message, 'ETIMEDOUT', err, options, response, TimeoutError);
      }

      if (parseFailed) {
        // got appends the url to V8's message, and a parse failure with no url in it is hard to
        // place in a log line. Measured against got 16, down to the quoting.
        throw await this.toRequestError(
          `${(err as Error).message} in "${String(options.url)}"`,
          'ERR_BODY_PARSE_FAILURE',
          err as Error,
          options,
          response,
          ParseError,
        );
      }

      /*
       * A signal reports its reason as a DOMException: `AbortError` from `abort()`, and
       * `TimeoutError` from `AbortSignal.timeout()`. The latter is a timeout by any useful
       * definition, so it lands on the same class and code as `timeout.request` - and it is
       * tested first, since the abort test below is the broader of the two.
       */
      if (isTimeoutReason(err, options.signal)) {
        throw await this.toRequestError(
          messageOf(err, 'Request timed out'),
          'ETIMEDOUT',
          err as Error,
          options,
          response,
          TimeoutError,
        );
      }

      /*
       * `options.signal?.aborted` as well as the name: `abort(new Error('cancelled'))` makes
       * undici throw that reason verbatim, so the error is a plain `Error` and the name test
       * alone reported a cancelled request as a generic `ERR_REQUEST_ERROR`.
       */
      if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) {
        throw await this.toRequestError(
          messageOf(err, 'Request aborted'),
          'ERR_ABORTED',
          err as Error,
          options,
          response,
          AbortError,
        );
      }

      // The underlying message, not a generic one - the same reasoning as the pre-request
      // catch above. "Request error" was all that reached `error.message` for a connection
      // refused, a DNS failure and a malformed url alike, leaving every log line and every
      // APM grouping unable to tell them apart. got reports the underlying message too.
      throw await this.toRequestError(
        messageOf(err, 'Request error'),
        codeOf(err, 'ERR_REQUEST_ERROR'),
        err as Error,
        options,
        response,
      );
    } finally {
      // The body has been read (or the request has failed), so the deadline has nothing left
      // to bound. `afterResponse` hooks run after this and are deliberately outside it: they
      // are the caller's own code and were never covered by `timeout.request`.
      release();
    }

    let response: Response<T> = new GotlikeResponse<T>(
      responseBody as T,
      undiciResponse.headers,
      undiciResponse.statusCode,
      retriesFrom(attempts),
      elapsedMs(startTime),
      options,
      rawText,
      redirects?.lastUrl,
    );

    // Runs before `throwHttpErrors` on purpose: got-style token refresh hooks need to see
    // the 401 that triggers them.
    if (this.afterResponseHooks) {
      const hooks = this.afterResponseHooks;

      /*
       * How far to go. A hook-driven retry re-enters `call()`, and running the whole array
       * again from the start meant a refreshed request re-ran every earlier hook and let the
       * retrying hook see its own retry. got cuts the array at the hook that retried; this
       * symbol is how that index reaches the retried call.
       */
      const limit = (options as RetryDepth)[afterResponseLimit] ?? hooks.length;

      /*
       * The loop has its own try, like the pre-request work above. A hook that throws - or
       * one that simply forgets to return the response - used to escape as a raw error,
       * skipping the `RequestError` wrapper and the `beforeError` hooks entirely, so a caller
       * matching on `instanceof RequestError` missed it. got wraps this same loop.
       */
      try {
        for (let index = 0; index < limit; index++) {
          const hook = hooks[index]!;
          const triggerStatusCode = response.statusCode;
          /*
           * Retries behind the response this hook is being handed - network ones undici made,
           * plus any earlier hook's. Carried into the retry so its own count continues from
           * here rather than starting over: two hooks that each retry once are two retries,
           * and the counter is the only thing a caller has to see that.
           */
          const retriesSoFar = response.retryCount;
          /*
           * Set once a hook asks for a retry, which ends the loop: the hooks after it never run.
           * got's `retryWithMergedOptions` throws a `RetryError` that abandons this loop and
           * restarts the request with the cut array, so its later hooks see neither response.
           * Carrying on here ran them on the retried one - `[h1, h2, h3]` with `h2` retrying gave
           * `h1, h2, h1, h3` where got gives `h1, h2, h1`.
           */
          let retried = false;
          const returned = await hook(response, (newOptions) => {
            retried = true;

            return this.retryWithMergedOptions<T>(options, newOptions, index, triggerStatusCode, retriesSoFar);
          });

          if (!isResponseLike(returned)) {
            throw new TypeError('The `afterResponse` hook returned an invalid value');
          }

          response = returned;

          if (retried) {
            break;
          }
        }
      } catch (error) {
        // Anything raised through `toRequestError` - the retry's own failure, an exhausted
        // retry budget - is already normalised and has already run the hooks. Re-wrapping it
        // would fire them a second time.
        //
        // A `ValidationError` passes through for a different reason: it says the caller
        // configured something wrong rather than that a request failed, and the class is kept
        // distinct from `RequestError` everywhere else (it is a pinned divergence from got in
        // the parity suite). A bad option handed to `retryWithMergedOptions` has to report
        // itself the same way the identical option on the original call does.
        if (normalisedErrors.has(error as object) || error instanceof ValidationError) {
          throw error;
        }

        throw await this.toRequestError(
          messageOf(error, 'afterResponse hook failed'),
          codeOf(error, 'ERR_REQUEST_ERROR'),
          error as Error,
          options,
          response,
        );
      }
    }

    /*
     * `response.request.options`, not the outer `options` - an `afterResponse` hook that
     * retried replaced `response` with one built from `retryWithMergedOptions`'s merged
     * options (a new `url`, a `throwHttpErrors: false`, ...), and that nested call already
     * decided whether *it* should throw using those. Reading the outer, pre-retry `options`
     * here re-ran that decision against the wrong url and the wrong flag: a hook retrying
     * with `throwHttpErrors: false` still got an `HTTPError` naming the original url, because
     * the original request had `throwHttpErrors: true`. For a request with no retry,
     * `response.request.options` and `options` are the same object, so this changes nothing.
     *
     * Falls back rather than assuming: `isResponseLike` deliberately accepts anything carrying
     * a numeric `statusCode`, so a hook handing back a response it built itself - `{statusCode:
     * 200, body}` - has no `request` at all. Reading straight through it threw a bare
     * `Cannot read properties of undefined (reading 'options')` from *outside* the hook loop's
     * try, which is the one place a raw error could still escape the `RequestError` wrapper and
     * the `beforeError` hooks. The request's own options are the right answer for a response
     * that names none.
     */
    const effectiveOptions = response.request?.options ?? options;

    if (effectiveOptions.throwHttpErrors && isHttpError(response.statusCode, this.follows(effectiveOptions))) {
      throw await this.toRequestError(
        httpErrorMessage(response.statusCode, effectiveOptions),
        httpErrorCode,
        undefined,
        effectiveOptions,
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
    const dispatch = this.dispatchOptions(options);

    let undiciResponse;

    try {
      // A body is legal on a bodyless *method* - undici sends one on a GET, and this is the
      // path that keeps it replayable across a redirect. The cast is for `FormData`: undici
      // declares its own, structurally different from the global one this option accepts, and
      // by here a `FormData` has already been encoded to a stream and cannot reach this.
      undiciResponse = await undici.request(String(options.url), {
        ...dispatch,
        body: options.body as UndiciRequestOptions['body'],
      });
    } catch (error) {
      // Nothing left to bound - the request never got off the ground.
      dispatch.release();

      // Reported through the duplex rather than by rejecting `stream()`, so that both
      // stream paths fail the same way whatever the caller is listening on. Normalised the
      // same way `call()` normalises it, `beforeError` hooks included.
      return asStream(Readable.from([]), undefined, await this.toStreamError(error as Error, options));
    }

    // The response is ours, so nothing is going to retry it - see the same call in `call()`.
    dispatch.resume();

    // The body is what the deadline still has to cover: the head has arrived, but a trickling
    // or truncated body is exactly what `timeout.request` is there to catch. Dumping it below
    // closes it too, so the error path releases through the same listener.
    releaseOnClose(undiciResponse.body, dispatch.release);

    const streamHead = makeStreamHead(undiciResponse.statusCode, undiciResponse.headers, options, dispatch, startTime);

    if (!options.throwHttpErrors || !isHttpError(undiciResponse.statusCode, this.follows(options))) {
      // The head arrived, but the body can still fail: a socket reset part-way through a
      // download used to surface undici's raw `SocketError` and skip the `beforeError` hooks.
      // The head goes with the failure when it does - see `streamResponse`.
      return asStream(
        this.normaliseBodyErrors(undiciResponse.body, options, () => streamResponse(streamHead, options, dispatch)),
        streamHead,
      );
    }

    // The body is being replaced by the error, so let undici reclaim the socket.
    undiciResponse.body.dump().catch(() => undefined);

    // Built through `toRequestError` like every other failure: it carries the response the
    // way the docs promise, and it runs the `beforeError` hooks, which a bare
    // `new HTTPError(...)` skipped entirely for streams.
    const error = await this.streamHttpError(streamHead, options, dispatch);

    // The body was dumped just above, so there is nothing left to present - the error readable
    // `asStream` builds for a failure is what the caller reads.
    return asStream(Readable.from([]), streamHead, error);
  }

  /**
   * The `HTTPError` for a stream whose status `throwHttpErrors` refuses, on both stream paths.
   *
   * Built through `toRequestError` like every other failure, so it carries the response the way
   * the docs promise and runs the `beforeError` hooks - a bare `new HTTPError(...)` skipped them
   * entirely for streams. The body has already been dumped or resumed by the time this is
   * called, so the response it carries has none.
   *
   * Not awaited here: the bodyless path awaits it, and the pipeline path has to keep the promise
   * so the readable it returns can raise it at read time rather than throwing synchronously.
   */
  streamHttpError(head: StreamHead, options: FormedOptions, dispatch: SharedDispatchOptions): Promise<Error> {
    return this.toRequestError(
      httpErrorMessage(head.statusCode, options),
      httpErrorCode,
      undefined,
      options,
      streamResponse(head, options, dispatch),
      HTTPError,
    );
  }

  /**
   * Make a stream raise `RequestError`s rather than undici's raw ones, with the `beforeError`
   * hooks applied - what got does, and what the README promises. Used on both stream paths.
   *
   * `respondedWith` is asked for the head the failure should carry, and only on a failure - a
   * mid-body one (a truncated download, a socket reset) happens *after* a response arrived and
   * must report it, exactly as `call()`'s catch does. It is a callback rather than a value
   * because the upload path installs this before its head exists, and returns `undefined` while
   * that is still true.
   */
  normaliseBodyErrors<T extends Readable>(
    stream: T,
    options: FormedOptions,
    respondedWith: () => Response<undefined> | undefined,
  ): T {
    return normaliseStreamErrors(
      stream,
      (error) => this.toStreamError(error, options, respondedWith()),
      // Only the request's own failures are normalised and run the `beforeError` hooks; a
      // consumer destroying the stream is not a failed request. See `isRequestFailure`.
      (cleanupError, destroyedWith) =>
        isRequestFailure(cleanupError, destroyedWith, options.signal, () => respondedWith() !== undefined),
    );
  }

  /**
   * Normalise a stream failure the way `call()`'s catch does, so that a stream and a plain
   * request report the same thing for the same underlying error - `response` included.
   */
  toStreamError(error: Error, options: FormedOptions, response?: Response<undefined>): Promise<Error> {
    if (error instanceof HeadersTimeoutError || error instanceof BodyTimeoutError) {
      return this.toRequestError(error.message, 'ETIMEDOUT', error, options, response, TimeoutError);
    }

    if (isTimeoutReason(error, options.signal)) {
      return this.toRequestError(
        messageOf(error, 'Request timed out'),
        'ETIMEDOUT',
        error,
        options,
        response,
        TimeoutError,
      );
    }

    if (error?.name === 'AbortError' || options.signal?.aborted) {
      return this.toRequestError(
        messageOf(error, 'Request aborted'),
        'ERR_ABORTED',
        error,
        options,
        response,
        AbortError,
      );
    }

    return this.toRequestError(
      messageOf(error, 'Request error'),
      codeOf(error, 'ERR_REQUEST_ERROR'),
      error,
      options,
      response,
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

    const dispatch = this.dispatchOptions(options);

    let duplex: GotlikeUploadStream;
    /**
     * The head, once it has arrived, for a failure that comes *after* it - a socket reset
     * part-way through the response body. `undefined` until then, which is what makes a
     * pre-response failure (a connection refused) still report no response at all.
     */
    let responded: StreamHead | undefined;

    try {
      duplex = undici.pipeline(String(options.url), dispatch, ({statusCode, headers, body}) => {
        // The response is ours, so nothing is going to retry it - see the same call in `call()`.
        dispatch.resume();

        const streamHead = makeStreamHead(statusCode, headers, options, dispatch, startTime);

        responded = streamHead;
        resolveHead(streamHead);
        duplex.emit('response', streamHead);

        if (!options.throwHttpErrors || !isHttpError(statusCode, this.follows(options))) {
          return body;
        }

        // The body is being replaced by the error, so let undici reclaim the socket.
        body.resume();

        /*
         * Raised by the readable at read time, exactly as `asStream` does on the other
         * stream path, rather than thrown from here. Throwing was synchronous, which left no
         * room to await the `beforeError` hooks or to attach the response - so a streamed
         * failure skipped the hooks entirely and arrived with `error.response` undefined,
         * which the documented contract says only happens when no response ever came.
         */
        const failure = this.streamHttpError(streamHead, options, dispatch);

        // Nothing is obliged to read the stream, and an unhandled rejection would take the
        // process down.
        failure.catch(() => undefined);

        let raised = false;

        return new Readable({
          read() {
            if (raised) {
              return;
            }

            raised = true;
            failure.then((error) => this.destroy(error), noop);
          },
        });
      }) as unknown as GotlikeUploadStream;
    } catch (error) {
      // Nothing left to bound - the request never got off the ground.
      dispatch.release();

      // `undici.pipeline` can reject its arguments synchronously. Reported on the stream like
      // every other stream failure, rather than by rejecting `stream()` - which is what the
      // bodyless path already did for the same class of error.
      return failedUploadStream(this.toStreamError(error as Error, options));
    }

    // The duplex covers the whole exchange here - upload and download both - so its close is
    // the moment the deadline stops being needed.
    releaseOnClose(duplex, dispatch.release);

    /*
     * Installed before anything can fail - `undici.pipeline` returns synchronously and every
     * failure it reports is asynchronous. This is the only thing standing between the caller
     * and undici's raw errors on this path: a connection refused arrived as a bare `Error`, a
     * `timeout.request` as a `DOMException` with a numeric `code`, and a mid-body socket reset
     * as a `SocketError`, none of them running the `beforeError` hooks. The bodyless path had
     * always normalised its pre-response failures; this one never did.
     */
    this.normaliseBodyErrors(duplex, options, () => responded && streamResponse(responded, options, dispatch));

    // Fires with the normalised error, since that is what `_destroy` hands on to be emitted.
    duplex.on('error', (error: Error) => rejectHead(error));

    /*
     * `undici.pipeline` takes the request body from the duplex's writable side, not from
     * `opts.body` - so a body supplied through the options has to be written here. With no
     * body in the options the writable half is left open for the caller to write to and end
     * themselves, which is the whole reason this path hands back a duplex.
     *
     * There is no arm here for a method that cannot carry a body: `call()` routes those to
     * `callBodylessStream` before ever reaching this, so the only methods that get here are
     * `bodyMethods` ones. If that routing is ever widened, this needs an `end()` for the
     * bodyless case again - without one `undici.pipeline` never sends the request and the
     * caller waits forever.
     *
     * `null` is a legal `body` (declared as such on `RequestOptions`) and means the same thing
     * here it does on the non-stream path: no body. It used to fall through this check entirely
     * and leave the writable half open for a caller who had explicitly said there was nothing
     * to write - `stream.post(url, {body: null})` hung forever waiting for an `end()` nobody
     * was going to call, on a call site that had already asked for the request to be sent as
     * it stood. `duplex.end()` with no argument is what that call means.
     */
    if (options.body === null) {
      duplex.end();
    } else if (options.body !== undefined) {
      /*
       * A stream body is piped in, not handed to `end()`. `RequestOptions.body` declares
       * `Readable`, and `call()` turns a `FormData` into one before it ever reaches here, so
       * both arrived at `duplex.end(readable)` - which rejects anything that isn't a string,
       * `Buffer` or view, and failed every `stream.post(url, {body})` carrying one with
       * `ERR_INVALID_ARG_TYPE`. The same body through the non-stream path has always worked.
       *
       * The source's own failure has to be forwarded by hand: `pipe` neither propagates an
       * error nor ends the destination, so a source that broke mid-upload left the request
       * hanging with nothing to report. Destroying the duplex is what `normaliseBodyErrors`
       * above is watching for, so the caller gets it as a `RequestError` like every other
       * stream failure. `stream.pipeline` would do both, but it also finishes the duplex's
       * *readable* half, which is the half the caller is here to read.
       */
      if (options.body instanceof Readable) {
        const source = options.body;

        source.once('error', (error: Error) => duplex.destroy(error));
        source.pipe(duplex);
      } else {
        duplex.end(options.body);
      }
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
  async retryWithMergedOptions<T>(
    options: FormedOptions,
    newOptions: RequestOptions,
    /** Index of the `afterResponse` hook driving this retry; absent when called directly. */
    hookIndex?: number,
    /** The status that triggered this retry, for `beforeRetry` - absent when called directly. */
    triggerStatusCode?: number,
    /**
     * Retries already behind the response that triggered this one, so `retryCount` keeps
     * counting rather than restarting. Absent when called directly, where there is no
     * response to have counted any.
     */
    retriesSoFar = 0,
  ): Promise<Response<T>> {
    /*
     * The hook's options get the same check a per-call options object gets, because this is the
     * one route into `call()` that does not go through `formOptions` - so nothing validated them
     * and nothing normalised them. That made the retry path a second, permanent `validate: false`
     * that no caller could turn on: `retry({responseType: 'jsn'})` fell past the `json`/`text`
     * arms and handed back a `Buffer`, `retry({timeout: {request: 0}})` slipped past the check
     * written specifically to reject `0`, and `retry({prefixUrl: 'http://h?q=1'})` past the one
     * that keeps a prefix from mangling the join. Gated on `this.validate`, exactly as
     * `formOptions` gates its own - and through the same `validateRequest`, so the two cannot
     * drift the way they had over `followRedirect`.
     */
    if (this.validate) {
      validateRequest(newOptions, this.followsRedirects);
    }

    const depth = ((options as RetryDepth)[retryDepth] ?? 0) + 1;
    /** Which retry this is, across every route that produced one. */
    const retryCount = retriesSoFar + 1;

    if (depth > maxAfterResponseRetries) {
      // A hook that keeps retrying on a status it never stops seeing - an auth refresh that
      // silently fails, say - used to recurse until the process ran out of stack or memory.
      throw await this.toRequestError(
        `afterResponse retried the request more than ${maxAfterResponseRetries} times`,
        'ERR_TOO_MANY_RETRIES',
        undefined,
        options,
      );
    }

    /*
     * `mergeOptions`, not a plain spread - the third job `formOptions` does that this route has to
     * do for itself, alongside the validation above and the method folding below.
     *
     * A key present with the value `undefined` wins a spread, and that is the shape a refresh hook
     * writes constantly: `retry({headers, method: req.method, throwHttpErrors: cfg.throwHttpErrors})`
     * forwarded from somewhere those can be absent. Measured, before this: `retry({method:
     * undefined})` replayed a POST as a **GET**, `retry({throwHttpErrors: undefined})` resolved the
     * 401 that triggered the retry as a success, and `retry({responseType: undefined})` fell past
     * the `json`/`text` arms and handed back a `Buffer` while still sending `accept:
     * application/json`. got skips `undefined` when it merges (`Options.merge`, which is what its
     * own `retryWithMergedOptions` goes through), and so does every other route into `call()` here.
     */
    const merged = mergeOptions(options, newOptions);

    // Always a fresh object, even when the hook passed no headers of its own. Aliasing the first
    // attempt's headers meant `call()`'s own writes - a `content-type` for a body the retry added -
    // landed on the options the *first* response reports having been sent with. The first attempt's
    // names may carry whatever case a hook or handler wrote, so normalise both sides: a refreshed
    // `authorization` has to replace the stale one.
    merged.headers = mergeHeaders(lowercaseHeaders(options.headers), newOptions.headers);

    /*
     * Folded here for the same reason `formOptions` folds it: the wire wants an upper-case
     * method, and `isBodyMethod`/`hasNoBody` match on one. A hook writing `retry({method:
     * 'post'})` - which is ordinary, and which got normalises - put the literal `post` on the
     * request line and the server answered 400, surfaced as an `HTTPError` naming a method the
     * caller never typed in that case.
     */
    if (newOptions.method !== undefined) {
      merged.method = normaliseMethod(newOptions.method);
    }

    // Every header this function drops asks the same question first - did the hook name it
    // itself? A header the hook set is the hook saying what the retry should carry, and wins
    // over anything inherited from the first attempt. It was spelled out six times, which is
    // six places to write `||` where `&&` was meant and silently keep a stale credential.
    const hookSet = (name: string): boolean => newOptions.headers !== undefined && hasHeader(newOptions.headers, name);

    /*
     * A `url` the hook supplies brings its own query, and the first attempt's `searchParams` do
     * not come with it. They used to: `call()` lays `searchParams` over whatever query the url
     * carries, so a refresh hook doing `retry({url: 'https://h/p?token=new'})` after a call made
     * with `searchParams: {a: 1}` put `/p?a=1` on the wire - the new token silently dropped, the
     * refresh failing with the same 401 it was meant to fix. got's `searchParams` is a view of the
     * url's own, so a new url replaces it outright (measured against got 16: `/p?token=new`, and a
     * new url with no query sends none). Only the hook's own `searchParams`, if it named any, go
     * over the new url.
     */
    if (newOptions.url !== undefined) {
      merged.searchParams = cloneSearchParams(newOptions.searchParams);
    } else if (options.searchParams !== undefined && newOptions.searchParams !== undefined) {
      // A retry is a merge like any other, so a query the hook adds joins the one the request
      // already carried instead of erasing it.
      merged.searchParams = mergeSearchParams(options.searchParams, newOptions.searchParams);
    } else if (merged.searchParams !== undefined) {
      // One-sided, so the spread aliased the first attempt's query or the hook's own object.
      // The same rule `formOptions` applies, and free here - this runs once per refresh.
      merged.searchParams = cloneSearchParams(merged.searchParams);
    }

    if (newOptions.timeout !== undefined && newOptions.timeout.request === undefined && options.timeout !== undefined) {
      merged.timeout = options.timeout;
    }

    // Never the first attempt's object, for the reason `headers` and `context` are reallocated
    // below: a hook adjusting the retry's deadline must not change what the first response
    // reports having been sent with.
    if (merged.timeout !== undefined) {
      merged.timeout = {...merged.timeout};
    }

    /*
     * `call()` only derives a Basic-auth header when none is present yet, so new credentials on
     * a retry were silently ignored whenever the first attempt had already set one from its own
     * - the stale header survived the merge above and `hasHeader` then read it as "already
     * set". Cleared unless the hook set its own `authorization` explicitly, which wins as it
     * does everywhere else.
     *
     * A `url` carrying userinfo counts as new credentials, not just explicit
     * `username`/`password`: rotating them by retrying with `http://user2:pass2@host/` is the
     * same intent by the other route, and the first attempt's credentials went out instead.
     * Only for a client that parses userinfo at all - with `parseUserinfo: false` nothing would
     * re-derive the header and the retry would go out anonymous. Measured against got 16: a
     * new url's credentials are used, while a new url *without* any keeps the previous ones,
     * which is what leaving the header in place gives here. `http://@host/` carries none, so
     * it counts as a url without any rather than as a rotation to nothing.
     *
     * An explicit `username`/`password` is tested for presence rather than for credentials,
     * because `retry({username: ''})` *is* an instruction: got sends no header for an empty
     * username, so the stale one has to go and the retry goes out anonymous.
     */
    const retryUserinfo =
      // `String`, as `resolveUrl` does: a `URL` keeps its userinfo in `href`.
      this.parseUserinfo && newOptions.url !== undefined ? splitUserinfo(String(newOptions.url)) : undefined;

    if (
      (newOptions.username !== undefined ||
        newOptions.password !== undefined ||
        hasCredentials(retryUserinfo?.username, retryUserinfo?.password)) &&
      !hookSet('authorization')
    ) {
      delete merged.headers['authorization'];
    }

    /*
     * A hook that supplies a body replaces the first attempt's, rather than merging with it.
     * `call()` resolves `json` -> `form` -> `body` in that order, so without this the first
     * attempt's `json` outranked a `body` or `form` the hook had just set and was sent again
     * unchanged - the hook's body silently never left the process. `formOptions` applies the
     * same mutual exclusion to the client defaults; this is the same rule for the same reason.
     */
    if (newOptions.json !== undefined || newOptions.body !== undefined || newOptions.form !== undefined) {
      if (newOptions.json === undefined) {
        merged.json = undefined;
      }

      if (newOptions.body === undefined) {
        merged.body = undefined;
      }

      if (newOptions.form === undefined) {
        merged.form = undefined;
      }

      // The first attempt's `content-type` described the body being replaced, and `call()`
      // only sets one when none is present - so a json-then-form retry went out as a form
      // body labelled `application/json`. Dropped unless the hook named one itself.
      if (!hookSet('content-type')) {
        delete merged.headers['content-type'];
      }

      // `content-length` describes the replaced body just as `content-type` does, and an
      // explicit one set for the first attempt survived the merge. undici validates a
      // caller-supplied `content-length` against the body it is about to send
      // (`strictContentLength`, on by default) and fails the dispatch outright, so a retry
      // with a body of a different length died as an opaque `ERR_REQUEST_ERROR` whose real
      // cause was a header left over from the previous attempt. Dropping it lets undici
      // derive the length from the new body, which is what it does for every request that
      // does not name one.
      if (!hookSet('content-length')) {
        delete merged.headers['content-length'];
      }
    }

    /*
     * A retry that names another origin is the same boundary a `beforeRequest` hook can cross,
     * and the same rule applies: the credentials and the body belong to the origin the request
     * started at. A refresh hook pointing at a new host gets a clean request, and anything it
     * sets explicitly - new `authorization`, a new body - is kept, because it set those knowing
     * where they were going.
     *
     * `username`/`password` go with them, or `call()` would simply derive the same
     * `authorization` back from the first attempt's credentials and undo the strip. Userinfo on
     * the *new* url is not touched: those are credentials for the new origin, and got uses them
     * too.
     *
     * Resolve relative urls before judging them. A retry may replace `prefixUrl`, or an
     * absolute first request may have bypassed the client's prefix entirely; in both cases a
     * relative retry can cross an origin even though the path itself contains no authority.
     */
    const retryPrefixUrl =
      newOptions.url === undefined
        ? undefined
        : (newOptions.prefixUrl ?? options.prefixUrl ?? this.baseOptions.prefixUrl);

    if (newOptions.url !== undefined) {
      const next = this.resolveUrl({...merged, url: newOptions.url, prefixUrl: retryPrefixUrl});

      if (!sameOrigin(String(options.url), next)) {
        for (const name of crossOriginHeaders) {
          if (!hookSet(name)) {
            delete merged.headers[name];
          }
        }

        if (newOptions.username === undefined) {
          merged.username = undefined;
        }

        if (newOptions.password === undefined) {
          merged.password = undefined;
        }

        if (newOptions.json === undefined && newOptions.body === undefined && newOptions.form === undefined) {
          merged.body = undefined;
          merged.json = undefined;
          merged.form = undefined;

          if (!hookSet('content-type')) {
            delete merged.headers['content-type'];
          }

          if (!hookSet('content-length')) {
            delete merged.headers['content-length'];
          }
        }
      }
    }

    // Always a fresh object, for the same reason `headers` is: without it the retry shares
    // the first attempt's context, so a hook writing to `options.context` on the retry
    // changed what the first response reports having been sent with.
    merged.context = {...options.context, ...newOptions.context};

    if (newOptions.url === undefined) {
      // `url` was already resolved against `prefixUrl` for the first attempt.
      merged.prefixUrl = undefined;
    } else {
      // A url the hook supplied has not been resolved yet, so the prefix has to come back or a
      // relative path is dispatched as-is and fails as an invalid url. An absolute one ignores
      // the prefix anyway, so this is safe either way.
      merged.prefixUrl = retryPrefixUrl;
    }
    (merged as RetryDepth)[retryDepth] = depth;

    if (hookIndex === undefined) {
      // Called directly rather than handed to a hook, so there is no hook to cut the array at
      // and the retry runs the hooks it normally would. The spread may have carried a limit in
      // from an earlier retry, so it has to be cleared rather than left.
      delete (merged as RetryDepth)[afterResponseLimit];
    } else {
      // The retried request runs the hooks *before* the one that retried, and stops there - so
      // a refresh hook doesn't see its own retry and earlier hooks don't fire twice over.
      (merged as RetryDepth)[afterResponseLimit] = hookIndex;
    }

    /*
     * got documents that calling `retryWithMergedOptions` triggers `beforeRetry` hooks, and
     * that the retried response's `retryCount` reflects it - neither happened here, because
     * this retry recurses straight into `call()` rather than through undici's retry
     * interceptor, which is the only other place `beforeRetry` fires and `retryCount` is
     * counted from. `error` is `undefined`: nothing here failed to get a response, a hook
     * chose to retry one it already had, which is exactly the shape `onResponseError`'s
     * counterpart on the network-retry path reports as "a status, not an error".
     */
    if (this.beforeRetryHooks) {
      for (const hook of this.beforeRetryHooks) {
        hook(undefined, triggerStatusCode, retryCount);
      }
    }

    const result = await this.call<T>(merged);

    /*
     * Retries the nested call made itself, plus everything behind the response that triggered
     * this one, plus this retry. `depth` used to stand in for the last two, and `depth` is the
     * *nesting* level rather than a count of anything: two hooks retrying in sequence both ran
     * at depth 1 and reported one retry between them, while a retry that nested inside another
     * reported three for two. Measured against the dispatches a `beforeRequest` hook counted.
     */
    result.retryCount += retryCount;

    return result;
  }

  /**
   * `defaults.options.merge()`. The merge itself is `extend()`'s, so the two cannot drift: this
   * builds the child `extend()` would and adopts the request-level state it derived - the merged
   * `baseOptions` and the folded `defaultHeaders`. Everything else a constructor derives comes
   * from an option `unmergeableDefaults` refuses, so it is already right on this client, and the
   * dispatcher is the same object (`extend()` passes it on). Nothing is added to the request
   * path: `formOptions` already reads both fields per request, and a merge only replaces them.
   */
  #mergeDefaults(options: DefaultsMergeOptions): void {
    if (!this.defaults.mutableDefaults) {
      invalid(
        '`defaults.options.merge()` needs a client built with `mutableDefaults: true` - got ignores the ' +
          'merge silently here, which leaves a refreshed token unused with nothing to say so',
      );
    }

    for (const key in options) {
      const reason = Object.hasOwn(options, key) ? unmergeableDefaults.get(key) : undefined;

      if (reason !== undefined && (options as Record<string, unknown>)[key] !== undefined) {
        invalid(`\`${key}\` cannot be merged into a client's defaults: it ${reason}`);
      }
    }

    const merged = this.extend(options);

    this.baseOptions = merged.baseOptions;
    this.defaultHeaders = merged.defaultHeaders;
  }

  extend<E extends RequestOptions>(options: E): Gotlike<MergeClientOptions<O, E>> {
    // Checked here as well as in the constructor, which sees the merged result: `timeout` and
    // `searchParams` are merged below, and merging a bad value into a well-formed one turns a
    // `ValidationError` into a silently wrong client.
    validateOptions(options, true);

    const base = this.baseOptions;

    /*
     * A new dispatcher only when the extension actually says something about the transport.
     *
     * The constructor re-evaluates the agent options against the *merged* options, so a client
     * built with any one of them - `connections`, `keepAliveTimeout`, `http2`, `dnsLookup`, ... -
     * got a brand new `undici.Agent`, and so a brand new connection pool, for every client
     * extended from it, however unrelated the extension. Parent and child then shared no
     * sockets, each held a pool of its own up to `connections`, and the discarded Agents were
     * never closed - so a service deriving a client per upstream (which is the pattern the
     * README recommends) multiplied its connections silently. An explicitly passed `agent` was
     * always inherited, so the two ways of configuring the transport disagreed with each other.
     *
     * Passed explicitly rather than left to the spread: `base` may already carry an inherited
     * `agent`, and a *later* extend that does name an agent option has to be able to drop it and
     * build the dispatcher its options describe.
     *
     * "Drop it" only ever means a dispatcher *this class built*, though. A dispatcher the caller
     * handed over cannot be rebuilt from `connections` and friends - there is no way to ask a
     * `ProxyAgent` or an `H2CClient` for a copy of itself with one option changed - so replacing
     * it with a plain `undici.Agent` was not a reconfiguration, it was throwing the transport
     * away: `extend({agent: new EnvHttpProxyAgent()}).extend({connections: 128})` sent every
     * request **direct, bypassing the proxy**, with no error and nothing on the wire to say so.
     * Both halves of that are straight out of the README. The combination is refused instead,
     * which is the same call this file makes everywhere an option would otherwise be quietly
     * dropped - and here the quiet outcome is traffic leaving by a route the caller ruled out.
     */
    const namesAgent = options.agent !== undefined;
    const namedAgentOption = agentOptions.find((key) => options[key] !== undefined);

    if (namedAgentOption !== undefined && !namesAgent && this.explicitAgent) {
      invalid(
        `\`${namedAgentOption}\` cannot be set on a client built with an explicit \`agent\` - it would ` +
          'replace that dispatcher. Pass a new `agent` configured the way you want instead.',
      );
    }

    const rebuildsAgent = namesAgent || namedAgentOption !== undefined;

    const childOptions: RequestOptions & {[inheritedAgent]?: true} = {
      // `mergeOptions` rather than a spread, so `extend({throwHttpErrors: undefined})` inherits
      // the parent's setting instead of turning it off. The keys below are merged explicitly
      // and are unaffected either way.
      ...mergeOptions(base, options),
      /*
       * The dispatcher below may be one that was *built from* the agent options this object also
       * carries, inherited from the parent - which `validateAgentChoice` would otherwise read as a
       * caller naming `agent` and `connections` in one breath. `validateOptions(options, true)` at
       * the top has already applied that rule to the extension itself, which is where the mistake
       * it exists for actually shows up.
       */
      [inheritedAgent]: true,
      agent: rebuildsAgent ? options.agent : this.ownAgent,
      // Case-insensitively, like the per-request merge: extending with `Authorization` must
      // replace an inherited `authorization` rather than leave the client sending both.
      headers: mergeHeaders(lowercaseHeaders(base?.headers), options.headers),
      context: mergeRecords(base?.context, options.context),
      // Merged, not replaced: `extend({retry: {limit: 5}})` used to drop the parent's
      // `statusCodes`/`methods` along with it, silently widening what got retried.
      retry: mergeRecords(base?.retry, options.retry),
      // The same reasoning for the same shape of mistake: `extend({timeout: {}})` dropped the
      // parent's deadline, and an extended client that named a query lost the parent's.
      timeout: mergeTimeout(base?.timeout, options.timeout),
      searchParams:
        base?.searchParams !== undefined && options.searchParams !== undefined
          ? mergeSearchParams(base.searchParams, options.searchParams)
          : // One-sided, so nothing merges the two - but it must still not hand back the
            // parent's or the caller's own object unchanged. See `cloneSearchParams`.
            cloneSearchParams(options.searchParams ?? base?.searchParams),
      // Handlers and hooks accumulate, so an extended client keeps the parent's.
      handlers: concatHooks(base?.handlers, options.handlers),
      hooks: mergeHooks(base?.hooks, options.hooks),
    };

    const child = new Gotlike<MergeClientOptions<O, E>>(childOptions as MergeClientOptions<O, E>);

    /*
     * The one thing the constructor cannot work out for itself. It sees an `agent` and concludes
     * the caller handed one over - true when `rebuildsAgent` put `options.agent` there, and false
     * for the inherit branch above, which passes the parent's dispatcher back in whether the
     * parent built it or was given it. Left uncorrected, one plain `extend({headers})` off a
     * `connections`-tuned client made every client below it look explicitly-agented, so the
     * refusal above would have fired on the `tuned.extend({connections: 4})` the README documents
     * as working.
     */
    if (!rebuildsAgent) {
      child.explicitAgent = this.explicitAgent;
    }

    return child;
  }

  /**
   * Request a `Duplex` instead of a parsed response.
   *
   * Unlike got's, this resolves to the stream rather than returning it synchronously - the
   * `beforeRequest` hooks are async, and awaiting them is worth more than the sync return.
   *
   * A getter rather than a plain method, because got hangs the verb helpers off it -
   * `got.stream.post(url, options)` - and those have to be bound to this client. Calling one
   * here used to be a `TypeError`, which is a hard stop for code migrating from got that
   * writes it the got way. Built once per client, on the first read.
   */
  get stream(): StreamClient {
    return (this.#stream ??= makeStreamClient(this));
  }

  get(options: RequestOptions & IsStream): Promise<GotlikeStream>;
  get(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  get(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  get(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  get(options: TextCall & BodyOnly): Promise<string>;
  get(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  get(options: BufferCall & BodyOnly): Promise<Buffer>;
  get<T>(options: RequestOptions & BodyOnly): Promise<T>;
  get<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  get(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeStream>;
  get(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  get(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  get(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  get(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  get(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  get(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  get<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  get<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  get(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'GET');
  }

  post(options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  post(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  post(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  post(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  post(options: TextCall & BodyOnly): Promise<string>;
  post(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  post(options: BufferCall & BodyOnly): Promise<Buffer>;
  post<T>(options: RequestOptions & BodyOnly): Promise<T>;
  post<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  post(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  post(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  post(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  post(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  post(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  post(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  post(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  post<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  post<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  post(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'POST');
  }

  delete(options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  delete(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  delete(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  delete(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  delete(options: TextCall & BodyOnly): Promise<string>;
  delete(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  delete(options: BufferCall & BodyOnly): Promise<Buffer>;
  delete<T>(options: RequestOptions & BodyOnly): Promise<T>;
  delete<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  delete(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  delete(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  delete(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  delete(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  delete(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  delete(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  delete(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  delete<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  delete<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  delete(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'DELETE');
  }

  /*
   * got has `got.head(url)`, and this had no such verb: HEAD was a supported method and
   * `hasNoBody()` already handled it, but the only way to reach it was
   * `client(url, {method: 'HEAD'})` - so a drop-in caller writing `client.head(url)` got a
   * TypeError. Found by the parity suite, which could not run its HEAD scenario at all.
   */
  head(options: RequestOptions & IsStream): Promise<GotlikeStream>;
  head(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  head(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  head(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  head(options: TextCall & BodyOnly): Promise<string>;
  head(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  head(options: BufferCall & BodyOnly): Promise<Buffer>;
  head<T>(options: RequestOptions & BodyOnly): Promise<T>;
  head<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  head(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeStream>;
  head(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  head(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  head(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  head(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  head(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  head(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  head<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  head<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  head(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'HEAD');
  }

  put(options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  put(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  put(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  put(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  put(options: TextCall & BodyOnly): Promise<string>;
  put(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  put(options: BufferCall & BodyOnly): Promise<Buffer>;
  put<T>(options: RequestOptions & BodyOnly): Promise<T>;
  put<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  put(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  put(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  put(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  put(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  put(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  put(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  put(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  put<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  put<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  put(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'PUT');
  }

  patch(options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  patch(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  patch(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  patch(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  patch(options: TextCall & BodyOnly): Promise<string>;
  patch(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  patch(options: BufferCall & BodyOnly): Promise<Buffer>;
  patch<T>(options: RequestOptions & BodyOnly): Promise<T>;
  patch<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  patch(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  patch(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  patch(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  patch(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  patch(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  patch(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  patch(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  patch<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  patch<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  patch(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'PATCH');
  }

  query(options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  query(options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  query(options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  query(options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  query(options: TextCall & BodyOnly): Promise<string>;
  query(options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  query(options: BufferCall & BodyOnly): Promise<Buffer>;
  query<T>(options: RequestOptions & BodyOnly): Promise<T>;
  query<T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  query(url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeUploadStream>;
  query(url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  query(url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  query(url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  query(url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  query(url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  query(url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  query<T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  query<T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  query(url: RequestInput, options?: RequestOptions): Promise<any> {
    return handleInput(this, url, options, 'QUERY');
  }
}

/**
 * A client that can also be called directly - `client(url, options)` - the way got's export
 * can, while keeping every method and field of the underlying `Gotlike`.
 */
export type CallableClient<O extends ClientOptions = ClientOptions> = Omit<Gotlike<O>, 'extend'> & {
  /* `client({url, ...})`, the options-only form got's export also accepts. */
  (options: RequestOptions & IsStream): Promise<GotlikeStream | GotlikeUploadStream>;
  (options: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  (options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  (options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  (options: TextCall & BodyOnly): Promise<string>;
  (options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  (options: BufferCall & BodyOnly): Promise<Buffer>;
  <T>(options: RequestOptions & BodyOnly): Promise<T>;
  <T>(options: RequestOptions): Promise<ClientResult<O, T>>;
  (url: string | URL, options: RequestOptions & IsStream): Promise<GotlikeStream | GotlikeUploadStream>;
  (url: string | URL, options?: InheritCall & WholeResponse): Promise<ClientResult<O, ClientBody<O>>>;
  (url: string | URL, options: InheritCall & BodyOnly): Promise<ClientBody<O>>;
  (url: string | URL, options: TextCall & WholeResponse): Promise<ClientResult<O, string>>;
  (url: string | URL, options: TextCall & BodyOnly): Promise<string>;
  (url: string | URL, options: BufferCall & WholeResponse): Promise<ClientResult<O, Buffer>>;
  (url: string | URL, options: BufferCall & BodyOnly): Promise<Buffer>;
  <T>(url: string | URL, options: RequestOptions & BodyOnly): Promise<T>;
  <T>(url: string | URL, options?: RequestOptions): Promise<ClientResult<O, T>>;
  /**
   * `Gotlike` is `Omit`ted of `extend` above on purpose: an intersection merges call
   * signatures into an overload set, and `Gotlike['extend']` would win and type an extended
   * client as a plain, non-callable `Gotlike`.
   */
  extend<E extends RequestOptions>(options: E): CallableClient<MergeClientOptions<O, E>>;
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
function asCallable<O extends ClientOptions>(instance: Gotlike<O>): CallableClient<O> {
  // `client({url: ...})` as well as `client(url, options)` - got's export takes both, and so do
  // the verbs. See `handleInput`, which is the one place that tells the two apart.
  const callable = function callableClient(urlOrOptions: RequestInput, options?: RequestOptions) {
    return handleInput(instance, urlOrOptions, options);
  } as unknown as CallableClient<O>;

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

  // An extended client stays callable, and carries the merged options in its type.
  callable.extend = <E extends RequestOptions>(options: E) => asCallable(instance.extend<E>(options));

  return callable;
}

/** Create a callable client. `new Gotlike(options)` gives the plain, non-callable form. */
export function createClient<O extends ClientOptions = ClientOptions>(options?: O): CallableClient<O> {
  return asCallable(new Gotlike<O>(options));
}

/**
 * One instance behind all three names, as got does. Three separate clients would each carry
 * their own headers and interceptor chain, and `got !== gotlike` would be a surprise for
 * anyone configuring or comparing them.
 *
 * No options: `defaultOptions` is applied by the constructor now, so this client and a
 * hand-built `new Gotlike(...)` start from exactly the same place.
 */
const defaultClient = createClient();

export default defaultClient;

export const gotlike = defaultClient;

// For easier replacement
export const got = defaultClient;
export type Got = CallableClient;
export type ExtendOptions = RequestOptions;

// Re-exports got's source so tests reaching for internals gotlike lacks still load, then
// shadows everything gotlike provides. A local export wins over a star export.
import {Duplex} from 'node:stream';
import gotlike, {
  RequestError,
  HTTPError,
  TimeoutError,
  ParseError,
  AbortError,
  ReadError,
  MaxRedirectsError,
} from 'gotlike';

export * from './index.js';

type AnyClient = any;
type Options = Record<string, any>;

// README "Chosen for speed": these are create/extend only. A migrating caller moves them onto
// an `extend()`, so that is what the adapter does.
const clientOnly = new Set([
  'hooks',
  'handlers',
  'retry',
  'agent',
  'http2',
  'pipelining',
  'dnsCache',
  'dnsLookup',
  'decompress',
  'cache',
  'dedupe',
  'connections',
  'keepAliveTimeout',
  'keepAliveMaxTimeout',
  'connectTimeout',
]);

function split(options: Options | undefined): [Options | undefined, Options | undefined] {
  if (!options || typeof options !== 'object' || options instanceof URL) {
    return [undefined, options];
  }

  let client: Options | undefined;
  let request: Options | undefined;
  for (const key of Object.keys(options)) {
    const value = options[key];
    const toClient = clientOnly.has(key) || (key === 'followRedirect' && value === true);
    if (toClient) {
      (client ??= {})[key] = value;
    } else {
      (request ??= {})[key] = value;
    }
  }

  if (client && !request) {
    request = {};
  }

  return [client, request ?? options];
}

// got's `next()` inside a handler returns its event-emitting promise or stream; gotlike's is a
// plain promise. Handlers that subscribe to it would crash the whole test file, so `next`'s
// result gets inert `on`/`once` - the events simply never arrive, and the test fails on that.
function inertEvents(value: any): any {
  if (value && typeof value === 'object' && typeof value.on !== 'function') {
    value.on = () => value;
    value.once = () => value;
  }

  return value;
}

// got's `retry: 0` shorthand, and handlers whose `next()` result gets subscribed to.
function normaliseRetry(options: Options): Options {
  let result = options;
  if (typeof options.retry === 'number') {
    result = {...result, retry: {limit: options.retry}};
  }

  if (Array.isArray(options.handlers)) {
    result = {
      ...result,
      handlers: options.handlers.map((handler: any) =>
        typeof handler === 'function' ? (o: any, next: any) => handler(o, (x: any) => inertEvents(next(x))) : handler,
      ),
    };
  }

  return result;
}

function route(client: AnyClient, input: any, options: Options | undefined): [AnyClient, any, Options | undefined] {
  let target = client;
  if (input && typeof input === 'object' && !(input instanceof URL)) {
    const [c, r] = split(normaliseRetry(input));
    if (c) {
      target = target.extend(c);
    }

    input = r;
  }

  if (options) {
    const [c, r] = split(normaliseRetry(options));
    if (c) {
      target = target.extend(c);
    }

    options = r;
  }

  return [target, input, options];
}

function endReal(stream: any, callback: (error?: Error | null) => void): void {
  if (typeof stream.end !== 'function') {
    callback();

    return;
  }

  stream.once('finish', () => callback());
  stream.once('error', (error: Error) => callback(error));
  stream.end();
}

const forwarded = ['response', 'redirect', 'retry', 'uploadProgress', 'downloadProgress', 'request'];

// got's `got.stream()` returns the stream synchronously; gotlike's resolves to it (README
// "Smaller surface"). A migrating caller awaits it - here a Duplex stands in until it arrives.
function syncStream(open: () => Promise<any>): Duplex {
  let real: any;
  let pendingRead = false;
  const writes: Array<[any, BufferEncoding, (error?: Error | null) => void]> = [];
  let ended: (() => void) | undefined;

  const proxy: any = new Duplex({
    read() {
      if (real) {
        real.resume();
      } else {
        pendingRead = true;
      }
    },
    write(chunk, encoding, callback) {
      if (real) {
        real.write(chunk, encoding, callback);
      } else {
        writes.push([chunk, encoding, callback]);
      }
    },
    // Finishes when the real stream does, so a `pipeline()` into the stand-in fails - rather than
    // resolving - when the real upload fails after its body was written.
    final(callback) {
      if (real) {
        endReal(real, callback);
      } else {
        ended = callback;
      }
    },
    destroy(error, callback) {
      real?.destroy(error ?? undefined);
      callback(error);
    },
  });

  // An error nobody listens for is an uncaught exception, which takes the rest of the test file
  // down with it. The test that caused it fails on its own (a missing 'end', a timeout); the
  // others still get to run.
  const fail = (error: Error) => {
    if (proxy.listenerCount('error') > 0) {
      proxy.destroy(error);
    } else {
      proxy.destroy();
    }
  };

  // A validation error thrown synchronously is an `error` event on got's stream.
  Promise.resolve()
    .then(open)
    .then((stream) => {
      real = stream;
      for (const event of forwarded) {
        stream.on(event, (...args: any[]) => proxy.emit(event, ...args));
      }

      stream.on('data', (chunk: any) => {
        if (!proxy.push(chunk)) {
          stream.pause();
        }
      });
      stream.on('end', () => proxy.push(null));
      stream.on('error', fail);
      for (const [chunk, encoding, callback] of writes) {
        stream.write(chunk, encoding, callback);
      }

      if (ended) {
        endReal(stream, ended);
      }

      if (!pendingRead) {
        stream.pause();
      }
    }, fail);

  return proxy;
}

function wrap(client: AnyClient): any {
  const call = (method: string | undefined) => (input?: any, options?: Options) => {
    const isStream = (options?.isStream ?? input?.isStream) === true;
    const [target, i, o] = route(client, input, options);
    const invoke = () => (method === undefined ? target(i, o) : target[method](i, o));

    if (isStream) {
      return syncStream(invoke);
    }

    // gotlike's promise carries got's `.json()`/`.text()`/`.buffer()` itself. It is marked as
    // handled: got throws a bad call synchronously, where gotlike rejects - and a test that
    // expects the throw never awaits the promise, whose rejection would then crash the file.
    const promise = invoke();
    promise.catch(() => undefined);

    return promise;
  };

  const streamCall = (method?: string) => (input?: any, options?: Options) => {
    const [target, i, o] = route(client, input, options);
    return syncStream(() => (method ? target.stream[method](i, o) : target.stream(i, o)));
  };

  const wrapped: any = call(undefined);
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'query', 'options']) {
    wrapped[verb] = call(verb);
  }

  wrapped.stream = streamCall();
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'query', 'options']) {
    wrapped.stream[verb] = streamCall(verb);
  }

  // got's `extend(...optionsOrInstances)`. Options fold left, as got merges them.
  wrapped.extend = (...all: Options[]) => {
    let next = client;
    for (const options of all) {
      next = next.extend(normaliseRetry(options ?? {}));
    }

    return wrap(next);
  };

  return new Proxy(wrapped, {
    get(target, key) {
      return key in target ? target[key] : client[key];
    },
    set(_target, key, value) {
      client[key] = value;
      return true;
    },
  });
}

// got's own defaults where gotlike's differ on purpose (README): two retries, and redirects
// followed.
const got = wrap(gotlike.extend({retry: {}, followRedirect: true}));

export default got;
export {got, RequestError, HTTPError, TimeoutError, ParseError, AbortError, ReadError, MaxRedirectsError};

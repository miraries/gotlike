import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import zlib from 'node:zlib';
import {clearInterval} from 'node:timers';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {text} from 'node:stream/consumers';
import {randomUUID} from 'node:crypto';
import {Agent, Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher} from 'undici';
import nock from './nock.ts';
import client, {
  AbortError,
  createClient,
  type HandlerFunction,
  Gotlike,
  HTTPError,
  ParseError,
  RequestError,
  type Response as GotlikeResponse,
  TimeoutError,
  ValidationError,
} from './index.ts';

/**
 * Await something expected to fail and hand back the error.
 *
 * `promise.catch(e => e as RequestError)` types as `Response | RequestError`, and quietly
 * yields a `Response` when the request doesn't fail at all - so a test that stops failing
 * fails confusingly instead of clearly.
 */
async function failure<E extends Error = RequestError>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }

  throw new assert.AssertionError({message: 'expected the request to fail, but it resolved'});
}

const requestCounts: Record<string, number> = {};

const serverState: {retryCounts: Record<string, number>} = {
  retryCounts: {
    default: 0,
  },
};

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/json') {
    res.write('{"test": "value"}\n');
    res.end();

    return;
  }

  if (req.url === '/trickle') {
    // A byte every 250ms for 3s: each gap is short enough that undici's per-chunk
    // `bodyTimeout` never fires, so only a total-request deadline can cut this off.
    res.writeHead(200, {'content-type': 'text/plain'});

    let written = 0;
    const ticker = setInterval(() => {
      if (written++ >= 12) {
        clearInterval(ticker);
        res.end();

        return;
      }

      res.write('x');
    }, 250);

    ticker.unref();
    res.on('close', () => clearInterval(ticker));

    return;
  }

  if (req.url === '/timeout') {
    // Longer than undici's ~1s timer floor (see the timeout tests), and unref'd so a
    // pending delay can't hold the event loop open after the suite finishes.
    setTimeout(() => {
      res.write('hello\n');
      res.end();
    }, 3000).unref();

    return;
  }

  if (req.url === '/stream') {
    let i = 0;

    const interval = setInterval(() => {
      res.write('hello\n');

      if (++i >= 3) {
        clearInterval(interval);

        res.end();
      }
    }, 50);

    return;
  }

  // Announces a body far longer than it sends, then kills the socket: the response head
  // arrives fine and the failure only shows up part-way through reading. A truncated
  // download is the realistic version of this, and it used to surface undici's raw
  // `SocketError` on both stream paths.
  if (req.url === '/truncate') {
    res.writeHead(200, {'content-length': '1000', 'content-type': 'text/plain'});
    res.write('partial');

    setTimeout(() => res.socket?.destroy(), 50);

    return;
  }

  // Mimics the provider auth flow the afterResponse token-refresh hooks exist for:
  // 401 with a JSON body until a bearer token shows up.
  if (req.url === '/unauthorized') {
    if (req.headers.authorization) {
      res.write(JSON.stringify({authorization: req.headers.authorization}));
      res.end();

      return;
    }

    res.statusCode = 401;
    res.statusMessage = 'Unauthorized';
    res.write(JSON.stringify({error: 'token expired'}));
    res.end();

    return;
  }

  requestCounts[req.url ?? ''] = (requestCounts[req.url ?? ''] ?? 0) + 1;

  if (req.url === '/counted') {
    // Slow enough that concurrent requests overlap, so dedupe has something to collapse.
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({count: requestCounts['/counted']}));
    }, 20);

    return;
  }

  if (req.url === '/cacheable') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=60');
    res.end(JSON.stringify({count: requestCounts['/cacheable']}));

    return;
  }

  if (req.url?.startsWith('/status-empty')) {
    res.statusCode = Number(new URL(req.url, 'http://x').searchParams.get('code') ?? 204);
    res.end();

    return;
  }

  if (req.url === '/slow') {
    setTimeout(() => res.end('slow'), 3000).unref();

    return;
  }

  if (req.url === '/gzip') {
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('content-type', 'application/json');
    res.end(zlib.gzipSync(JSON.stringify({compressed: true})));

    return;
  }

  if (req.url === '/gzip-error') {
    res.statusCode = 400;
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('content-type', 'application/json');
    res.end(zlib.gzipSync(JSON.stringify({error: 'OP_ERROR_INVALID_TOKEN'})));

    return;
  }

  if (req.url === '/brotli') {
    res.setHeader('content-encoding', 'br');
    res.end(zlib.brotliCompressSync('brotli body'));

    return;
  }

  if (req.url === '/png') {
    // PNG magic bytes - enough to prove we hand back real binary
    res.setHeader('content-type', 'image/png');
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    return;
  }

  // Echoes back what the request actually looked like on the wire.
  if (req.url?.startsWith('/echo')) {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });

    return;
  }

  if (req.url === '/headers') {
    res.write(JSON.stringify(req.headers));
    res.end();

    return;
  }

  /*
   * An error status whose body is not the json the caller asked for - a proxy's HTML error
   * page in front of an API, which is what makes this worth a route of its own.
   */
  if (req.url?.startsWith('/html-error')) {
    const qs = new URL(req.url, 'http://' + req.headers.host).searchParams;

    res.statusCode = Number(qs.get('code') ?? 500);
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>Gateway problem</body></html>');

    return;
  }

  if (req.url?.startsWith('/status')) {
    const qs = new URL(req.url, 'http://' + req.headers.host).searchParams;
    res.statusCode = Number(qs.get('code') ?? 200);
    res.statusMessage = qs.get('message') ?? 'OK';

    res.end();

    return;
  }

  if (req.url?.startsWith('/redirect-chain') && !req.url.startsWith('/redirect-chain-2')) {
    res.statusCode = 302;
    res.setHeader('location', '/redirect-chain-2');
    res.end();

    return;
  }

  if (req.url === '/redirect-chain-2') {
    res.statusCode = 301;
    res.setHeader('location', '/echo');
    res.end();

    return;
  }

  // Sends the browser to a different origin, which is when undici strips `authorization`.
  // 307 preserves both method and body, so the body would have to be replayed.
  if (req.url === '/redirect-307') {
    res.statusCode = 307;
    res.setHeader('location', '/echo');
    res.end();

    return;
  }

  if (req.url === '/redirect-cross-origin') {
    res.statusCode = 302;
    res.setHeader('location', 'http://127.0.0.1:3000/echo');
    res.end();

    return;
  }

  /*
   * A redirect chain of arbitrary length: `/hop/0` walks up to `/hop/20`, which answers 200.
   * Starting below `20 - maxRedirections` is how a chain undici gives up on is provoked.
   */
  if (req.url?.startsWith('/hop/')) {
    const hop = Number(req.url.slice('/hop/'.length));

    if (hop < 20) {
      res.statusCode = 302;
      res.setHeader('location', `/hop/${hop + 1}`);
      res.end('redirecting');

      return;
    }

    res.statusCode = 200;
    res.end('arrived');

    return;
  }

  if (req.url === '/redirect') {
    res.statusCode = 302;
    res.statusMessage = 'Found';
    res.setHeader('Location', '/json');

    res.end();

    return;
  }

  // Lands on `/headers`, so a test can see what the request headers looked like after a hop.
  if (req.url === '/redirect-headers') {
    res.statusCode = 302;
    res.setHeader('Location', '/headers');

    res.end();

    return;
  }

  if (req.url === '/retry-after') {
    // Always fails, and always asks for a 2s wait. A client that honours `Retry-After`
    // cannot get through its retries quickly; one that ignores it races through them.
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = (serverState.retryCounts[testId] ?? 0) + 1;

    res.statusCode = 429;
    res.setHeader('retry-after', '2');
    res.end();

    return;
  }

  /*
   * A redirect chain in front of a status that gets retried, which is the shape that made a
   * retry look like one more redirect hop. `test-id` survives the same-origin redirect, so
   * the counter downstream is still per test.
   */
  if (req.url === '/redirect-flaky') {
    res.statusCode = 302;
    res.setHeader('location', '/flaky-target');
    res.end();

    return;
  }

  if (req.url === '/flaky-target') {
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = serverState.retryCounts[testId] ? serverState.retryCounts[testId] + 1 : 1;

    if (serverState.retryCounts[testId] < 2) {
      res.statusCode = 503;
      res.end();

      return;
    }

    res.end('flaky ok');

    return;
  }

  /*
   * Redirects on its first hit and answers on its second, so the retried attempt reaches the
   * url that was requested rather than the first attempt's detour - which is what pins
   * `response.url` to the right one of the two.
   */
  if (req.url === '/flip') {
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = serverState.retryCounts[testId] ? serverState.retryCounts[testId] + 1 : 1;

    if (serverState.retryCounts[testId] < 2) {
      res.statusCode = 302;
      res.setHeader('location', '/flip-detour');
      res.end();

      return;
    }

    res.end('answered by flip');

    return;
  }

  if (req.url === '/flip-detour') {
    res.statusCode = 503;
    res.end();

    return;
  }

  // A redirect in front of `/echo`, so a test can tell a chain that was followed from one that
  // stopped at the 302 - and whether the body came with it.

  if (req.url === '/redirect-echo') {
    res.statusCode = 302;
    res.setHeader('Location', '/echo');

    res.end();

    return;
  }

  /*
   * Spends real time on every attempt before failing, which is what separates a per-attempt
   * deadline from a cumulative one: three attempts cost more than `timeout.request` allows for
   * one, so a client that retries only gets through them if the clock restarts each time.
   */
  if (req.url === '/slow-flaky') {
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = serverState.retryCounts[testId] ? serverState.retryCounts[testId] + 1 : 1;

    const attempt = serverState.retryCounts[testId];

    setTimeout(() => {
      if (attempt < 4) {
        res.statusCode = 503;
        res.end();

        return;
      }

      res.end('slow ok');
    }, 100);

    return;
  }

  /*
   * A 503, then a killed socket, then a success. The two retries have different reasons,
   * which is what `beforeRetry` has to report separately - the status of the attempt that
   * produced one used to survive onto the attempt that produced the other.
   */
  if (req.url === '/retry-reset') {
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = serverState.retryCounts[testId] ? serverState.retryCounts[testId] + 1 : 1;

    if (serverState.retryCounts[testId] === 1) {
      res.statusCode = 503;
      res.end();

      return;
    }

    if (serverState.retryCounts[testId] === 2) {
      req.socket.destroy();

      return;
    }

    res.end('ok');

    return;
  }

  if (req.url === '/retry') {
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = serverState.retryCounts[testId] ? serverState.retryCounts[testId] + 1 : 1;

    if (serverState.retryCounts[testId] < 3) {
      res.statusCode = 429;
      res.statusMessage = 'Too Many Requests';
    }

    res.end();

    return;
  }

  res.write('hello\n');
  res.end();
});

test.before(() => new Promise<void>((resolve) => server.listen(3000, resolve)));

test.after(() => {
  server.close();
});

test('returns valid json when responseType is json', async () => {
  const response = await client.get<{test: string}>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response.body.test, 'value');
});

test('returns error on parse failure', async () => {
  await assert.rejects(
    async () => {
      await client.get('http://localhost:3000/text', {
        responseType: 'json',
      });
    },
    {
      code: 'ERR_BODY_PARSE_FAILURE',
    },
  );
});

test('body is available as string on parse failure', async () => {
  const err = await failure(
    client.get('http://localhost:3000/text', {
      responseType: 'json',
    }),
  );

  assert.strictEqual(err.response?.body, 'hello\n');
});

test('throws error on timeout', async () => {
  await assert.rejects(
    async () => {
      await client.get('http://localhost:3000/timeout', {
        responseType: 'json',
        timeout: {
          request: 100,
        },
      });
    },
    {
      code: 'ETIMEDOUT',
    },
  );
});

/**
 * undici arms its own headers/body timeouts on a coarse timer wheel (lib/util/timers.js,
 * RESOLUTION_MS = 1000), which used to round every sub-second timeout up to roughly a
 * second. `timeout.request` is enforced by a deadline signal on top of those, so it fires
 * when it says it will.
 */
test("a sub-second timeout fires on time rather than at undici's one second floor", async () => {
  const start = process.hrtime.bigint();

  await assert.rejects(() => client.get('http://localhost:3000/timeout', {timeout: {request: 50}}), {
    code: 'ETIMEDOUT',
  });

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.ok(elapsedMs < 800, `expected the 50ms timeout to fire promptly, fired after ${elapsedMs}ms`);
});

/**
 * undici's `bodyTimeout` restarts on every chunk it receives, so a response that trickles
 * bytes slowly enough never trips it - `timeout.request` has to bound the whole request,
 * the way got's does.
 */
test('timeout.request bounds the whole request, not just the gap between chunks', async () => {
  const start = process.hrtime.bigint();

  const error = await failure(client.get('http://localhost:3000/trickle', {timeout: {request: 700}}));

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.strictEqual(error.code, 'ETIMEDOUT');

  // The route writes a byte every 250ms for 3s; each gap alone is well inside the timeout.
  assert.ok(elapsedMs < 1500, `expected the trickling body to be cut off, ran for ${elapsedMs}ms`);
});

/**
 * Count the deadline timers `timeout.request` arms, and how many are still pending.
 *
 * The deadline used to be an `AbortSignal.timeout`, which cannot be cancelled: an abandoned
 * one is retained until it fires, so a request that finished in 5ms under a 30s timeout held
 * ~885 bytes for the remaining 29995ms - ~265MB of uncollectable heap at 10k requests/second.
 * `process.getActiveResourcesInfo()` can't see this, because the timer is unref'd; patching
 * the global is what makes it observable. `delay` is distinctive so undici's own timers, which
 * go through the same global, can never be mistaken for the deadline.
 */
function countDeadlines(delay: number): {armed: () => number; pending: () => number; restore: () => void} {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const live = new Set<unknown>();
  let armed = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSetTimeout(callback, ms as number, ...rest);

    if (ms === delay) {
      live.add(handle);
      armed++;
    }

    return handle;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = (handle: Parameters<typeof globalThis.clearTimeout>[0]) => {
    live.delete(handle);

    return realClearTimeout(handle);
  };

  return {
    // Asserted alongside `pending`, so reverting to an uncancellable `AbortSignal.timeout` -
    // which arms no global timer at all - fails these tests instead of passing them vacuously.
    armed: () => armed,
    pending: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test('a settled request cancels its deadline rather than leaving it to expire', async () => {
  const delay = 28_731;
  const deadlines = countDeadlines(delay);

  try {
    const response = await client.get('http://localhost:3000/json', {timeout: {request: delay}});

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(deadlines.armed(), 1, 'the request should have armed a cancellable deadline');
    assert.strictEqual(deadlines.pending(), 0, 'the deadline should be cancelled once the body has been read');
  } finally {
    deadlines.restore();
  }
});

test('a failed request cancels its deadline too', async () => {
  const delay = 28_733;
  const deadlines = countDeadlines(delay);

  try {
    const error = await failure(client.get('http://127.0.0.1:1/', {timeout: {request: delay}}));

    assert.strictEqual(error.code, 'ECONNREFUSED');
    assert.strictEqual(deadlines.armed(), 1, 'the request should have armed a cancellable deadline');
    assert.strictEqual(deadlines.pending(), 0, 'a connection failure should cancel the deadline as well');
  } finally {
    deadlines.restore();
  }
});

test('a stream cancels its deadline when the stream closes, not when the head arrives', async () => {
  const delay = 28_737;
  const deadlines = countDeadlines(delay);

  try {
    const stream = await client.stream('http://localhost:3000/stream', {timeout: {request: delay}});

    await stream.response;

    // The body is exactly what the deadline still has to bound at this point: the head has
    // arrived, but a trickling or truncated body is what `timeout.request` is there to catch.
    assert.strictEqual(deadlines.armed(), 1, 'the stream should have armed a cancellable deadline');
    assert.strictEqual(deadlines.pending(), 1, 'the deadline must outlive the response head');

    await text(stream);

    assert.strictEqual(deadlines.pending(), 0, 'the deadline should be cancelled once the stream closes');
  } finally {
    deadlines.restore();
  }
});

test('a caller signal still aborts when a timeout is also set', async () => {
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 50);

  const error = await failure(
    client.get('http://localhost:3000/timeout', {timeout: {request: 10_000}, signal: controller.signal}),
  );

  assert.strictEqual(error.code, 'ERR_ABORTED');
  assert.strictEqual(error.name, 'AbortError');
});

test('does not time out a response that arrives within the timeout', async () => {
  const response = await client.get('http://localhost:3000/json', {
    responseType: 'json',
    timeout: {
      request: 5000,
    },
  });

  assert.strictEqual(response.statusCode, 200);
});

test('extend client with headers', async () => {
  const extClient = client.extend({
    headers: {
      foo: 'bar',
    },
  });

  const response = await extClient.get<{foo: string}>('http://localhost:3000/headers', {
    responseType: 'json',
  });

  assert.strictEqual(response.body.foo, 'bar');
});

test('extend client twice', async () => {
  const extClient = client
    .extend({
      headers: {
        foo: 'bar',
      },
    })
    .extend({
      responseType: 'text',
    });

  const response = await extClient.get('http://localhost:3000/headers');

  assert.ok(typeof response.body === 'string');
  assert.match(response.body, /"foo":"bar"/);
});

test('extend client with handler', async () => {
  const order: string[] = [];

  const handler1: HandlerFunction = (options, next) => {
    order.push('before request');

    options.headers = {
      test: 'value',
    };

    return next(options);
  };

  const handler2: HandlerFunction = async (options, next) => {
    const response = await next(options);

    order.push('after request');

    return response;
  };

  const extClient = client.extend({
    handlers: [handler1, handler2],
  });

  const response = await extClient.get('http://localhost:3000/json');

  order.push('after response');

  assert.deepStrictEqual(order, ['before request', 'after request', 'after response']);
  assert.strictEqual(response.statusCode, 200);
});

/*
 * `extend()` used to hand the child the parent's own `handlers` array, `hooks` object and
 * `context` whenever the child supplied none of its own - the merge helpers returned `base`
 * unchanged. Writing through the child's `baseOptions` then mutated the parent, and every
 * other client extended from it. All three run once per client, so copying is free.
 */
test('extend does not let a child share the parent’s handlers, hooks or context', () => {
  const parentHandler: HandlerFunction = (options, next) => next(options);
  const parentHook = () => undefined;

  const parent = new Gotlike({
    handlers: [parentHandler],
    hooks: {beforeRequest: [parentHook]},
    context: {tenant: 'parent'},
  });

  const child = parent.extend({});

  assert.notStrictEqual(child.baseOptions.handlers, parent.baseOptions.handlers);
  assert.notStrictEqual(child.baseOptions.hooks, parent.baseOptions.hooks);
  assert.notStrictEqual(child.baseOptions.hooks?.beforeRequest, parent.baseOptions.hooks?.beforeRequest);
  assert.notStrictEqual(child.baseOptions.context, parent.baseOptions.context);

  // ... and the contents still came across.
  assert.deepStrictEqual(child.baseOptions.handlers, [parentHandler]);
  assert.deepStrictEqual(child.baseOptions.hooks?.beforeRequest, [parentHook]);
  assert.deepStrictEqual(child.baseOptions.context, {tenant: 'parent'});

  child.baseOptions.handlers.push((options, next) => next(options));
  child.baseOptions.hooks.beforeRequest.push(() => undefined);
  child.baseOptions.context.tenant = 'child';

  assert.strictEqual(parent.baseOptions.handlers!.length, 1);
  assert.strictEqual(parent.baseOptions.hooks!.beforeRequest!.length, 1);
  assert.strictEqual(parent.baseOptions.context!.tenant, 'parent');
});

/*
 * The other direction of the same guarantee, and the likelier one to hit: extending a client
 * that has *no* hooks or handlers of its own - the default singleton included - took the
 * early return and handed the child the caller's own `hooks` object and arrays. Nothing
 * copies them after that (`usedHooks` doesn't), so the array passed to `extend()` stayed live
 * inside the client and a later `push` added a hook to a client that was already built.
 */
test('extend does not keep the caller’s own hooks or handlers live', async () => {
  const calls: string[] = [];
  const hooks = {beforeRequest: [() => void calls.push('first')]};
  const handlers: HandlerFunction[] = [(options, next) => next(options)];

  const child = client.extend({hooks, handlers});

  assert.notStrictEqual(child.baseOptions.hooks, hooks);
  assert.notStrictEqual(child.baseOptions.hooks?.beforeRequest, hooks.beforeRequest);
  assert.notStrictEqual(child.baseOptions.handlers, handlers);

  hooks.beforeRequest.push(() => void calls.push('added afterwards'));
  handlers.push((options, next) => next(options));

  await child.get('http://localhost:3000/json');

  assert.deepStrictEqual(calls, ['first']);
  assert.strictEqual(child.baseOptions.handlers!.length, 1);
});

/** The same, for a client built directly - which reached its hooks by a plain spread. */
test('a directly built client does not keep the caller’s own hooks live', async () => {
  const calls: string[] = [];
  const hooks = {beforeRequest: [() => void calls.push('first')]};

  const built = new Gotlike({hooks});

  assert.notStrictEqual(built.baseOptions.hooks, hooks);

  hooks.beforeRequest.push(() => void calls.push('added afterwards'));

  await built.get('http://localhost:3000/json');

  assert.deepStrictEqual(calls, ['first']);
});

test('extend client with hook', async () => {
  const extClient = client.extend({
    hooks: {
      afterResponse: [
        (response) => {
          if (response.headers) {
            response.headers['test'] = 'value';
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/json');

  assert.strictEqual(response.headers['test'], 'value');

  assert.strictEqual(response.statusCode, 200);
});

test('hooks run serially in array order', async () => {
  const order: string[] = [];

  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        async () => {
          order.push('before 1');
        },
        async () => {
          order.push('before 2');
        },
      ],
      afterResponse: [
        async (response) => {
          order.push('after 1');
          return response;
        },
        async (response) => {
          order.push('after 2');
          return response;
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');

  assert.deepStrictEqual(order, ['before 1', 'before 2', 'after 1', 'after 2']);
});

test("extend concatenates hooks with the parent client's", async () => {
  const order: string[] = [];

  const parent = client.extend({
    hooks: {
      beforeRequest: [
        () => {
          order.push('parent');
        },
      ],
    },
  });
  const child = parent.extend({
    hooks: {
      beforeRequest: [
        () => {
          order.push('child');
        },
      ],
    },
  });

  await child.get('http://localhost:3000/json');

  assert.deepStrictEqual(order, ['parent', 'child']);
});

test('beforeRequest can mutate headers and sees the resolved url and body', async () => {
  const seen: {url?: unknown; body?: unknown; method?: unknown} = {};

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          seen.url = options.url;
          seen.body = options.body;
          seen.method = options.method;
          options.headers['x-signature'] = 'signed';
        },
      ],
    },
  });

  const response = await extClient.post<Record<string, string>>('headers', {json: {a: 1}});

  assert.strictEqual(seen.url, 'http://localhost:3000/headers');
  assert.strictEqual(seen.body, '{"a":1}');
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(response.body['x-signature'], 'signed');
});

test('afterResponse sees error statuses before throwHttpErrors applies', async () => {
  let seenStatus: number | undefined;

  const extClient = client.extend({
    hooks: {
      afterResponse: [
        (response) => {
          seenStatus = response.statusCode;

          return response;
        },
      ],
    },
  });

  await assert.rejects(() => extClient.get('http://localhost:3000/status?code=401'), {code: 'ERR_HTTP_ERROR'});

  assert.strictEqual(seenStatus, 401);
});

test('afterResponse can retry with merged options', async () => {
  let attempts = 0;

  const extClient = client.extend({
    responseType: 'json',
    context: {brandId: 7},
    hooks: {
      afterResponse: [
        async (response, retryWithMergedOptions) => {
          attempts++;

          // The alreadyRetried flag is what stops this from looping - same shape the
          // aggregator's providers use.
          if (response.statusCode === 401 && !response.request.options.context.alreadyRetried) {
            assert.strictEqual(response.request.options.context.brandId, 7);

            return retryWithMergedOptions({
              headers: {authorization: 'Bearer refreshed'},
              context: {...response.request.options.context, alreadyRetried: true},
            });
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get<Record<string, string>>('http://localhost:3000/unauthorized');

  // Once, not twice: the hook that retried does not run again for the response its own retry
  // produced. got does the same - a lone retrying hook is called exactly once.
  assert.strictEqual(attempts, 1);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body['authorization'], 'Bearer refreshed');
  assert.strictEqual(response.request.options.context.alreadyRetried, true);
});

test('afterResponse retry keeps prefixUrl from being applied twice', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    hooks: {
      afterResponse: [
        async (response, retryWithMergedOptions) => {
          if (response.statusCode === 401) {
            return retryWithMergedOptions({headers: {authorization: 'Bearer refreshed'}});
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get<Record<string, string>>('unauthorized');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body['authorization'], 'Bearer refreshed');
});

test('afterResponse retry with new username/password replaces the stale Basic auth header', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        async (response, retryWithMergedOptions) => {
          if (response.request.options.context.refreshed) {
            return response;
          }

          return retryWithMergedOptions({
            username: 'newuser',
            password: 'newpass',
            context: {...response.request.options.context, refreshed: true},
          });
        },
      ],
    },
  });

  const response = await extClient.get<Record<string, string>>('http://localhost:3000/unauthorized', {
    username: 'olduser',
    password: 'oldpass',
  });

  const expected = 'Basic ' + Buffer.from('newuser:newpass').toString('base64');

  assert.strictEqual(response.body['authorization'], expected);
});

/*
 * Credentials written into the url are the other way to set Basic auth, and rotating them by
 * retrying with a new url hit the same stale-header problem `username`/`password` did: the
 * first attempt's derived `authorization` survived the merge, `call()` read a header that was
 * already there as "leave it alone", and the new credentials never left the process. Measured
 * against got 14, which sends the new url's credentials.
 */
test('afterResponse retry with credentials in a new url replaces the stale Basic auth header', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        async (_response, retryWithMergedOptions) =>
          retryWithMergedOptions({url: 'http://user2:pass2@localhost:3000/echo'}),
      ],
    },
  });

  const response = await extClient.get<Echo>('http://user1:pass1@localhost:3000/echo');

  assert.strictEqual(response.body.url, '/echo');
  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('user2:pass2').toString('base64'));
});

/*
 * ...but only for a client that parses userinfo at all. With `parseUserinfo: false` nothing
 * re-derives the header, so dropping it would send the retry anonymously - the credentials in
 * the hook's url are ignored there exactly as they are on a first request.
 */
test('afterResponse retry keeps its own authorization header with parseUserinfo false', async () => {
  const extClient = client.extend({
    responseType: 'json',
    parseUserinfo: false,
    hooks: {
      afterResponse: [
        async (_response, retryWithMergedOptions) =>
          retryWithMergedOptions({url: 'http://user2:pass2@localhost:3000/echo'}),
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/echo', {
    headers: {authorization: 'Bearer explicit'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer explicit');
});

test('beforeError can replace the thrown error', async () => {
  class TranslatedError extends Error {
    name = 'TranslatedError';
  }

  const extClient = client.extend({
    hooks: {
      beforeError: [(error) => new TranslatedError(`translated: ${error.code}`)],
    },
  });

  await assert.rejects(
    () => extClient.get('http://localhost:3000/status?code=500'),
    (err: Error) => {
      assert.ok(err instanceof TranslatedError);
      assert.strictEqual(err.message, 'translated: ERR_HTTP_ERROR');

      return true;
    },
  );
});

/**
 * Hooks are client-level. They used to be silently ignored when passed to a single call,
 * which is the kind of thing you only discover by wondering why nothing fired.
 */
test('hooks passed to a single call are rejected', async () => {
  await assert.rejects(
    () =>
      client.get('http://localhost:3000/json', {
        hooks: {beforeRequest: [() => undefined]},
      }),
    (err: Error) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /only be set when creating or extending/);

      return true;
    },
  );
});

test('extend client multiple times with headers', async () => {
  const extClient = client.extend({
    headers: {
      foo: 'bar',
    },
    responseType: 'text',
  });

  const extClient2 = extClient.extend({
    headers: {
      foo2: 'bar2',
    },
    responseType: 'json',
  });

  const response = await extClient2.get<{foo: string; foo2: string}>('http://localhost:3000/headers');

  assert.strictEqual(response.body.foo, 'bar');
  assert.strictEqual(response.body.foo2, 'bar2');
  assert.strictEqual(response.statusCode, 200);
});

test('extend client with headers on call', async () => {
  const extClient = client.extend({
    headers: {
      foo: 'bar',
    },
    responseType: 'json',
  });

  const response = await extClient.get<{foo: string; foo2: string}>('http://localhost:3000/headers', {
    headers: {
      foo2: 'bar2',
    },
  });

  assert.strictEqual(response.body.foo, 'bar');
  assert.strictEqual(response.body.foo2, 'bar2');
  assert.strictEqual(response.statusCode, 200);
});

/**
 * Header names are case-insensitive on the wire, so a per-call `Authorization` has to replace
 * an instance `authorization` rather than join it. Merging by exact key sent both, and the
 * server picked whichever came first - which was the stale one.
 */
test('a per-call header overrides an instance header of a different case', async () => {
  const extClient = client.extend({
    headers: {Authorization: 'Bearer OLD'},
    responseType: 'json',
  });

  const response = await extClient.get<Record<string, string>>('http://localhost:3000/headers', {
    headers: {authorization: 'Bearer NEW'},
  });

  assert.strictEqual(response.body.authorization, 'Bearer NEW');
});

/** `accept-encoding` is folded into the instance headers, so opting out per call has to win. */
test('a per-call accept-encoding replaces the one folded in at construction', async () => {
  const response = await client.get<Record<string, string>>('http://localhost:3000/headers', {
    responseType: 'json',
    headers: {'Accept-Encoding': 'identity'},
  });

  assert.strictEqual(response.body['accept-encoding'], 'identity');
});

test('extend merges headers case-insensitively too', async () => {
  const extClient = client
    .extend({headers: {'X-Token': 'old'}, responseType: 'json'})
    .extend({headers: {'x-token': 'new'}});

  const response = await extClient.get<Record<string, string>>('http://localhost:3000/headers');

  assert.strictEqual(response.body['x-token'], 'new');
});

/**
 * The refresh flow with the replacement header spelled differently from the one already on the
 * request. A handler runs once, before `call()`; the retry re-enters `call()` directly, so the
 * merge there is the only thing that can replace what the handler wrote.
 */
test('a retried request replaces a re-cased header rather than sending both', async () => {
  let refreshed = false;

  const setHeader: HandlerFunction = (options, next) => {
    options.headers['Authorization'] = 'Bearer OLD';

    return next(options);
  };

  const extClient = client.extend({
    handlers: [setHeader],
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (refreshed) {
            return response;
          }

          refreshed = true;

          return retryWithMergedOptions({headers: {authorization: 'Bearer REFRESHED'}});
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(response.body.headers.authorization, 'Bearer REFRESHED');
});

test('throw error on non-2xx if throwHttpErrors is true', async () => {
  await assert.rejects(
    async () => {
      await client.get('http://localhost:3000/status?code=403&message=Forbidden');
    },
    {
      code: 'ERR_HTTP_ERROR',
      message: 'Response code 403',
    },
  );
});

test("don't throw error on non-2xx if throwHttpErrors is false", async () => {
  const response = await client.get('http://localhost:3000/status?code=403&message=Forbidden', {
    throwHttpErrors: false,
  });

  assert.strictEqual(response.statusCode, 403);
});

test('prefixUrl is added before url', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
  });

  const response = await extClient.get('/json');

  assert.strictEqual(response.statusCode, 200);
});

test('followers redirects if followRedirect is true', async () => {
  const redirecting = client.extend({followRedirect: true, responseType: 'text'});

  const response = await redirecting.get('http://localhost:3000/redirect');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body, '{"test": "value"}\n');
});

test('followers redirects if followRedirect is false', async () => {
  const response = await client.get('http://localhost:3000/redirect', {
    followRedirect: false,
  });

  assert.strictEqual(response.statusCode, 302);
});

test('response has total request timing info', async () => {
  const response = await client.get('http://localhost:3000/json');

  assert.ok(response.timings.phases.total > 0 && response.timings.phases.total < 1000);
});

test('readable get stream', async () => {
  const duplex = await client.stream('http://localhost:3000/stream');

  const body = await text(duplex);

  assert.strictEqual(body, 'hello\n'.repeat(3));
});

test('stream exposes the response head as a promise', async () => {
  const duplex = await client.stream('http://localhost:3000/json');

  const head = await duplex.response;

  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(head.ok, true);
  assert.strictEqual(head.url, 'http://localhost:3000/json');
  assert.ok(typeof head.timings.phases.total === 'number');

  assert.strictEqual(await text(duplex), '{"test": "value"}\n');
});

test('stream emits a response event', async () => {
  const duplex = await client.stream('http://localhost:3000/headers');

  const head = await new Promise<any>((resolve) => duplex.once('response', resolve));

  assert.strictEqual(head.statusCode, 200);
  assert.ok(head.headers['content-type'] === undefined || typeof head.headers['content-type'] === 'string');

  await text(duplex);
});

test('stream works with pipeline into a writable', async () => {
  const duplex = await client.stream('http://localhost:3000/stream');

  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  await pipeline(duplex, sink);

  assert.strictEqual(Buffer.concat(chunks).toString(), 'hello\n'.repeat(3));
});

test('stream sends a body supplied through options', async () => {
  const duplex = await client.stream('http://localhost:3000/echo', {
    method: 'POST',
    json: {streamed: true},
  });

  const echo = JSON.parse(await text(duplex)) as Echo;

  assert.strictEqual(echo.method, 'POST');
  assert.strictEqual(echo.body, '{"streamed":true}');
  assert.strictEqual(echo.headers['content-type'], 'application/json');
});

/**
 * The writable half stays open when no body was supplied, so a request body can be piped
 * in. The old implementation only ever ended the duplex for GET, which left POSTs that
 * carried an options body hanging.
 */
test('stream accepts a request body written to the duplex', async () => {
  const duplex = await client.stream('http://localhost:3000/echo', {method: 'POST'});

  duplex.end('written-to-the-stream');

  const echo = JSON.parse(await text(duplex)) as Echo;

  assert.strictEqual(echo.body, 'written-to-the-stream');
});

test('stream errors on a non-2xx when throwHttpErrors is on', async () => {
  const duplex = await client.stream('http://localhost:3000/status?code=500');

  const err = await failure<Error>(text(duplex));

  assert.ok(err instanceof HTTPError, `expected an HTTPError, got ${err}`);
  assert.strictEqual(err.code, 'ERR_HTTP_ERROR');
});

test('stream does not error on a non-2xx when throwHttpErrors is off', async () => {
  const duplex = await client.stream('http://localhost:3000/status?code=404', {
    throwHttpErrors: false,
  });

  const head = await duplex.response;

  assert.strictEqual(head.statusCode, 404);
  assert.strictEqual(head.ok, false);

  await text(duplex);
});

test('stream response promise rejects when the request fails outright', async () => {
  const duplex = await client.stream('http://localhost:3999/nothing-listening');

  const err = await failure<Error>(duplex.response);

  assert.ok(err instanceof Error);

  // the same failure surfaces on the stream itself
  await text(duplex).catch(() => undefined);
});

test('stream runs handlers and beforeRequest hooks', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    handlers: [
      (options, next) => {
        seen.push('handler');

        return next(options);
      },
    ],
    hooks: {
      beforeRequest: [
        (options) => {
          seen.push('hook');
          options.headers['x-streamed'] = 'yes';
        },
      ],
    },
  });

  const duplex = await extClient.stream('http://localhost:3000/echo');
  const echo = JSON.parse(await text(duplex)) as Echo;

  assert.deepStrictEqual(seen, ['handler', 'hook']);
  assert.strictEqual(echo.headers['x-streamed'], 'yes');
});

test('retries on 429', async () => {
  const extClient = client.extend({
    headers: {
      'test-id': randomUUID(),
    },
    retry: {
      limit: 3,
      backoffLimit: 10,
    },
  });

  const response = await extClient.get('http://localhost:3000/retry');

  assert.strictEqual(response.statusCode, 200);
});

test('exhausted retries resolve to the last response', async () => {
  const extClient = client.extend({
    headers: {
      'test-id': randomUUID(),
    },
    retry: {
      limit: 1,
      backoffLimit: 10,
    },
    throwHttpErrors: false,
  });

  const response = await extClient.get('http://localhost:3000/retry');

  assert.strictEqual(response.statusCode, 429);
});

test('exhausted retries throw when throwHttpErrors is set', async () => {
  const extClient = client.extend({
    headers: {
      'test-id': randomUUID(),
    },
    retry: {
      limit: 1,
      backoffLimit: 10,
    },
  });

  await assert.rejects(() => extClient.get('http://localhost:3000/retry'), {code: 'ERR_HTTP_ERROR'});
});

test('retry limit of 0 disables retries', async () => {
  const extClient = client.extend({
    headers: {
      'test-id': randomUUID(),
    },
    retry: {
      limit: 0,
    },
    throwHttpErrors: false,
  });

  const response = await extClient.get('http://localhost:3000/retry');

  assert.strictEqual(response.statusCode, 429);
});

/**
 * The client used to capture `getGlobalDispatcher()` once at module load, so mocks only
 * applied if `./nock` happened to be imported before `./index`. The dispatcher is now
 * resolved per request (and the interceptor chain memoised per base dispatcher), so the
 * import order no longer matters.
 */
test('picks up a global dispatcher installed after the client was constructed', async () => {
  const freshClient = new Gotlike({responseType: 'text'});

  const previous = getGlobalDispatcher();
  const agent = new MockAgent();

  agent.get('http://localhost:3001').intercept({method: 'GET', path: '/late'}).reply(200, 'from the late dispatcher');

  setGlobalDispatcher(agent);

  try {
    const response = await freshClient.get('http://localhost:3001/late');

    assert.strictEqual(response.body, 'from the late dispatcher');
  } finally {
    setGlobalDispatcher(previous);
  }
});

test('http error carries the parsed body, timings and request options', async () => {
  const extClient = client.extend({
    responseType: 'json',
    context: {brandId: 3},
  });

  const err = await failure<RequestError>(extClient.get('http://localhost:3000/unauthorized'));

  assert.ok(err instanceof RequestError);
  assert.strictEqual(err.code, 'ERR_HTTP_ERROR');
  assert.strictEqual(err.response?.statusCode, 401);
  // The whole point: a parsed body, not a consumed BodyReadable.
  assert.deepStrictEqual(err.response?.body, {error: 'token expired'});
  assert.ok(typeof err.response?.timings.phases.total === 'number');
  assert.strictEqual(err.response?.request.options.context.brandId, 3);
  assert.strictEqual(err.options.url, 'http://localhost:3000/unauthorized');
});

test('parse failure error carries the raw body and preserves the cause', async () => {
  const err = await failure(
    client.get('http://localhost:3000/text', {
      responseType: 'json',
    }),
  );

  assert.strictEqual(err.code, 'ERR_BODY_PARSE_FAILURE');
  assert.strictEqual(err.response?.body, 'hello\n');
  assert.strictEqual(err.response?.statusCode, 200);
  assert.ok(err.cause instanceof SyntaxError);
});

test('timeout error preserves the underlying undici error as cause', async () => {
  const err = await failure<RequestError>(
    client.get('http://localhost:3000/timeout', {
      timeout: {request: 100},
    }),
  );

  assert.strictEqual(err.code, 'ETIMEDOUT');
  assert.strictEqual(err.cause instanceof Error, true);
  // The deadline signal is what bounds `timeout.request`, and it reports itself as a
  // `TimeoutError` DOMException.
  assert.strictEqual((err.cause as Error).name, 'TimeoutError');
  // Nothing was received, so there is no response to attach.
  assert.strictEqual(err.response, undefined);
});

test('connection error has no response and preserves the cause', async () => {
  const err = await failure<RequestError>(client.get('http://localhost:3999/nothing-listening'));

  assert.strictEqual(err.code, 'ECONNREFUSED');
  assert.strictEqual(err.response, undefined);
  assert.ok(err.cause instanceof Error);
});

test('does not mutate the options object it was given', async () => {
  const options = {responseType: 'json' as const};

  await client.get('http://localhost:3000/json', options);

  assert.deepStrictEqual(options, {responseType: 'json'});
});

test('prefixUrl joins without doubling slashes', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000/api',
    responseType: 'json',
  });

  for (const [prefix, path] of [
    ['http://localhost:3000/api', 'thing'],
    ['http://localhost:3000/api/', '/thing'],
    // Every leading slash, not just the first: `//thing` used to join as `/api//thing`,
    // which is exactly the doubled slash this is here to rule out.
    ['http://localhost:3000/api', '//thing'],
    ['http://localhost:3000/api/', '///thing'],
  ] as const) {
    const seen: string[] = [];
    const probe = client.extend({
      prefixUrl: prefix,
      responseType: 'json',
      hooks: {
        beforeRequest: [
          (options) => {
            seen.push(options.url as string);
          },
        ],
      },
    });

    await probe.get(path).catch(() => undefined);

    assert.strictEqual(seen[0], 'http://localhost:3000/api/thing');
  }

  // and the joined url actually resolves
  const response = await extClient.get('../json');

  assert.strictEqual(response.statusCode, 200);
});

test('an absolute url overrides prefixUrl instead of being appended to it', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000/api',
    responseType: 'json',
  });

  const response = await extClient.get<{test: string}>('http://localhost:3000/json');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.test, 'value');
  assert.strictEqual(response.request.options.url, 'http://localhost:3000/json');
});

test('context is shallow-merged over the instance context', async () => {
  const seen: Record<string, any>[] = [];

  const extClient = client.extend({
    context: {service: 'test', keep: true},
    hooks: {
      beforeRequest: [
        (options) => {
          seen.push(options.context);
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json', {context: {service: 'override'}});

  assert.deepStrictEqual(seen[0], {service: 'override', keep: true});
});

test('context reads as empty when none was set', async () => {
  const seen: Record<string, any>[] = [];

  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          seen.push(options.context);
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');

  assert.deepStrictEqual(seen[0], {});
  assert.strictEqual(seen[0].anything, undefined);
});

/**
 * The context handed to a request is always its own object. When only the instance carried
 * one, `formOptions` used to pass the instance's object straight through, so a hook writing
 * to it wrote into every later request.
 */
test('a hook writing to the context cannot leak into the next request', async () => {
  const seen: Record<string, any>[] = [];

  const extClient = client.extend({
    context: {tenant: 1},
    hooks: {
      beforeRequest: [
        (options) => {
          options.context.touched = (options.context.touched ?? 0) + 1;
          seen.push(options.context);
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');
  await extClient.get('http://localhost:3000/json');

  assert.deepStrictEqual(seen[0], {tenant: 1, touched: 1});
  assert.deepStrictEqual(seen[1], {tenant: 1, touched: 1});
  assert.notStrictEqual(seen[0], seen[1], 'each request should get its own context object');
  assert.deepStrictEqual(extClient.baseOptions?.context, {tenant: 1}, 'the client options should be untouched');
});

/** The same invariant from the other side: a caller's own object must not be written to. */
test('a per-call context object is not mutated by a hook', async () => {
  const context: Record<string, any> = {request: 1};

  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          options.context.touched = true;
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json', {context});

  assert.deepStrictEqual(context, {request: 1});
});

test('json sets a content-type unless the caller already did', async () => {
  const extClient = client.extend({responseType: 'json'});

  const auto = await extClient.post<Record<string, string>>('http://localhost:3000/headers', {
    json: {a: 1},
  });

  assert.strictEqual(auto.body['content-type'], 'application/json');

  const explicit = await extClient.post<Record<string, string>>('http://localhost:3000/headers', {
    json: {a: 1},
    headers: {'Content-Type': 'application/vnd.api+json'},
  });

  assert.strictEqual(explicit.body['content-type'], 'application/vnd.api+json');
});

type Echo = {url: string; method: string; headers: Record<string, string>; body: string};

test('gzip responses are decompressed', async () => {
  const response = await client.get<{compressed: boolean}>('http://localhost:3000/gzip', {
    responseType: 'json',
  });

  assert.deepStrictEqual(response.body, {compressed: true});
});

test('brotli responses are decompressed', async () => {
  const response = await client.get('http://localhost:3000/brotli');

  assert.strictEqual(response.body, 'brotli body');
});

test('accept-encoding is advertised, and overridable', async () => {
  const auto = await client.get<Echo>('http://localhost:3000/echo', {responseType: 'json'});

  // Built from what this runtime can decode, so the exact list depends on the node version.
  const advertised = (auto.body.headers['accept-encoding'] ?? '').split(', ');

  assert.ok(advertised.includes('gzip'));
  assert.ok(advertised.includes('deflate'));
  assert.ok(advertised.includes('br'));
  assert.ok(
    advertised.includes('zstd') === (typeof zlib.createZstdDecompress === 'function'),
    'zstd should be advertised only when this runtime can decompress it',
  );

  const explicit = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    headers: {'accept-encoding': 'identity'},
  });

  assert.strictEqual(explicit.body.headers['accept-encoding'], 'identity');
});

test('decompress false leaves the body compressed and sends no accept-encoding', async () => {
  const raw = new Gotlike({responseType: 'buffer', decompress: false});

  const response = await raw.get<Buffer>('http://localhost:3000/gzip');

  // still gzip on the wire: magic bytes 1f 8b
  assert.strictEqual(response.body[0], 0x1f);
  assert.strictEqual(response.body[1], 0x8b);
  assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(response.body).toString()), {compressed: true});
});

test('responseType buffer resolves to a real Buffer', async () => {
  const response = await client.get<Buffer>('http://localhost:3000/png', {responseType: 'buffer'});

  assert.ok(Buffer.isBuffer(response.body), 'expected a Node Buffer');
  assert.strictEqual(response.body.length, 8);
  assert.strictEqual(response.body.subarray(1, 4).toString(), 'PNG');
});

test('resolveBodyOnly with a buffer returns the Buffer itself', async () => {
  const body = await client.get<Buffer>('http://localhost:3000/png', {
    responseType: 'buffer',
    resolveBodyOnly: true,
  });

  assert.ok(Buffer.isBuffer(body));
});

test('searchParams accepts objects, strings and URLSearchParams', async () => {
  const cases: [NonNullable<Parameters<typeof client.get>[1]>['searchParams'], string][] = [
    [{a: '1', b: 2, c: true}, '/echo?a=1&b=2&c=true'],
    ['a=1&b=2', '/echo?a=1&b=2'],
    ['?a=1&b=2', '/echo?a=1&b=2'],
    [new URLSearchParams({a: '1'}), '/echo?a=1'],
  ];

  for (const [searchParams, expected] of cases) {
    const response = await client.get<Echo>('http://localhost:3000/echo', {
      responseType: 'json',
      searchParams,
    });

    assert.strictEqual(response.body.url, expected);
  }
});

test('searchParams drops null and undefined entries', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    searchParams: {keep: 'yes', drop: null, alsoDrop: undefined, zero: 0, empty: ''},
  });

  assert.strictEqual(response.body.url, '/echo?keep=yes&zero=0&empty=');
});

test('searchParams values are url-encoded', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    searchParams: {q: 'a b&c=d'},
  });

  assert.strictEqual(response.body.url, '/echo?q=a+b%26c%3Dd');
});

test('searchParams replaces a query already on the url', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo?old=1', {
    responseType: 'json',
    searchParams: {new: '2'},
  });

  assert.strictEqual(response.body.url, '/echo?new=2');
});

test('searchParams works with prefixUrl', async () => {
  const extClient = client.extend({prefixUrl: 'http://localhost:3000', responseType: 'json'});

  const response = await extClient.get<Echo>('echo', {searchParams: {a: '1'}});

  assert.strictEqual(response.body.url, '/echo?a=1');
});

/*
 * A fragment on the url used to swallow the query whole. `#` was never looked for, so the
 * params were appended *after* it - `/echo#frag` became `/echo#frag?a=1`, the fragment (which
 * is never sent) took the query with it, and the server saw a bare `/echo`. No error, no
 * warning; the request just quietly went out without its parameters.
 */
test('searchParams are not swallowed by a fragment on the url', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo#frag', {
    responseType: 'json',
    searchParams: {a: '1'},
  });

  assert.strictEqual(response.body.url, '/echo?a=1');
});

test('searchParams replace a query and drop a fragment together', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo?old=1#frag', {
    responseType: 'json',
    searchParams: {new: '2'},
  });

  assert.strictEqual(response.body.url, '/echo?new=2');
});

test('a fragment with no searchParams is left for undici to strip', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo#frag', {responseType: 'json'});

  assert.strictEqual(response.body.url, '/echo');
});

test('form sends a urlencoded body with the right content-type', async () => {
  const response = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: {user: 'a b', hash: 'x&y'},
  });

  assert.strictEqual(response.body.body, 'user=a+b&hash=x%26y');
  assert.strictEqual(response.body.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.strictEqual(response.body.method, 'POST');
});

test('form accepts URLSearchParams and drops nullish entries', async () => {
  const fromParams = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: new URLSearchParams({a: '1'}),
  });

  assert.strictEqual(fromParams.body.body, 'a=1');

  const dropped = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: {keep: 'yes', drop: null},
  });

  assert.strictEqual(dropped.body.body, 'keep=yes');
});

test('form does not override an explicit content-type, and json wins over form', async () => {
  const explicit = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: {a: '1'},
    headers: {'content-type': 'application/x-www-form-urlencoded; charset=utf-8'},
  });

  assert.strictEqual(explicit.body.headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');

  const both = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    json: {a: 1},
    form: {b: '2'},
  });

  assert.strictEqual(both.body.body, '{"a":1}');
  assert.strictEqual(both.body.headers['content-type'], 'application/json');
});

test('query method sends the QUERY verb and optional request payload', async () => {
  const withJson = await client.query<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    json: {search: 'term'},
  });

  assert.strictEqual(withJson.body.method, 'QUERY');
  assert.strictEqual(withJson.body.body, '{"search":"term"}');

  const withoutBody = await client.query<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
  });

  assert.strictEqual(withoutBody.body.method, 'QUERY');
  assert.strictEqual(withoutBody.body.body, '');
});

test('query method supports resolveBodyOnly', async () => {
  const body = await client.query<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    json: {q: 'only-body'},
    resolveBodyOnly: true,
  });

  assert.strictEqual(body.method, 'QUERY');
  assert.strictEqual(body.body, '{"q":"only-body"}');
});

test('validation accepts method: "QUERY"', async () => {
  const response = await client<Echo>('http://localhost:3000/echo', {
    method: 'QUERY',
    responseType: 'json',
    json: {customMethod: true},
  });

  assert.strictEqual(response.body.method, 'QUERY');
  assert.strictEqual(response.body.body, '{"customMethod":true}');
});

test('stream accepts a request body written to duplex with method QUERY', async () => {
  const duplex = await client.stream('http://localhost:3000/echo', {method: 'QUERY'});
  duplex.end('query-payload');

  const echo = JSON.parse(await text(duplex)) as Echo;
  assert.strictEqual(echo.method, 'QUERY');
  assert.strictEqual(echo.body, 'query-payload');
});

test('dnsCache resolves through a cached lookup', async () => {
  let lookups = 0;

  const extClient = new Gotlike({
    responseType: 'json',
    dnsCache: {
      lookup: (_origin, _options, callback) => {
        lookups++;
        callback(null, [{address: '127.0.0.1', ttl: 60, family: 4}]);
      },
    },
  });

  for (let i = 0; i < 3; i++) {
    const response = await extClient.get<{test: string}>('http://localhost:3000/json');

    assert.strictEqual(response.body.test, 'value');
  }

  assert.strictEqual(lookups, 1, `expected one lookup for three requests, saw ${lookups}`);
});

test('dedupe collapses concurrent identical GETs', async () => {
  const before = requestCounts['/counted'] ?? 0;

  const extClient = new Gotlike({responseType: 'json', dedupe: true});

  await Promise.all([
    extClient.get('http://localhost:3000/counted'),
    extClient.get('http://localhost:3000/counted'),
    extClient.get('http://localhost:3000/counted'),
  ]);

  assert.strictEqual((requestCounts['/counted'] ?? 0) - before, 1);
});

test('without dedupe every concurrent request reaches the server', async () => {
  const before = requestCounts['/counted'] ?? 0;

  const extClient = new Gotlike({responseType: 'json'});

  await Promise.all([extClient.get('http://localhost:3000/counted'), extClient.get('http://localhost:3000/counted')]);

  assert.strictEqual((requestCounts['/counted'] ?? 0) - before, 2);
});

test('cache serves a second request from the cache', async () => {
  const before = requestCounts['/cacheable'] ?? 0;

  const extClient = new Gotlike({responseType: 'json', cache: true});

  await extClient.get('http://localhost:3000/cacheable');
  await extClient.get('http://localhost:3000/cacheable');

  assert.strictEqual((requestCounts['/cacheable'] ?? 0) - before, 1);
});

test('pool options build a dedicated agent', async () => {
  const extClient = new Gotlike({
    responseType: 'json',
    connections: 1,
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 5000,
    connectTimeout: 2000,
  });

  assert.ok(extClient.ownAgent, 'expected a dedicated agent to be built');

  const response = await extClient.get<{test: string}>('http://localhost:3000/json');

  assert.strictEqual(response.body.test, 'value');
});

test('followRedirect false explicitly still resolves with the redirect response', async () => {
  const extClient = new Gotlike({followRedirect: false});

  const response = await extClient.get('http://localhost:3000/redirect');

  assert.strictEqual(response.statusCode, 302);
});

test('a client with no interceptors uses the base dispatcher directly', () => {
  const bare = new Gotlike({followRedirect: false, decompress: false});

  assert.strictEqual(bare.agent, getGlobalDispatcher());
});

test('response.ok reflects the 2xx range', async () => {
  const okResponse = await client.get('http://localhost:3000/json');

  assert.strictEqual(okResponse.ok, true);

  const notOk = await client.get('http://localhost:3000/status?code=404', {throwHttpErrors: false});

  assert.strictEqual(notOk.ok, false);

  const redirectNotFollowed = await client.get('http://localhost:3000/redirect', {
    followRedirect: false,
    throwHttpErrors: false,
  });

  assert.strictEqual(redirectNotFollowed.statusCode, 302);
  assert.strictEqual(redirectNotFollowed.ok, false);
});

test('response.rawBody returns the body as a Buffer', async () => {
  const asText = await client.get('http://localhost:3000/json');

  assert.ok(Buffer.isBuffer(asText.rawBody));
  assert.strictEqual(asText.rawBody.toString(), '{"test": "value"}\n');

  const parsed = await client.get('http://localhost:3000/json', {responseType: 'json'});

  assert.deepStrictEqual(JSON.parse(parsed.rawBody.toString()), {test: 'value'});

  const binary = await client.get<Buffer>('http://localhost:3000/png', {responseType: 'buffer'});

  // For a buffer responseType it is the body itself, not a copy.
  assert.strictEqual(binary.rawBody, binary.body);
});

test('response.retryCount counts retries', async () => {
  const noRetries = await client.get('http://localhost:3000/json');

  assert.strictEqual(noRetries.retryCount, 0);

  const extClient = client.extend({
    headers: {'test-id': randomUUID()},
    retry: {limit: 3, backoffLimit: 10},
  });

  // The /retry route fails twice before succeeding.
  const retried = await extClient.get('http://localhost:3000/retry');

  assert.strictEqual(retried.statusCode, 200);
  assert.strictEqual(retried.retryCount, 2);
});

test('retryCount is present on an error response too', async () => {
  const extClient = client.extend({
    headers: {'test-id': randomUUID()},
    retry: {limit: 1, backoffLimit: 10},
  });

  const err = await failure<RequestError>(extClient.get('http://localhost:3000/retry'));

  assert.strictEqual(err.response?.retryCount, 1);
});

test('username and password send a Basic authorization header', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    username: 'user',
    password: 'p@ss',
  });

  const expected = 'Basic ' + Buffer.from('user:p@ss').toString('base64');

  assert.strictEqual(response.body.headers['authorization'], expected);
});

test('an explicit authorization header wins over username/password', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    username: 'user',
    password: 'pass',
    headers: {authorization: 'Bearer token'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer token');
});

test('username without a password still authenticates', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    username: 'apikey',
  });

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('apikey:').toString('base64'));
});

test('errors use named classes and stay instanceof RequestError', async () => {
  const httpError = await failure<Error>(client.get('http://localhost:3000/status?code=500'));

  assert.ok(httpError instanceof HTTPError);
  assert.ok(httpError instanceof RequestError);
  assert.strictEqual(httpError.name, 'HTTPError');
  assert.strictEqual((httpError as HTTPError).code, 'ERR_HTTP_ERROR');

  const timeoutError = await failure(
    client.get('http://localhost:3000/timeout', {
      timeout: {request: 100},
    }),
  );

  assert.ok(timeoutError instanceof TimeoutError);
  assert.ok(timeoutError instanceof RequestError);
  assert.strictEqual(timeoutError.name, 'TimeoutError');

  const parseError = await failure<Error>(
    client.get('http://localhost:3000/text', {
      responseType: 'json',
    }),
  );

  assert.ok(parseError instanceof ParseError);
  assert.ok(parseError instanceof RequestError);
  assert.strictEqual(parseError.name, 'ParseError');

  const connectionError = await failure(client.get('http://localhost:3999/nope'));

  assert.ok(connectionError instanceof RequestError);
  assert.ok(!(connectionError instanceof HTTPError));
  assert.strictEqual(connectionError.name, 'RequestError');
});

test('beforeRetry fires for each retry with the failed attempt details', async () => {
  const seen: {statusCode?: number; retryCount: number}[] = [];

  const extClient = client.extend({
    headers: {'test-id': randomUUID()},
    retry: {limit: 3, backoffLimit: 10},
    hooks: {
      beforeRetry: [
        (_error, statusCode, retryCount) => {
          seen.push({statusCode, retryCount});
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/retry');

  assert.strictEqual(response.statusCode, 200);
  // /retry answers 429 twice before succeeding, so two retries.
  assert.deepStrictEqual(seen, [
    {statusCode: 429, retryCount: 1},
    {statusCode: 429, retryCount: 2},
  ]);
});

test('beforeRetry reports the error for a transport failure', async () => {
  const seen: (Error | undefined)[] = [];

  const extClient = client.extend({
    retry: {limit: 1, backoffLimit: 10, errorCodes: ['ECONNREFUSED']},
    hooks: {
      beforeRetry: [
        (error) => {
          seen.push(error);
        },
      ],
    },
  });

  await extClient.get('http://localhost:3999/nope').catch(() => undefined);

  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0] instanceof Error);
});

/*
 * An attempt that failed before its headers arrived produced no status at all, but the
 * previous attempt's was left on the shared state holder - so a 503 followed by a socket
 * reset told the hook that the reset had arrived with a 503, a response it was never sent.
 */
test('beforeRetry reports no status for an attempt that never got one', async () => {
  const seen: {statusCode?: number; code?: string; retryCount: number}[] = [];

  const extClient = client.extend({
    headers: {'test-id': randomUUID()},
    retry: {limit: 3, backoffLimit: 10, statusCodes: [503], errorCodes: ['ECONNRESET', 'UND_ERR_SOCKET']},
    hooks: {
      beforeRetry: [
        (error, statusCode, retryCount) => {
          seen.push({statusCode, code: (error as RequestError | undefined)?.code, retryCount});
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/retry-reset');

  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(seen, [
    {statusCode: 503, code: undefined, retryCount: 1},
    {statusCode: undefined, code: 'UND_ERR_SOCKET', retryCount: 2},
  ]);
});

test('beforeRetry does not fire when nothing is retried', async () => {
  let calls = 0;

  const extClient = client.extend({
    retry: {limit: 3, backoffLimit: 10},
    hooks: {
      beforeRetry: [
        () => {
          calls++;
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');

  assert.strictEqual(calls, 0);
});

/**
 * undici's decompress interceptor skips error responses by default; got does not. A gzipped
 * error body is exactly what error handling needs to read, so the default is overridden.
 */
test('error responses are decompressed too', async () => {
  const err = await failure(
    client.get('http://localhost:3000/gzip-error', {
      responseType: 'json',
    }),
  );

  assert.strictEqual(err.code, 'ERR_HTTP_ERROR');
  assert.deepStrictEqual(err.response?.body, {error: 'OP_ERROR_INVALID_TOKEN'});
});

test('decompress options can be overridden', async () => {
  const skipping = new Gotlike({
    responseType: 'buffer',
    throwHttpErrors: false,
    decompress: {skipErrorResponses: true},
  });

  const response = await skipping.get<Buffer>('http://localhost:3000/gzip-error');

  // left compressed: gzip magic bytes
  assert.strictEqual(response.body[0], 0x1f);
  assert.strictEqual(response.body[1], 0x8b);
});

/**
 * `resolveBodyOnly` is applied after the handler chain. Unwrapping inside `call()` meant a
 * handler reading `response.timings` blew up whenever a caller asked for the body only.
 */
test('handlers still see a full response under resolveBodyOnly', async () => {
  const seen: unknown[] = [];

  const extClient = client.extend({
    responseType: 'json',
    handlers: [
      async (options, next) => {
        const response = await next(options);

        seen.push(response.timings.phases.total, response.statusCode);

        return response;
      },
    ],
  });

  const body = (await extClient.get('http://localhost:3000/json', {
    resolveBodyOnly: true,
  })) as {test: string};

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(typeof seen[0], 'number');
  assert.strictEqual(seen[1], 200);
  assert.deepStrictEqual(body, {test: 'value'});
});

test('afterResponse hooks see a full response under resolveBodyOnly', async () => {
  let statusCode: number | undefined;

  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response) => {
          statusCode = response.statusCode;

          return response;
        },
      ],
    },
  });

  const body = (await extClient.get('http://localhost:3000/json', {
    resolveBodyOnly: true,
  })) as {test: string};

  assert.strictEqual(statusCode, 200);
  assert.deepStrictEqual(body, {test: 'value'});
});

test('the client can be called directly', async () => {
  const response = await client<{test: string}>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(response.body, {test: 'value'});
});

test('a called client defaults to GET and honours instance options', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    headers: {'x-from': 'instance'},
  });

  const response = await extClient<Echo>('echo');

  assert.strictEqual(response.body.method, 'GET');
  assert.strictEqual(response.body.headers['x-from'], 'instance');
});

test('the ThumbnailService shape works: callable + buffer + resolveBodyOnly', async () => {
  const body = await client<Buffer>('http://localhost:3000/png', {
    responseType: 'buffer',
    resolveBodyOnly: true,
  });

  assert.ok(Buffer.isBuffer(body));
  assert.strictEqual(body.subarray(1, 4).toString(), 'PNG');
});

test('a callable client keeps every method and stays callable through extend', async () => {
  const extended = client.extend({responseType: 'json'});

  assert.strictEqual(typeof extended, 'function');
  assert.strictEqual(typeof extended.get, 'function');
  assert.strictEqual(typeof extended.post, 'function');
  assert.strictEqual(typeof extended.stream, 'function');
  assert.strictEqual(typeof extended.extend, 'function');

  const twice = extended.extend({headers: {'x-twice': '1'}});

  assert.strictEqual(typeof twice, 'function');

  const viaCall = await twice<Echo>('http://localhost:3000/echo');
  const viaMethod = await twice.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(viaCall.body.headers['x-twice'], '1');
  assert.strictEqual(viaMethod.body.headers['x-twice'], '1');
});

/**
 * The `agent` getter reads private `#composed` fields, so methods have to stay bound to the
 * real instance rather than to the wrapping function.
 */
test('a callable client exposes getters and fields that touch private state', async () => {
  const extended = client.extend({responseType: 'json'});

  assert.ok(extended.agent, 'agent getter should resolve through the callable');
  assert.strictEqual(extended.agent, extended.agent, 'composition should still be memoised');
  assert.strictEqual(extended.baseOptions?.responseType, 'json');
  assert.strictEqual(extended.validate, true);
});

/**
 * Fields are forwarded by walking the instance's own keys, and a field only assigned inside an
 * `if` isn't one of them - so on a client that took no agent, `callable.ownAgent = ...` used to
 * set a dead property on the function while the `agent` getter kept using the global dispatcher.
 */
test('a callable client forwards fields that were left unset at construction', async () => {
  const callable = createClient({decompress: false});
  const agent = new Agent();

  for (const key of ['ownAgent', 'retryOptions', 'decompressOptions'] as const) {
    assert.strictEqual(
      typeof Object.getOwnPropertyDescriptor(callable, key)?.get,
      'function',
      `${key} should forward to the instance`,
    );
  }

  callable.ownAgent = agent;

  assert.strictEqual(callable.agent, agent, 'the agent getter should see the assignment');

  await agent.close();
});

test('validation rejects unknown and malformed options', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{responseTyp: 'json'}, /Unknown option `responseTyp`/],
    [{responseType: 'jsn'}, /`responseType` must be one of/],
    [{method: 'FETCH'}, /`method` must be a valid HTTP method/],
    [{timeout: 5000}, /`timeout` must be an object/],
    [{timeout: {request: -1}}, /`timeout.request` must be a finite number/],
    // 0 made `AbortSignal.timeout` fire at once and fail every request, while undici reads
    // its own `bodyTimeout: 0` as disabled; Infinity made `AbortSignal.timeout` throw.
    [{timeout: {request: 0}}, /`timeout.request` must be a finite number/],
    [{timeout: {request: Number.POSITIVE_INFINITY}}, /`timeout.request` must be a finite number/],
    [{timeout: {request: Number.NaN}}, /`timeout.request` must be a finite number/],
    [{headers: []}, /`headers` must be an object/],
    [{prefixUrl: 123}, /`prefixUrl` must be a string/],
    // A query on the prefix lands mid-url once `url` is concatenated onto it.
    [{prefixUrl: 'http://localhost:3000/api?x=1'}, /`prefixUrl` must not contain a query string/],
    [{prefixUrl: 'http://localhost:3000/api#frag'}, /`prefixUrl` must not contain a query string/],
    [{searchParams: 5}, /`searchParams` must be a string/],
    [{form: 'a=1'}, /`form` must be a URLSearchParams/],
    [{retry: {limit: 1}}, /can only be set when creating or extending/],
  ];

  for (const [options, expected] of cases) {
    await assert.rejects(
      () => client.get('http://localhost:3000/json', options as never),
      (err: Error) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError for ${JSON.stringify(options)}`);
        assert.match(err.message, expected);

        return true;
      },
      `expected ${JSON.stringify(options)} to be rejected`,
    );
  }
});

test('validation runs on create and extend, throwing synchronously', () => {
  assert.throws(() => new Gotlike({responseType: 'nope' as never}), ValidationError);
  assert.throws(() => new Gotlike({hooks: {beforeRequest: (() => undefined) as never}}), /must be an array/);
  assert.throws(() => client.extend({timeout: 1000 as never}), ValidationError);

  // client-only options are fine here - that is the whole point of `atCreation`
  assert.doesNotThrow(() => client.extend({retry: {limit: 2}, hooks: {beforeRequest: []}}));
});

/*
 * got refuses this outright rather than picking a winner (`The `url` option is mutually
 * exclusive with the `input` argument`, measured against got 14); the argument used to
 * overwrite the option with nothing said. The options-only callable form is the legal way to
 * pass a url as an option and has to keep working.
 */
test('a url given both as an argument and as an option is rejected', async () => {
  await assert.rejects(
    () => client.get('http://localhost:3000/json', {url: 'http://localhost:3000/text'}),
    (err: Error) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /both as an argument and as an option/);

      return true;
    },
  );

  const response = await client({url: 'http://localhost:3000/json'});

  assert.strictEqual(response.statusCode, 200);
});

test('validate itself is client-only', async () => {
  // Read from the instance, so a per-request value would have done nothing at all.
  await assert.rejects(
    () => client.get('http://localhost:3000/json', {validate: false}),
    (err: Error) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /only be set when creating or extending/);

      return true;
    },
  );
});

test('validate false skips the per-request check but not the client one', async () => {
  const lax = new Gotlike({responseType: 'text', validate: false});

  // would be rejected as an unknown option otherwise
  const response = await lax.get('http://localhost:3000/json', {nonsense: true} as never);

  assert.strictEqual(response.statusCode, 200);

  assert.throws(() => new Gotlike({validate: false, responseType: 'nope' as never}), ValidationError);
});

test('beforeRedirect fires for each hop with the redirecting response', async () => {
  const seen: {path: string; statusCode: number; location?: string}[] = [];

  const extClient = client.extend({
    responseType: 'json',
    followRedirect: true,
    hooks: {
      beforeRedirect: [
        (request, response) => {
          seen.push({
            path: request.path,
            statusCode: response.statusCode,
            location: response.headers['location'] as string | undefined,
          });
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/redirect-chain');

  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(seen, [
    {path: '/redirect-chain-2', statusCode: 302, location: '/redirect-chain-2'},
    {path: '/echo', statusCode: 301, location: '/echo'},
  ]);
});

/**
 * The reason this hook exists: undici drops `authorization` when a redirect crosses origins,
 * and `beforeRedirect` is where you decide to put it back.
 */
test('beforeRedirect can restore a header stripped on a cross-origin redirect', async () => {
  const redirecting = client.extend({followRedirect: true, responseType: 'json'});

  const withoutHook = await redirecting.get<Echo>('http://localhost:3000/redirect-cross-origin', {
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(withoutHook.body.headers['authorization'], undefined, 'undici should strip it');

  const extClient = redirecting.extend({
    hooks: {
      beforeRedirect: [
        (request) => {
          request.headers['authorization'] = 'Bearer restored';
        },
      ],
    },
  });

  const withHook = await extClient.get<Echo>('http://localhost:3000/redirect-cross-origin', {
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(withHook.body.headers['authorization'], 'Bearer restored');
});

/**
 * At a hop undici hands the interceptor its flat `[name, value]` header form, and a
 * multi-valued header arrives there as an array. `String(['one', 'two'])` flattened it to the
 * single value `one,two`, so a request carrying an array header went out as two headers before
 * a redirect and one after it - and only on clients that have a `beforeRedirect` hook, since
 * nothing else converts those headers at all.
 */
test('a multi-valued request header survives a redirect intact', async () => {
  const extClient = client.extend({
    followRedirect: true,
    hooks: {beforeRedirect: [() => {}]},
  });

  const redirected = await extClient.get<Record<string, string>>('http://localhost:3000/redirect-headers', {
    headers: {'x-multi': ['one', 'two']},
    responseType: 'json',
  });

  const direct = await extClient.get<Record<string, string>>('http://localhost:3000/headers', {
    headers: {'x-multi': ['one', 'two']},
    responseType: 'json',
  });

  // node joins repeated headers with ', '; a single flattened one would read 'one,two'.
  assert.strictEqual(redirected.body['x-multi'], 'one, two');
  assert.strictEqual(redirected.body['x-multi'], direct.body['x-multi']);
});

test('beforeRedirect does not fire when nothing redirects', async () => {
  let calls = 0;

  const extClient = client.extend({
    hooks: {
      beforeRedirect: [
        () => {
          calls++;
        },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');

  assert.strictEqual(calls, 0);
});

test('beforeRedirect does not fire when followRedirect is off', async () => {
  let calls = 0;

  const extClient = client.extend({
    followRedirect: false,
    throwHttpErrors: false,
    hooks: {
      beforeRedirect: [
        () => {
          calls++;
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/redirect-chain');

  assert.strictEqual(response.statusCode, 302);
  assert.strictEqual(calls, 0);
});

/*
 * A retry is a fresh redirect chain, not a continuation of the previous one. The tracker's
 * state holder travels with the dispatch options, so it survived the retry interceptor's
 * re-dispatch: the retried attempt entered the tracker with the previous attempt's hop count
 * already on it, was treated as one more hop, and fired `beforeRedirect` with the status that
 * had caused the retry - telling the hook that a `503` had redirected to the original url.
 */
/*
 * The routing between the two stream paths keys on the method, not on whether a body happens
 * to be present: `undici.pipeline` makes the duplex's writable half the request body, and
 * `RedirectHandler` will not follow a redirect whose body it cannot replay - so a GET stream
 * carrying a body from the options used to resolve with the bare 302 whatever `followRedirect`
 * said. Through `undici.request` the body is an ordinary replayable one.
 */
test('a stream given a body in its options still follows redirects', async () => {
  const extClient = client.extend({followRedirect: true});
  const stream = await extClient.stream('http://localhost:3000/redirect-echo', {body: 'payload'});
  const head = await stream.response;

  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(head.url, 'http://localhost:3000/echo');

  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  const echoed = JSON.parse(Buffer.concat(chunks).toString()) as {url: string; method: string; body: string};

  assert.strictEqual(echoed.url, '/echo');
  // The body survived the hop too, which is what `undici.request` buys over the pipeline.
  assert.strictEqual(echoed.method, 'GET');
  assert.strictEqual(echoed.body, 'payload');
});

/*
 * `timeout.request` bounds an attempt, not the whole retry sequence - as got's does, and as
 * undici's own per-phase timeouts do. The deadline signal spans every attempt undici makes, so
 * it used to be a cumulative budget: four 100ms attempts under a 250ms timeout died on the
 * third. Measured against got 14, which runs all of them.
 */
test('timeout.request bounds each attempt rather than the whole retry sequence', async () => {
  const extClient = client.extend({
    retry: {limit: 3, backoffLimit: 10, statusCodes: [503]},
  });
  const response = await extClient.get('http://localhost:3000/slow-flaky', {
    timeout: {request: 250},
    headers: {'test-id': randomUUID()},
  });

  assert.strictEqual(response.body, 'slow ok');
  assert.strictEqual(response.retryCount, 3);
});

/*
 * The other half of the same change: restarting the clock per attempt must not stop it
 * bounding one. A single attempt that outruns the deadline still fails.
 */
test('timeout.request still fires within a single retried attempt', async () => {
  const extClient = client.extend({
    retry: {limit: 3, backoffLimit: 10, statusCodes: [503]},
  });

  await assert.rejects(
    () =>
      extClient.get('http://localhost:3000/slow-flaky', {
        timeout: {request: 50},
        headers: {'test-id': randomUUID()},
      }),
    (err: Error) => {
      assert.ok(err instanceof TimeoutError);
      assert.strictEqual((err as RequestError).code, 'ETIMEDOUT');

      return true;
    },
  );
});

test('beforeRedirect does not fire for a retry', async () => {
  const calls: Array<{statusCode: number; path: string}> = [];

  const extClient = client.extend({
    followRedirect: true,
    retry: {limit: 3, backoffLimit: 10, statusCodes: [503]},
    hooks: {
      beforeRedirect: [
        (request, response) => {
          calls.push({statusCode: response.statusCode, path: String(request.path)});
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/redirect-flaky', {
    headers: {'test-id': randomUUID()},
  });

  assert.strictEqual(response.body, 'flaky ok');
  assert.strictEqual(response.retryCount, 1);

  // One real hop per attempt, and nothing else: no `503 -> /redirect-flaky` entry.
  assert.deepStrictEqual(calls, [
    {statusCode: 302, path: '/flaky-target'},
    {statusCode: 302, path: '/flaky-target'},
  ]);
});

/*
 * The other half of the same holder, and a guard on the fix rather than on the old bug: this
 * passed before, but only by accident. `lastUrl` is what `response.url` reports, and a hop
 * recorded on the first attempt must not be left standing for a retried attempt that went
 * somewhere else - here the retry is answered by the url that was requested, while the first
 * attempt had been redirected away from it. The bogus retry-as-hop used to overwrite `lastUrl`
 * with the right answer on its way past; clearing the holder has to reach the same place
 * deliberately, via the fallback to the requested url.
 */
test("response.url after a retry names the url that answered, not the previous attempt's hop", async () => {
  const extClient = client.extend({
    followRedirect: true,
    retry: {limit: 3, backoffLimit: 10, statusCodes: [503]},
  });

  const response = await extClient.get('http://localhost:3000/flip', {
    headers: {'test-id': randomUUID()},
  });

  assert.strictEqual(response.body, 'answered by flip');
  assert.strictEqual(response.retryCount, 1);
  assert.strictEqual(response.url, 'http://localhost:3000/flip');
});

test('beforeRedirect concatenates through extend and works on streams', async () => {
  const seen: string[] = [];

  const parent = client.extend({
    followRedirect: true,
    hooks: {
      beforeRedirect: [
        () => {
          seen.push('parent');
        },
      ],
    },
  });
  const child = parent.extend({
    hooks: {
      beforeRedirect: [
        () => {
          seen.push('child');
        },
      ],
    },
  });

  const duplex = await child.stream('http://localhost:3000/redirect');

  const head = await duplex.response;

  await text(duplex);

  assert.strictEqual(head.statusCode, 200, 'the redirect should have been followed');
  assert.deepStrictEqual(seen, ['parent', 'child']);
});

test('redirect hops are not counted as retries', async () => {
  const extClient = client.extend({
    headers: {'test-id': randomUUID()},
    followRedirect: true,
    retry: {limit: 2, backoffLimit: 10},
    hooks: {beforeRedirect: [() => undefined]},
  });

  const response = await extClient.get('http://localhost:3000/redirect-chain');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.retryCount, 0);
});

/**
 * `undici.pipeline` makes the duplex's writable side the request body, and undici won't
 * follow a redirect whose body it can't replay - so a piped GET used to hand back the 302
 * itself with an empty body. Requests with no body take a path where redirects work.
 */
test('a bodyless stream follows redirects', async () => {
  const duplex = await client.extend({followRedirect: true}).stream('http://localhost:3000/redirect-chain');

  const head = await duplex.response;
  const body = JSON.parse(await text(duplex)) as Echo;

  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(body.url, '/echo');
});

test('a streamed POST follows a 302, which drops the body anyway', async () => {
  const duplex = await client.extend({followRedirect: true}).stream('http://localhost:3000/redirect-chain', {
    method: 'POST',
    throwHttpErrors: false,
  });

  duplex.end('dropped-by-the-302');

  const head = await duplex.response;
  const echo = JSON.parse(await text(duplex)) as Echo;

  // 301/302 on POST rewrites to GET and discards the body, so there is nothing to replay.
  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(echo.method, 'GET');
  assert.strictEqual(echo.body, '');
});

/**
 * The actual limitation: a 307 preserves method and body, so the body would have to be
 * replayed - and undici will not replay a stream. The request resolves with the 307 itself.
 */
test('a streamed body is not replayed across a 307', async () => {
  const duplex = await client.extend({followRedirect: true}).stream('http://localhost:3000/redirect-307', {
    method: 'POST',
    throwHttpErrors: false,
  });

  duplex.end('cannot-be-replayed');

  const head = await duplex.response;

  assert.strictEqual(head.statusCode, 307);

  await text(duplex);
});

test('a non-streamed body is replayed across a 307', async () => {
  const response = await client.extend({followRedirect: true}).post<Echo>('http://localhost:3000/redirect-307', {
    responseType: 'json',
    body: 'can-be-replayed',
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.method, 'POST');
  assert.strictEqual(response.body.body, 'can-be-replayed');
});

/**
 * A bodyless request gets the response stream unwrapped: there is nothing to write to a GET,
 * and wrapping it in a duplex costs about 10% of stream throughput. A method that can carry
 * a body still gets the writable half.
 */
test('a bodyless stream is a plain readable, an upload stream is writable', async () => {
  const download = await client.stream('http://localhost:3000/json');

  assert.strictEqual(typeof (download as unknown as {write?: unknown}).write, 'undefined');
  assert.strictEqual(typeof download.pipe, 'function');
  assert.strictEqual(await text(download), '{"test": "value"}\n');

  const upload = await client.stream('http://localhost:3000/echo', {method: 'POST'});

  assert.strictEqual(typeof upload.write, 'function');
  upload.end('written');

  const echo = JSON.parse(await text(upload)) as Echo;

  assert.strictEqual(echo.body, 'written');
});

/**
 * `stream()` passes no method of its own, and only the exported singletons carry one in their
 * base options. Without a default the request fell through to the `undici.pipeline` path,
 * whose writable half is only ended for GET and HEAD - so it was never sent and the caller
 * waited forever.
 */
test('stream defaults to GET on a client that carries no method', {timeout: 10_000}, async () => {
  const bare = new Gotlike({responseType: 'text'});
  const download = await bare.stream('http://localhost:3000/json');

  assert.strictEqual(typeof (download as unknown as {write?: unknown}).write, 'undefined');
  assert.strictEqual(await text(download), '{"test": "value"}\n');
});

/** A method that cannot carry a body types as a plain readable, so nothing can end it. */
test('a bodyless method other than GET still streams', {timeout: 10_000}, async () => {
  const download = await client.stream('http://localhost:3000/echo', {method: 'OPTIONS'});

  const echo = JSON.parse(await text(download)) as Echo;

  assert.strictEqual(echo.method, 'OPTIONS');
});

/**
 * The `agent` option is the transport seam: gotlike never looks inside a dispatcher, so any
 * `Dispatcher` works - a ProxyAgent, an H2CClient, or one that doesn't exist yet. This is
 * the whole of what "supporting a new transport" would mean here, HTTP/3 included.
 */
test('an arbitrary custom dispatcher can back the client', async () => {
  class CustomTransport extends Dispatcher {
    #inner = new Agent();
    dispatched = 0;

    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      this.dispatched++;
      options.headers = {...(options.headers as object), 'x-transport': 'custom'};

      return this.#inner.dispatch(options, handler);
    }

    override close() {
      return this.#inner.close();
    }

    override destroy() {
      return this.#inner.destroy();
    }
  }

  const transport = new CustomTransport();
  const extClient = new Gotlike({agent: transport, responseType: 'json'});

  const response = await extClient.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(response.body.headers['x-transport'], 'custom');
  assert.strictEqual(transport.dispatched, 1);

  // The interceptor chain still composes on top of whatever transport is underneath.
  assert.notStrictEqual(extClient.agent, transport);

  await transport.close();
});

/**
 * Redirects are opt-in: undici allocates a RedirectHandler per request once its interceptor is
 * composed, which measured at ~80% of this client's whole per-request overhead. This is a
 * deliberate divergence from got, so it is pinned down here.
 */
test('redirects are not followed by default', async () => {
  const response = await client.get('http://localhost:3000/redirect', {throwHttpErrors: false});

  assert.strictEqual(response.statusCode, 302);
  assert.strictEqual(response.headers['location'], '/json');
  assert.strictEqual(response.ok, false);
});

test('followRedirect true on the client follows them', async () => {
  const redirecting = client.extend({followRedirect: true, responseType: 'json'});

  const response = await redirecting.get<{test: string}>('http://localhost:3000/redirect');

  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(response.body, {test: 'value'});
});

/**
 * Enabling redirects means composing an interceptor, which can only happen at create/extend
 * time - so a per-request `true` could never work. Rejecting beats ignoring it.
 */
test('followRedirect true per request is rejected, false is allowed', async () => {
  await assert.rejects(
    () => client.get('http://localhost:3000/redirect', {followRedirect: true}),
    (err: Error) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /only be set when creating or extending/);

      return true;
    },
  );

  // Turning them off per request is fine on a client that has them on.
  const redirecting = client.extend({followRedirect: true});

  const response = await redirecting.get('http://localhost:3000/redirect', {
    followRedirect: false,
    throwHttpErrors: false,
  });

  assert.strictEqual(response.statusCode, 302);
});

test('a client without redirects composes no redirect interceptor', () => {
  const plain = new Gotlike({decompress: false});
  const redirecting = new Gotlike({decompress: false, followRedirect: true});

  assert.strictEqual(plain.followsRedirects, false);
  assert.strictEqual(plain.agent, getGlobalDispatcher(), 'nothing to compose');

  assert.strictEqual(redirecting.followsRedirects, true);
  assert.notStrictEqual(redirecting.agent, getGlobalDispatcher());
});

/**
 * Bodies that cannot exist. Parsing them anyway turned every empty 204 into a failure, and
 * the failure was misfiled as a generic request error rather than a parse error.
 */
test('status codes that cannot carry a body are not parsed', async () => {
  for (const code of [204, 205, 304]) {
    const json = await client.get(`http://localhost:3000/status-empty?code=${code}`, {
      responseType: 'json',
      throwHttpErrors: false,
    });

    assert.strictEqual(json.statusCode, code);
    assert.strictEqual(json.body, undefined, `${code} json body`);

    const plain = await client.get(`http://localhost:3000/status-empty?code=${code}`, {
      throwHttpErrors: false,
    });

    assert.strictEqual(plain.body, '', `${code} text body`);

    const buffer = await client.get<Buffer>(`http://localhost:3000/status-empty?code=${code}`, {
      responseType: 'buffer',
      throwHttpErrors: false,
    });

    assert.ok(Buffer.isBuffer(buffer.body));
    assert.strictEqual(buffer.body.length, 0, `${code} buffer body`);
  }
});

test('a HEAD response is not parsed as json', async () => {
  const response = await client.handle({
    url: 'http://localhost:3000/json',
    method: 'HEAD',
    responseType: 'json',
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body, undefined);
});

/**
 * V8 words JSON failures differently depending on the input - "Unexpected end of JSON input"
 * for an empty body against "... is not valid JSON" for garbage. Matching on the wording
 * misfiled empty bodies as `ERR_REQUEST_ERROR`.
 */
test('an empty body is a parse error, not a generic request error', async () => {
  const err = await failure(
    client.get('http://localhost:3000/status?code=200', {
      responseType: 'json',
    }),
  );

  assert.ok(err instanceof ParseError, `expected a ParseError, got ${err.name}`);
  assert.strictEqual(err.code, 'ERR_BODY_PARSE_FAILURE');
  assert.strictEqual(err.response?.body, '');
});

test('aborting an in-flight request gives an AbortError', async () => {
  const controller = new AbortController();

  const request = client.get('http://localhost:3000/slow', {signal: controller.signal});

  setTimeout(() => controller.abort(), 50);

  const err = await failure(request);

  assert.ok(err instanceof AbortError, `expected an AbortError, got ${err.name}`);
  assert.ok(err instanceof RequestError);
  assert.strictEqual(err.code, 'ERR_ABORTED');
});

test('an already-aborted signal fails immediately', async () => {
  const err = await failure(client.get('http://localhost:3000/json', {signal: AbortSignal.abort()}));

  assert.strictEqual(err.code, 'ERR_ABORTED');
});

/**
 * A signal reports its reason as a DOMException named `AbortError` for `abort()` but
 * `TimeoutError` for `AbortSignal.timeout()`. The latter lands on the same class and code as
 * `timeout.request`, since it is a timeout either way.
 */
test('AbortSignal.timeout surfaces as a TimeoutError', async () => {
  const err = await failure(
    client.get('http://localhost:3000/slow', {
      signal: AbortSignal.timeout(50),
    }),
  );

  assert.ok(err instanceof TimeoutError, `expected a TimeoutError, got ${err.name}`);
  assert.strictEqual(err.code, 'ETIMEDOUT');
});

test('a signal that never fires does not affect the request', async () => {
  const controller = new AbortController();

  const response = await client.get('http://localhost:3000/json', {signal: controller.signal});

  assert.strictEqual(response.statusCode, 200);
});

test('headers set to undefined are omitted rather than sent', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    headers: {'x-present': 'yes', 'x-absent': undefined},
  });

  assert.strictEqual(response.body.headers['x-present'], 'yes');
  assert.ok(!('x-absent' in response.body.headers));
});

test('json accepts values other than plain objects', async () => {
  const cases: [unknown, string][] = [
    [[1, 2], '[1,2]'],
    ['hi', '"hi"'],
    [42, '42'],
    [null, 'null'],
  ];

  for (const [json, expected] of cases) {
    const response = await client.post<Echo>('http://localhost:3000/echo', {
      responseType: 'json',
      json,
    });

    assert.strictEqual(response.body.body, expected);
  }
});

test('POST is not retried by default', async () => {
  const testId = randomUUID();

  const extClient = client.extend({
    headers: {'test-id': testId},
    retry: {limit: 3, backoffLimit: 10},
    throwHttpErrors: false,
  });

  // /retry answers 429 twice before succeeding; a retried POST would reach 200.
  const response = await extClient.post('http://localhost:3000/retry');

  assert.strictEqual(response.statusCode, 429);
  assert.strictEqual(response.retryCount, 0);
});

test('searchParams survive a redirect', async () => {
  const redirecting = client.extend({followRedirect: true, responseType: 'json'});

  const response = await redirecting.get<Echo>('http://localhost:3000/redirect-chain', {
    searchParams: {carried: 'yes'},
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.url, '/echo');
});

test('nock mocks request once', async () => {
  nock('http://localhost:3000').get('/json').reply(201, '{"test": "newvalue"}');

  const response = await client.get<{test: string}>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response.statusCode, 201);
  assert.strictEqual(response.body.test, 'newvalue');

  const response2 = await client.get<{test: string}>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response2.body.test, 'value');
});

/*
 * Regressions for the defaults, error-normalisation and stream fixes below. Each of these
 * failed silently before: the whole point of the group is that nothing about them was
 * visible to a caller until something downstream went wrong.
 */

test('a directly constructed client throws on error statuses, like the singleton', async () => {
  // `defaultOptions` used to be applied only to the exported singleton, so `new Gotlike(...)`
  // got `throwHttpErrors: undefined` and quietly resolved every 4xx/5xx as a success.
  const bare = new Gotlike({prefixUrl: 'http://localhost:3000'});

  const error = await failure<HTTPError>(bare.get('status?code=500'));

  assert.ok(error instanceof HTTPError);
  assert.strictEqual(error.code, 'ERR_HTTP_ERROR');
});

test('a directly constructed client defaults to text, not buffer', async () => {
  const bare = new Gotlike({prefixUrl: 'http://localhost:3000'});
  const callable = createClient({prefixUrl: 'http://localhost:3000'});

  assert.strictEqual(typeof (await bare.get('json')).body, 'string');
  assert.strictEqual(typeof (await callable.get('json')).body, 'string');
});

test('a directly constructed client does not follow redirects by default', async () => {
  const bare = new Gotlike({prefixUrl: 'http://localhost:3000', throwHttpErrors: false});

  assert.strictEqual((await bare.get('redirect')).statusCode, 302);
});

test('a client-level json body is not inherited by the requests it makes', async () => {
  // A body belongs to one request. This client used to send `{"leaked":true}` on every call.
  const withBody = client.extend({json: {leaked: true}, responseType: 'json'});

  const response = await withBody.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(response.body.body, '');
  assert.strictEqual(response.body.headers['content-type'], undefined);

  // A per-call body still works on that same client.
  const posted = await withBody.post<Echo>('http://localhost:3000/echo', {json: {sent: true}});

  assert.strictEqual(posted.body.body, '{"sent":true}');
});

test('a client-level body and form are not inherited either', async () => {
  const withBody = client.extend({body: 'client-body', responseType: 'json'});
  const withForm = client.extend({form: {a: '1'}, responseType: 'json'});

  assert.strictEqual((await withBody.get<Echo>('http://localhost:3000/echo')).body.body, '');
  assert.strictEqual((await withForm.get<Echo>('http://localhost:3000/echo')).body.body, '');
});

test('an error thrown by a beforeRequest hook is a RequestError and runs beforeError', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        () => {
          throw new Error('hook exploded');
        },
      ],
      beforeError: [
        (error) => {
          seen.push(error.message);

          return error;
        },
      ],
    },
  });

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
  assert.strictEqual(error.message, 'hook exploded');
  assert.strictEqual((error.cause as Error).message, 'hook exploded');
  assert.deepStrictEqual(seen, ['hook exploded']);
});

/*
 * `ERR_REQUEST_ERROR` used to be raised with the literal message 'Request error', so a
 * connection refused, a DNS failure and a malformed url were indistinguishable in any log line
 * or APM grouping - the real reason only reachable through `cause`, which little code reads.
 * got reports the underlying message, and so does the pre-request catch just above.
 */
test('a transport failure reports the underlying message, not a generic label', async () => {
  const refused = await failure(client.get('http://127.0.0.1:1/nothing-here'));

  // The underlying error's own code, as got reports it - not the generic label.
  assert.strictEqual(refused.code, 'ECONNREFUSED');
  assert.match(refused.message, /ECONNREFUSED/);
  assert.notStrictEqual(refused.message, 'Request error');

  const malformed = await failure(client.get('not-a-url'));

  assert.strictEqual(malformed.code, 'ERR_INVALID_URL');
  assert.match(malformed.message, /Invalid URL/);

  // The originating error is still on `cause` as well.
  assert.strictEqual((refused.cause as Error).message, refused.message);
});

/**
 * The one retry test that genuinely spends real time: the wall clock *is* the assertion, and
 * nothing can be faked away. `mock.timers` can't help - node's fake timers never reach
 * `AbortSignal.timeout`, and ticking undici's backoff here would also fast-forward its
 * keep-alive timers and tear down the socket mid-test. Deliberately no `backoffLimit`, since
 * undici takes `min(retryAfter, maxTimeout)` and clamping it would defeat the point.
 */
test('retry honours Retry-After by default', async () => {
  const testId = randomUUID();
  const retrying = client.extend({retry: {limit: 1, statusCodes: [429]}, throwHttpErrors: false});

  const start = process.hrtime.bigint();

  const response = await retrying.get('http://localhost:3000/retry-after', {headers: {'test-id': testId}});

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.strictEqual(response.statusCode, 429);
  assert.strictEqual(response.retryCount, 1);
  assert.strictEqual(serverState.retryCounts[testId], 2);

  // One retry, with the server asking for 2s. Ignoring the header raced through in ~500ms.
  assert.ok(elapsedMs > 1500, `expected Retry-After to be honoured, retried after ${elapsedMs}ms`);
});

test("retry defaults to got's limit of 2, not undici's 5", async () => {
  const testId = randomUUID();
  // No `limit`: undici would default to 5 retries, tripling what a failing upstream sees.
  // `backoffLimit` clamps the wait (undici takes `min(retryAfter, maxTimeout)`), so this
  // asserts the retry *count* without paying for the route's `retry-after: 2`.
  const retrying = client.extend({retry: {statusCodes: [429], backoffLimit: 10}, throwHttpErrors: false});

  const response = await retrying.get('http://localhost:3000/retry-after', {headers: {'test-id': testId}});

  assert.strictEqual(response.retryCount, 2);
  assert.strictEqual(serverState.retryCounts[testId], 3);
});

test('a per-request followRedirect: true fails validation rather than the request', async () => {
  // With `validate` off this used to reach undici as an unsupported `maxRedirections`, which
  // failed the request with an opaque UND_ERR_INVALID_ARG instead of being ignored.
  const lax = new Gotlike({responseType: 'json', validate: false, prefixUrl: 'http://localhost:3000'});

  const response = await lax.get<Echo>('echo', {followRedirect: true});

  assert.strictEqual(response.statusCode, 200);

  await assert.rejects(() => client.get('http://localhost:3000/echo', {followRedirect: true}), ValidationError);
});

test('rawBody is the bytes that arrived, not a re-serialisation of the parsed json', async () => {
  const response = await client.get<{test: string}>('http://localhost:3000/json', {responseType: 'json'});

  // The route writes `{"test": "value"}\n` - spacing and trailing newline included.
  assert.strictEqual(response.rawBody.toString(), '{"test": "value"}\n');
  assert.deepStrictEqual(response.body, {test: 'value'});
});

test('searchParams and form repeat a key for an array value', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    searchParams: {a: [1, 2], b: 'z', dropped: null},
  });

  assert.strictEqual(response.body.url, '/echo?a=1&a=2&b=z');

  const posted = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: {a: ['x', 'y']},
  });

  assert.strictEqual(posted.body.body, 'a=x&a=y');
});

test('an empty url resolves to the prefix itself, with no trailing slash added', async () => {
  const prefixed = client.extend({prefixUrl: 'http://localhost:3000/echo', responseType: 'json'});

  assert.strictEqual((await prefixed.get<Echo>('')).body.url, '/echo');
});

test("an afterResponse retry does not write back onto the first attempt's options", async () => {
  let first: GotlikeResponse<Echo> | undefined;

  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (first) {
            return response;
          }

          first = response as GotlikeResponse<Echo>;

          // No `headers` of its own: the merged options used to alias the first attempt's
          // header object, so `call()`'s content-type for this body landed on it too.
          return retryWithMergedOptions({json: {second: true}, method: 'POST'});
        },
      ],
    },
  });

  await extClient.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(first?.request.options.headers['content-type'], undefined);
  assert.strictEqual(first?.request.options.body, undefined);
});

/*
 * A body the hook supplies has to replace the first attempt's, not lose to it. `call()`
 * resolves `json` -> `form` -> `body`, so the first attempt's `json` used to outrank a `body`
 * or `form` the hook had just set: the original body was sent a second time and the hook's
 * never left the process. The stale `content-type` came along with it, so a json-then-form
 * retry went out as a form body labelled `application/json`.
 */
test('an afterResponse retry can replace a json body with a raw one', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.retried) {
            return response;
          }

          return retryWithMergedOptions({context: {retried: true}, body: 'replaced'});
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {json: {first: true}});

  assert.strictEqual(response.body.body, 'replaced');
  // The json content-type described the body that was just replaced.
  assert.strictEqual(response.body.headers['content-type'], undefined);
});

test('an afterResponse retry can replace a json body with a form', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.retried) {
            return response;
          }

          return retryWithMergedOptions({context: {retried: true}, form: {q: 'x'}});
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {json: {first: true}});

  assert.strictEqual(response.body.body, 'q=x');
  assert.strictEqual(response.body.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('an afterResponse retry keeps a content-type the hook set itself', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.retried) {
            return response;
          }

          return retryWithMergedOptions({
            context: {retried: true},
            body: '<xml/>',
            headers: {'content-type': 'application/xml'},
          });
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {json: {first: true}});

  assert.strictEqual(response.body.body, '<xml/>');
  assert.strictEqual(response.body.headers['content-type'], 'application/xml');
});

/*
 * An explicit `content-length` describes the replaced body just as `content-type` does. undici
 * validates a caller-supplied one against the body it is about to send and fails the dispatch
 * with `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`, so the stale header turned a retry with a
 * differently sized body into an opaque `ERR_REQUEST_ERROR`.
 */
test('an afterResponse retry drops a stale content-length with the body it described', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.retried) {
            return response;
          }

          return retryWithMergedOptions({context: {retried: true}, body: 'a much longer body'});
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {
    body: 'short',
    headers: {'content-length': '5'},
  });

  assert.strictEqual(response.body.body, 'a much longer body');
  assert.strictEqual(response.body.headers['content-length'], String('a much longer body'.length));
});

test('an afterResponse retry keeps a content-length the hook set itself', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.retried) {
            return response;
          }

          return retryWithMergedOptions({
            context: {retried: true},
            body: 'a much longer body',
            headers: {'Content-Length': '18'},
          });
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {
    body: 'short',
    headers: {'content-length': '5'},
  });

  assert.strictEqual(response.body.body, 'a much longer body');
  assert.strictEqual(response.body.headers['content-length'], '18');
});

test('an afterResponse retry that names no body keeps the first attempt’s', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.retried) {
            return response;
          }

          // Only credentials change - the body and its content-type must survive, which is
          // the whole point of a token-refresh retry.
          return retryWithMergedOptions({context: {retried: true}, headers: {authorization: 'Bearer new'}});
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {json: {first: true}});

  assert.strictEqual(response.body.body, '{"first":true}');
  assert.strictEqual(response.body.headers['content-type'], 'application/json');
  assert.strictEqual(response.body.headers['authorization'], 'Bearer new');
});

/*
 * A hook that retries unconditionally used to recurse until the process died, and was then
 * capped by `maxAfterResponseRetries`. It can no longer recurse at all: a retry re-runs only
 * the hooks *before* the one that retried, so each retry has strictly fewer hooks to run than
 * the last and the chain is bounded by the array's own length. Verified against got, which
 * calls a lone retrying hook exactly once.
 */
test('an afterResponse hook that always retries cannot recurse', async () => {
  let calls = 0;

  const extClient = client.extend({
    hooks: {
      afterResponse: [
        (_response, retryWithMergedOptions) => {
          calls++;

          return retryWithMergedOptions({});
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/json');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(calls, 1);
});

/*
 * The ordering got actually produces, measured: with `[h1, h2]` and `h2` retrying, got runs
 * `h1, h2` on the first response and `h1` alone on the retried one. `h2` never sees its own
 * retry, and `h1` runs again because it ran before the retry was decided.
 */
test('a retry re-runs only the afterResponse hooks before the one that retried', async () => {
  const order: string[] = [];
  let retried = false;

  const extClient = client.extend({
    hooks: {
      afterResponse: [
        (response) => {
          order.push(`h1:${response.statusCode}`);

          return response;
        },
        (response, retryWithMergedOptions) => {
          order.push(`h2:${response.statusCode}`);

          if (!retried) {
            retried = true;

            return retryWithMergedOptions({headers: {authorization: 'Bearer refreshed'}});
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/unauthorized');

  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(order, ['h1:401', 'h2:401', 'h1:200']);
});

test('beforeError runs for a stream, and the error carries the response', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    hooks: {
      beforeError: [
        (error) => {
          seen.push(error.code);

          return error;
        },
      ],
    },
  });

  const duplex = await extClient.stream('http://localhost:3000/status?code=503');
  const error = await failure<HTTPError>(text(duplex));

  assert.ok(error instanceof HTTPError);
  assert.deepStrictEqual(seen, ['ERR_HTTP_ERROR']);
  assert.strictEqual(error.response?.statusCode, 503);
  assert.strictEqual(error.response?.ok, false);
});

test('beforeError runs for an upload stream too', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    hooks: {
      beforeError: [
        (error) => {
          seen.push(error.code);

          return error;
        },
      ],
    },
  });

  const duplex = await extClient.stream('http://localhost:3000/status?code=500', {method: 'POST'});

  duplex.end('body');

  const error = await failure<HTTPError>(text(duplex));

  assert.ok(error instanceof HTTPError, `expected an HTTPError, got ${error}`);
  assert.deepStrictEqual(seen, ['ERR_HTTP_ERROR']);
  assert.strictEqual(error.response?.statusCode, 500);
});

/*
 * Stream failures that aren't an HTTP status. Every one of these used to escape as undici's
 * own error with the `beforeError` hooks unrun: a connection refused as a bare `Error`, a
 * `timeout.request` as a `DOMException` whose `code` is the *number* 23, and a mid-body socket
 * reset as a `SocketError`. The upload path normalised none of them; the bodyless path
 * normalised only the ones that happened before the response head.
 *
 * got reports all of these as `RequestError` subclasses with the hooks applied, and the README
 * promises the same, so each combination gets its own test.
 */
function hookRecorder() {
  const seen: string[] = [];

  const recording = client.extend({
    hooks: {
      beforeError: [
        (error) => {
          seen.push(error.code);

          return error;
        },
      ],
    },
  });

  return {seen, recording};
}

test('a connection failure on a bodyless stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const stream = await recording.stream('http://127.0.0.1:1/nothing-here');
  const error = await failure(text(stream));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ECONNREFUSED');
  assert.deepStrictEqual(seen, ['ECONNREFUSED']);
  // The underlying reason survives onto `message`, not just onto `cause`.
  assert.match(error.message, /ECONNREFUSED/);
});

/*
 * got emits a stream's failure whether or not the stream is ever read, and the pattern that
 * relies on it is ordinary: listen for `error` and `response`, pipe from inside the `response`
 * handler. A request that failed before any response never fires `response`, so nothing ever
 * reads the stream - and raising the error at read time alone left that caller waiting on a
 * stream that had already failed.
 */
test('a pre-response stream failure reaches an error listener that never reads', async () => {
  const stream = await client.stream('http://127.0.0.1:1/nothing-here');

  const error = await failure(new Promise((_resolve, reject) => stream.on('error', reject)));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ECONNREFUSED');
});

// The same, for a listener attached later than the tick the stream was handed over on.
test('a pre-response stream failure reaches an error listener attached late', async () => {
  const stream = await client.stream('http://127.0.0.1:1/nothing-here');

  await new Promise((resolve) => setTimeout(resolve, 20));

  const error = await failure(new Promise((_resolve, reject) => stream.on('error', reject)));

  assert.strictEqual(error.code, 'ECONNREFUSED');
});

// The stand-in duplex of a request `undici.pipeline` rejected outright, which nothing writes
// to either once it has failed.
test('an upload stream failure reaches an error listener that never writes', async () => {
  const upload = await client.stream('http://::invalid-url::', {method: 'POST'});

  const error = await failure(new Promise((_resolve, reject) => upload.on('error', reject)));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
});

/*
 * The other half of the same decision: an `error` emitted with nothing listening for it is an
 * uncaught exception, and `await stream.response` - which reports this very failure - attaches
 * no listener at all. So a stream no one is listening to keeps its failure until it is read,
 * and this test fails by taking the whole process down if that stops being true.
 */
test('a stream nobody listens to raises nothing on its own', async () => {
  const stream = await client.stream('http://127.0.0.1:1/nothing-here');

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(stream.destroyed, false);
  assert.strictEqual((await failure(stream.response)).code, 'ECONNREFUSED');
});

test('a connection failure on an upload stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const duplex = await recording.stream('http://127.0.0.1:1/nothing-here', {method: 'POST'});

  duplex.end('body');

  const error = await failure(text(duplex));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ECONNREFUSED');
  assert.deepStrictEqual(seen, ['ECONNREFUSED']);
});

test('the response promise of a failed upload stream rejects with the normalised error', async () => {
  const duplex = await client.stream('http://127.0.0.1:1/nothing-here', {method: 'POST'});

  duplex.end('body');
  duplex.resume();

  const error = await failure(duplex.response);

  // It used to reject with undici's raw error while the stream itself reported something else.
  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ECONNREFUSED');
});

test('timeout.request on an upload stream is a TimeoutError, not a DOMException', async () => {
  const {seen, recording} = hookRecorder();

  const duplex = await recording.stream('http://localhost:3000/slow', {method: 'POST', timeout: {request: 50}});

  duplex.end('body');

  const error = await failure(text(duplex));

  assert.ok(error instanceof TimeoutError, `expected a TimeoutError, got ${error}`);
  // Was the number 23 off a DOMException, which no caller matching on the documented codes
  // could ever have recognised.
  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.deepStrictEqual(seen, ['ETIMEDOUT']);
});

test('a truncated body on a bodyless stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const stream = await recording.stream('http://localhost:3000/truncate');

  // The head arrives fine - this only fails part-way through the body.
  assert.strictEqual((await stream.response).statusCode, 200);

  const error = await failure(text(stream));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  // undici describes this one itself, so its own code is what comes through.
  assert.deepStrictEqual(seen, ['UND_ERR_SOCKET']);
});

test('a truncated body on an upload stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const duplex = await recording.stream('http://localhost:3000/truncate', {method: 'POST'});

  duplex.end('body');

  const error = await failure(text(duplex));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.deepStrictEqual(seen, ['UND_ERR_SOCKET']);
});

test('stream.errored reports the normalised error, not undici’s raw one', async () => {
  const stream = await client.stream('http://localhost:3000/truncate');

  await failure(text(stream));

  // `errored` is public API and is latched before `_destroy` runs, so it has to be put back
  // in step with the error every listener saw.
  assert.ok(stream.errored instanceof RequestError, `expected a RequestError, got ${stream.errored}`);
});

test('a stream error surfaces the same way through stream.pipeline', async () => {
  const stream = await client.stream('http://localhost:3000/truncate');

  const error = await failure(
    pipeline(
      stream,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    ),
  );

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
});

test('beforeRetry fires and retryCount is reported on a stream', async () => {
  const testId = randomUUID();
  const seen: number[] = [];

  const retrying = client.extend({
    retry: {limit: 3, statusCodes: [429], backoffLimit: 10},
    hooks: {beforeRetry: [(_error, _statusCode, retryCount) => seen.push(retryCount)]},
  });

  const duplex = await retrying.stream('http://localhost:3000/retry', {headers: {'test-id': testId}});
  const head = await duplex.response;

  await text(duplex);

  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(head.retryCount, 2);
  assert.deepStrictEqual(seen, [1, 2]);
});

/*
 * undici follows redirects inside its own interceptor and never says where it ended up, so
 * `response.url` reported the url that *redirected* rather than the one that answered. got
 * documents `response.url` as the final url, and anything resolving a relative link or
 * logging provenance against it was silently given the wrong one.
 */
test('response.url is the final url after a followed redirect', async () => {
  const redirecting = client.extend({followRedirect: true, responseType: 'json'});

  const response = await redirecting.get<Echo>('http://localhost:3000/redirect-chain');

  assert.strictEqual(response.body.url, '/echo');
  assert.strictEqual(String(response.url), 'http://localhost:3000/echo');
});

test('response.url is the requested url when nothing redirected', async () => {
  const redirecting = client.extend({followRedirect: true});

  const response = await redirecting.get('http://localhost:3000/json');

  assert.strictEqual(String(response.url), 'http://localhost:3000/json');
});

test('a stream reports the final url too', async () => {
  const redirecting = client.extend({followRedirect: true});

  const stream = await redirecting.stream('http://localhost:3000/redirect-chain');
  const head = await stream.response;

  await text(stream);

  assert.strictEqual(String(head.url), 'http://localhost:3000/echo');
});

/*
 * A chain longer than `maxRedirections` leaves undici handing back the redirect itself. That
 * used to resolve as a *success* whose body was the redirect page - the caller got
 * `body: 'redirecting'` and no error at all. got throws here: its ok-range stops at 299 once
 * redirects are being followed.
 */
test('a redirect chain that exceeds the limit is an HTTPError', async () => {
  const redirecting = client.extend({followRedirect: true});

  const error = await failure(redirecting.get('http://localhost:3000/hop/0'));

  assert.strictEqual(error.code, 'ERR_HTTP_ERROR');
  assert.strictEqual(error.name, 'HTTPError');
  assert.strictEqual(error.response?.statusCode, 302);
});

test('an exceeded redirect chain still resolves with throwHttpErrors off', async () => {
  const redirecting = client.extend({followRedirect: true, throwHttpErrors: false});

  const response = await redirecting.get('http://localhost:3000/hop/0');

  assert.strictEqual(response.statusCode, 302);
  assert.strictEqual(response.ok, false);
});

test('a chain within the limit is followed to the end', async () => {
  const redirecting = client.extend({followRedirect: true});

  const response = await redirecting.get('http://localhost:3000/hop/15');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body, 'arrived');
  assert.strictEqual(String(response.url), 'http://localhost:3000/hop/20');
});

// A 3xx is only an error when redirects were being followed; not following them is how you
// ask to see the 302 yourself, and got draws the line the same way.
test('a 302 is not an error when redirects are not being followed', async () => {
  const response = await client.get('http://localhost:3000/redirect', {followRedirect: false});

  assert.strictEqual(response.statusCode, 302);
});

// got treats a 304 as ok whether or not it is following redirects - a conditional request
// answered "not modified" succeeded.
test('a 304 is not an error even when following redirects', async () => {
  const redirecting = client.extend({followRedirect: true});

  const response = await redirecting.get('http://localhost:3000/status-empty?code=304');

  assert.strictEqual(response.statusCode, 304);
});

/*
 * got keeps `username`/`password` on a `URL`, which node turns into an `Authorization` header.
 * undici does no such thing, so credentials written into the url were dropped and the request
 * went out anonymous - all the caller saw was a 401.
 */
test('credentials in the url become Basic auth', async () => {
  const response = await client.get<Echo>('http://alice:s3cret@localhost:3000/echo', {responseType: 'json'});

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('alice:s3cret').toString('base64'));

  // and the credentials are off the url by the time anything can read it back
  assert.strictEqual(String(response.url), 'http://localhost:3000/echo');
});

test('percent-encoded credentials in the url are decoded before being encoded', async () => {
  const response = await client.get<Echo>('http://al%40ice:p%3Aass@localhost:3000/echo', {responseType: 'json'});

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('al@ice:p:ass').toString('base64'));
});

test('an explicit username wins over the url', async () => {
  const response = await client.get<Echo>('http://alice:s3cret@localhost:3000/echo', {
    responseType: 'json',
    username: 'bob',
    password: 'other',
  });

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('bob:other').toString('base64'));
});

test('an `@` in the path is not mistaken for credentials', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo/@me', {responseType: 'json'});

  assert.strictEqual(response.body.url, '/echo/@me');
  assert.strictEqual(response.body.headers['authorization'], undefined);
});

/*
 * `parseUserinfo: false` opts out of the scan entirely, for a client whose urls never carry
 * credentials - the request then goes out exactly as undici would send it unassisted:
 * anonymous, the same as before this feature existed.
 */
test('parseUserinfo false skips parsing credentials out of the url', async () => {
  const noParse = client.extend({parseUserinfo: false});

  const response = await noParse.get<Echo>('http://alice:s3cret@localhost:3000/echo', {responseType: 'json'});

  assert.strictEqual(response.body.headers['authorization'], undefined);
});

test('explicit username/password still work with parseUserinfo false', async () => {
  const noParse = client.extend({parseUserinfo: false});

  const response = await noParse.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    username: 'bob',
    password: 'other',
  });

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('bob:other').toString('base64'));
});

test('parseUserinfo itself is client-only', async () => {
  // Read from the instance, so a per-request value would have done nothing at all.
  await assert.rejects(
    () => client.get('http://localhost:3000/json', {parseUserinfo: false}),
    (err: Error) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /only be set when creating or extending/);

      return true;
    },
  );
});

/*
 * The `afterResponse` loop used to sit outside both of `call()`'s trys, so a hook that threw
 * escaped as its own raw error - no `RequestError`, no `beforeError` hooks, invisible to any
 * caller matching on `instanceof RequestError`. got wraps this same loop.
 */
test('an afterResponse hook that throws becomes a RequestError with beforeError applied', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    hooks: {
      afterResponse: [
        () => {
          throw new TypeError('hook blew up');
        },
      ],
      beforeError: [
        (error) => {
          seen.push(error.code);

          return error;
        },
      ],
    },
  });

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.ok(error instanceof RequestError);
  assert.strictEqual(error.message, 'hook blew up');
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
  assert.deepStrictEqual(seen, ['ERR_REQUEST_ERROR']);
});

// Forgetting the `return` used to fail with `Cannot read properties of undefined (reading
// 'statusCode')`, naming neither the hook nor the request.
test('an afterResponse hook that returns nothing is reported clearly', async () => {
  const extClient = client.extend({
    hooks: {afterResponse: [() => undefined as unknown as GotlikeResponse]},
  });

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.ok(error instanceof RequestError);
  assert.match(error.message, /afterResponse.+invalid value/);
});

// An error the retry already normalised is rethrown as-is; wrapping it again would fire the
// `beforeError` hooks a second time for one failure.
test('a failure inside an afterResponse retry runs beforeError exactly once', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 200 ? retryWithMergedOptions({url: 'http://127.0.0.1:1'}) : response,
      ],
      beforeError: [
        (error) => {
          seen.push(error.code);

          return error;
        },
      ],
    },
  });

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.strictEqual(error.code, 'ECONNREFUSED');
  assert.strictEqual(seen.length, 1);
});

// The retry used to share the first attempt's context object, so a write on the retry changed
// what the first response reports having been sent with. Driven from the second hook, since
// only the hooks *before* the retrying one run again for the retried response.
test('an afterResponse retry gets its own context', async () => {
  const seen: Record<string, any>[] = [];

  const extClient = client.extend({
    context: {shared: 1},
    hooks: {
      afterResponse: [
        (response) => {
          seen.push(response.request.options.context);

          return response;
        },
        (response, retryWithMergedOptions) =>
          seen.length === 1 ? retryWithMergedOptions({context: {retried: true}}) : response,
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');

  assert.strictEqual(seen.length, 2);
  assert.notStrictEqual(seen[0], seen[1]);
  assert.deepStrictEqual(seen[0], {shared: 1});
  assert.deepStrictEqual(seen[1], {shared: 1, retried: true});
});

// `handle()` read `resolveBodyOnly` off the options the *caller* passed, so a handler that
// turned it on was ignored.
test('a handler can turn on resolveBodyOnly', async () => {
  const extClient = client.extend({
    handlers: [(options, next) => next({...options, resolveBodyOnly: true})],
  });

  const body = (await extClient.get('http://localhost:3000/json')) as unknown as string;

  // The body itself, not a Response - which is the whole point.
  assert.strictEqual(typeof body, 'string');
  assert.strictEqual(JSON.parse(body).test, 'value');
});

// One shared counter meant a handler calling `next` twice advanced past the handler after it.
test('a handler calling next twice does not skip the next handler', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    handlers: [
      async (options, next) => {
        const first = await next(options);

        seen.push('first');

        await next(options);

        seen.push('second');

        return first;
      },
      (options, next) => {
        seen.push('inner');

        return next(options);
      },
    ],
  });

  await extClient.get('http://localhost:3000/json');

  assert.deepStrictEqual(seen, ['inner', 'first', 'inner', 'second']);
});

// `String({})` produced `a=%5Bobject+Object%5D` - a wrong query string, sent without complaint.
test('an object searchParams value is rejected rather than stringified', async () => {
  const error = await failure(client.get('http://localhost:3000/echo', {searchParams: {a: {b: 1} as never}}));

  assert.match(error.message, /must be a string, number, boolean/);
});

test('an object form value is rejected too', async () => {
  const error = await failure(client.post('http://localhost:3000/echo', {form: {a: {b: 1} as never}}));

  assert.match(error.message, /must be a string, number, boolean/);
});

// `{'content-type': undefined}` is how "unset" reaches undici everywhere else, and counting it
// as already-set sent a json body with no content-type at all.
test('a header explicitly set to undefined does not suppress the derived content-type', async () => {
  const response = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    json: {a: 1},
    headers: {'content-type': undefined},
  });

  assert.strictEqual(response.body.headers['content-type'], 'application/json');
});

/*
 * `call()` captured the resolved url into a local *before* running the `beforeRequest` hooks
 * and handed that local to undici, so a hook rewriting `options.url` - which is exactly what
 * request signing does - was read by nothing and the original url went out anyway.
 */
test('a beforeRequest hook rewriting options.url changes where the request goes', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/rewritten';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/json');

  assert.strictEqual(response.body.url, '/echo/rewritten');
});

// A hook that leaves a relative url still gets `prefixUrl` applied.
test('a beforeRequest hook can rewrite to a path under prefixUrl', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'echo/from-prefix';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('json');

  assert.strictEqual(response.body.url, '/echo/from-prefix');
});

/*
 * A url a hook built for itself is taken exactly as written. Re-resolving it would lay
 * `searchParams` back over the top and wipe the query the hook had just signed.
 */
test('a rewritten absolute url keeps its own query against searchParams', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = String(options.url) + '&signature=abc';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/echo', {searchParams: {a: '1'}});

  assert.strictEqual(response.body.url, '/echo?a=1&signature=abc');
});

/*
 * An upstream answering an error status with a body that isn't the json that was asked for -
 * a proxy's HTML error page - used to fail as `ERR_BODY_PARSE_FAILURE` *before* the
 * `afterResponse` hooks ran, so a refresh hook never saw the status that triggers it.
 *
 * Measured against got 14: the hooks run, the body stays as the text that arrived, and the
 * HTTP error is what is thrown.
 */
test('an unparseable body on an error status runs afterResponse and throws HTTPError', async () => {
  const seen: number[] = [];

  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response) => {
          seen.push(response.statusCode);

          return response;
        },
      ],
    },
  });

  const error = await failure(extClient.get('http://localhost:3000/html-error?code=500'));

  assert.deepStrictEqual(seen, [500], 'the afterResponse hook must see the error status');
  assert.strictEqual(error.code, 'ERR_HTTP_ERROR');
  assert.strictEqual(error.name, 'HTTPError');
  assert.match(String(error.response?.body), /Gateway problem/);
});

// got resolves this one rather than raising a parse failure - the status was the problem, and
// with throwHttpErrors off the caller said they would handle it.
test('an unparseable body on an error status resolves with the raw text when not throwing', async () => {
  const extClient = client.extend({responseType: 'json', throwHttpErrors: false});

  const response = await extClient.get('http://localhost:3000/html-error?code=500');

  assert.strictEqual(response.statusCode, 500);
  assert.match(String(response.body), /Gateway problem/);
});

// On a status that is otherwise fine, a parse failure is still a ParseError.
test('an unparseable body on a 200 is still a ParseError', async () => {
  const error = await failure(client.get('http://localhost:3000/png', {responseType: 'json'}));

  assert.strictEqual(error.code, 'ERR_BODY_PARSE_FAILURE');
  assert.strictEqual(error.name, 'ParseError');
});

/*
 * A retry that supplies a url has not had `prefixUrl` applied to it yet, so clearing the prefix
 * unconditionally left a relative path to be dispatched as-is and fail as an invalid url.
 */
test('an afterResponse retry can use a path relative to prefixUrl', async () => {
  let retried = false;

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (!retried) {
            retried = true;

            return retryWithMergedOptions({url: 'echo/second-try'});
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('json');

  assert.strictEqual(response.body.url, '/echo/second-try');
});

test('an afterResponse retry can supply a new prefixUrl', async () => {
  let retried = false;

  const extClient = client.extend({
    prefixUrl: 'http://127.0.0.1:3000',
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (!retried) {
            retried = true;

            return retryWithMergedOptions({prefixUrl: 'http://localhost:3000', url: 'echo/new-prefix'});
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('json');

  assert.strictEqual(response.body.url, '/echo/new-prefix');
});

/*
 * A hook writing `options.headers.Authorization` on top of an `authorization` that is already
 * there left undici sending both, and which one the server honours is anyone's guess.
 */
test('a header a hook writes with different casing replaces the existing one', async () => {
  const extClient = client.extend({
    responseType: 'json',
    headers: {authorization: 'Bearer stale'},
    hooks: {
      beforeRequest: [
        (options) => {
          options.headers['Authorization'] = 'Bearer fresh';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(response.body.headers['authorization'], 'Bearer fresh');
});

// `(error as Error).message` threw a TypeError of its own when the thrown value wasn't an Error.
test('a beforeRequest hook throwing a non-Error still fails as a RequestError', async () => {
  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        () => {
          // The non-Error throw is what the test is about.
          // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error
          throw 'plain string failure';
        },
      ],
    },
  });

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.ok(error instanceof RequestError);
  assert.strictEqual(error.message, 'plain string failure');
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
  // Any value may be a `cause`, not only an `Error`. It used to be dropped for a thrown
  // primitive, which is the one case where the thrown value is all there is to keep.
  assert.strictEqual(error.cause, 'plain string failure');
});

// The other half: no underlying error means no `cause` at all, not one set to `undefined`.
test('an http error has no cause property', async () => {
  const error = await failure(client.get('http://localhost:3000/status?code=500'));

  assert.ok(error instanceof RequestError);
  assert.strictEqual('cause' in error, false);
});

test('a beforeRequest hook throwing null still fails as a RequestError', async () => {
  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        () => {
          // The non-Error throw is what the test is about.
          // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error
          throw null;
        },
      ],
    },
  });

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.ok(error instanceof RequestError);
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
});

// Replacing the object dropped the parent's `statusCodes`/`methods` along with it, silently
// widening what got retried.
test('extend merges retry options rather than replacing them', () => {
  const parent = new Gotlike({retry: {limit: 3, statusCodes: [503], backoffLimit: 10}});
  const childClient = parent.extend({retry: {limit: 1}});

  assert.strictEqual(childClient.retryOptions?.maxRetries, 1);
  assert.deepStrictEqual(childClient.retryOptions?.statusCodes, [503]);
  assert.strictEqual(childClient.retryOptions?.maxTimeout, 10);
});

/*
 * `abort(reason)` makes undici throw that reason verbatim, so the error is whatever the caller
 * passed and the name test alone reported a deliberate cancellation as a generic transport
 * failure.
 */
test('aborting with a custom reason is still an AbortError', async () => {
  const controller = new AbortController();

  const promise = client.get('http://localhost:3000/slow', {signal: controller.signal});

  controller.abort(new Error('cancelled by caller'));

  const error = await failure(promise);

  assert.strictEqual(error.name, 'AbortError');
  assert.strictEqual(error.code, 'ERR_ABORTED');
});

test('aborting with no reason is an AbortError', async () => {
  const controller = new AbortController();

  const promise = client.get('http://localhost:3000/slow', {signal: controller.signal});

  controller.abort();

  const error = await failure(promise);

  assert.strictEqual(error.name, 'AbortError');
  assert.strictEqual(error.code, 'ERR_ABORTED');
});

// An AbortSignal.timeout still has to read as a timeout, not as a plain abort - the abort test
// is the broader of the two and would otherwise swallow it.
test('a caller AbortSignal.timeout is still reported as a timeout', async () => {
  const error = await failure(client.get('http://localhost:3000/slow', {signal: AbortSignal.timeout(50)}));

  assert.strictEqual(error.name, 'TimeoutError');
  assert.strictEqual(error.code, 'ETIMEDOUT');
});

/*
 * The writable half used to accept and discard every chunk, so `pipeline(source, upload)`
 * *resolved successfully* for a request that was never sent.
 */
test('a failed upload stream fails writes instead of quietly discarding them', async () => {
  // An invalid url is rejected by `undici.pipeline` synchronously, which is the path that
  // hands back a stand-in duplex rather than a real one.
  const upload = await client.stream('http://::invalid-url::', {method: 'POST'});

  const error = await failure(pipeline(Readable.from(['chunk']), upload));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error?.constructor?.name}`);
});

test('a failed upload stream still reports on its response promise', async () => {
  const upload = await client.stream('http://::invalid-url::', {method: 'POST'});

  // Not read here: `response` rejects on its own, and reading would destroy the stream with
  // the same error, which needs a listener of its own like any other node stream.
  const error = await failure(upload.response);

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error?.constructor?.name}`);
});

// `for...in` walks the prototype chain, so anything adding an enumerable property to
// `Object.prototype` failed every request with `Unknown option`.
test('validation ignores inherited enumerable properties', async () => {
  // Writing to `Object.prototype` is the whole point here - it is what the offending library did.
  // oxlint-disable-next-line no-extend-native
  Object.defineProperty(Object.prototype, 'injectedBySomeLibrary', {
    value: 'x',
    enumerable: true,
    configurable: true,
  });

  try {
    const response = await client.get('http://localhost:3000/json');

    assert.strictEqual(response.statusCode, 200);
  } finally {
    delete (Object.prototype as Record<string, unknown>)['injectedBySomeLibrary'];
  }
});

// got's export takes `got({url, ...})` as well as `got(url, options)`.
test('the client can be called with an options object alone', async () => {
  const response = await client({url: 'http://localhost:3000/echo', method: 'POST', responseType: 'json'});

  assert.strictEqual((response.body as Echo).url, '/echo');
  assert.strictEqual((response.body as Echo).method, 'POST');
});

/*
 * The review findings, each with the got-14 measurement behind it.
 *
 * `searchParams` is the one option a client can set that a per-request one used to erase
 * outright: `{...base, ...options}` replaces it wholesale, so a client carrying an api key
 * or a tenant id in its query lost it the moment a call named a parameter of its own. got
 * merges the two (`Options.searchParams`, `this._merging`) - measured against got 14, an
 * `extend({searchParams: {apiKey, v}})` plus `get('items', {searchParams: {page: 2}})` goes
 * out as `?apiKey=secret&v=1&page=2`.
 */
test('a per-request searchParams merges with the client’s rather than replacing it', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    searchParams: {apiKey: 'secret', v: '1'},
  });

  const inherited = await extClient.get<Echo>('echo');
  const merged = await extClient.get<Echo>('echo', {searchParams: {page: 2}});

  assert.strictEqual(inherited.body.url, '/echo?apiKey=secret&v=1');
  assert.strictEqual(merged.body.url, '/echo?apiKey=secret&v=1&page=2');
});

// got deletes every occurrence of a key the override names before appending it, so the
// replaced key ends up last rather than in the client's original position.
test('a per-request searchParams key replaces the client’s, exactly once', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    searchParams: {apiKey: 'secret', v: '1'},
  });

  const response = await extClient.get<Echo>('echo', {searchParams: {apiKey: 'override'}});

  assert.strictEqual(response.body.url, '/echo?v=1&apiKey=override');
});

// got's spelling of "drop the one the client set": the key is deleted from the base and
// nothing is appended, since `undefined` is not a value.
test('an undefined per-request searchParams value drops the client’s', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    searchParams: {apiKey: 'secret', v: '1'},
  });

  const response = await extClient.get<Echo>('echo', {searchParams: {apiKey: undefined}});

  assert.strictEqual(response.body.url, '/echo?v=1');
});

test('extend merges searchParams with the parent’s', async () => {
  const parent = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    searchParams: {apiKey: 'secret', v: '1'},
  });

  const child = parent.extend({searchParams: {tenant: 'acme'}});

  const response = await child.get<Echo>('echo');

  // The parent is untouched by the child's merge.
  const parentResponse = await parent.get<Echo>('echo');

  assert.strictEqual(response.body.url, '/echo?apiKey=secret&v=1&tenant=acme');
  assert.strictEqual(parentResponse.body.url, '/echo?apiKey=secret&v=1');
});

test('searchParams merge across strings and URLSearchParams too', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    searchParams: 'a=1&b=2',
  });

  const response = await extClient.get<Echo>('echo', {searchParams: new URLSearchParams({b: '3', c: '4'})});

  assert.strictEqual(response.body.url, '/echo?a=1&b=3&c=4');
});

// The merged query still replaces whatever the url carried, as an unmerged one does.
test('a merged searchParams still replaces a query already on the url', async () => {
  const extClient = client.extend({prefixUrl: 'http://localhost:3000', responseType: 'json', searchParams: {a: '1'}});

  const response = await extClient.get<Echo>('echo?old=9', {searchParams: {b: '2'}});

  assert.strictEqual(response.body.url, '/echo?a=1&b=2');
});

// An `afterResponse` retry is a merge like any other, so the hook's parameters join the
// ones the request already carried rather than wiping them.
test('a searchParams supplied by an afterResponse retry merges with the request’s', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    searchParams: {apiKey: 'secret'},
    hooks: {
      afterResponse: [
        (response, retry) =>
          (response.body as Echo).url.includes('retried') ? response : retry({searchParams: {retried: '1'}}),
      ],
    },
  });

  const response = await extClient.get<Echo>('echo', {searchParams: {page: '2'}});

  assert.strictEqual(response.body.url, '/echo?apiKey=secret&page=2&retried=1');
});

/*
 * `timeout` is an object, so the shallow spread replaced it whole: extending with a partial
 * one - `{}`, or the `{request: config.timeout}` of a config that didn't set one - dropped
 * the parent's deadline and left the client with no timeout at all. Only `request` is
 * supported here, so merging matters exactly when the override doesn't name it.
 */
test('extend keeps the parent’s timeout when the override names none', () => {
  const parent = client.extend({timeout: {request: 5000}});

  assert.strictEqual(parent.extend({timeout: {}}).baseOptions.timeout?.request, 5000);
  assert.strictEqual(parent.extend({timeout: {request: undefined}}).baseOptions.timeout?.request, 5000);
  assert.strictEqual(parent.extend({timeout: {request: 100}}).baseOptions.timeout?.request, 100);
});

test('a per-request timeout that names no request keeps the client’s', async () => {
  const extClient = client.extend({timeout: {request: 50}});

  const error = await failure(extClient.get('http://localhost:3000/slow', {timeout: {request: undefined}}));

  assert.strictEqual(error.code, 'ETIMEDOUT');
});

/*
 * got's `got.stream.post(url, options)` shorthand - the verb helpers live on `stream` there
 * as they do on the client itself. Calling one used to be a `TypeError`, which is a hard
 * stop for anything migrating that writes it the got way.
 */
test('stream carries the verb helpers got puts on it', async () => {
  const download = await client.stream.get('http://localhost:3000/json');

  assert.strictEqual(await text(download), '{"test": "value"}\n');

  const upload = await client.stream.post('http://localhost:3000/echo');

  upload.end('through-stream-post');

  const echo = JSON.parse(await text(upload)) as Echo;

  assert.strictEqual(echo.method, 'POST');
  assert.strictEqual(echo.body, 'through-stream-post');
});

test('the stream verbs take options and hooks like any other call', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    hooks: {beforeRequest: [(options) => void (options.headers['x-hooked'] = 'yes')]},
  });

  const stream = await extClient.stream.get('headers', {headers: {'x-extra': 'here'}});

  const headers = JSON.parse(await text(stream)) as Record<string, string>;

  assert.strictEqual(headers['x-hooked'], 'yes');
  assert.strictEqual(headers['x-extra'], 'here');
});

test('stream.put, stream.patch, stream.delete and stream.query send their method', async () => {
  for (const method of ['put', 'patch', 'delete', 'query'] as const) {
    const upload = await client.stream[method]('http://localhost:3000/echo');

    upload.end('payload');

    const echo = JSON.parse(await text(upload)) as Echo;

    assert.strictEqual(echo.method, method.toUpperCase());
    assert.strictEqual(echo.body, 'payload');
  }
});

// Each client gets its own, bound to itself - `stream` is a getter rather than a method now,
// and reading it twice must not hand back two different things.
test('stream is the same object on each read and belongs to its own client', async () => {
  const extClient = client.extend({prefixUrl: 'http://localhost:3000'});

  assert.strictEqual(extClient.stream, extClient.stream);
  assert.notStrictEqual(extClient.stream, client.stream);

  assert.strictEqual(await text(await extClient.stream.get('json')), '{"test": "value"}\n');
});

/*
 * Two behaviours the review called corruption, both measured against got 14. They are locked
 * down here so a well-meaning "fix" has to argue with the measurement rather than with a
 * comment.
 *
 * Note the qualifier the parity suite added: the url append matches got only when no
 * `searchParams` is set. With one, gotlike re-resolves the url from it on each attempt and the
 * append does not accumulate, where got's does - see `src/parity/parity.spec.ts`, which pins
 * both halves.
 *
 * A `beforeRequest` hook that appends to `options.url` runs again on the retry, over the url
 * the first attempt went out with: got 14 sends `/items?sig=x` then `/items?sig=x&sig=x`.
 */
test('a retry re-runs the beforeRequest hooks over the url the first attempt used, as got does', async () => {
  const urls: string[] = [];
  let retried = false;

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      beforeRequest: [
        (options) => {
          const url = String(options.url);

          options.url = url + (url.includes('?') ? '&' : '?') + 'sig=x';
          urls.push(String(options.url));
        },
      ],
      afterResponse: [
        (response, retry) => {
          if (retried) {
            return response;
          }

          retried = true;

          return retry({headers: {'x-retried': 'yes'}});
        },
      ],
    },
  });

  await extClient.get<Echo>('echo');

  assert.deepStrictEqual(urls, ['http://localhost:3000/echo?sig=x', 'http://localhost:3000/echo?sig=x&sig=x']);
});

/*
 * The same request with `searchParams`: the query is rebuilt from the option on every
 * attempt, so a hook that signs the url signs a clean one each time rather than compounding.
 */
test('a retry rebuilds the query from searchParams before the hooks run', async () => {
  const urls: string[] = [];
  let retried = false;

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = String(options.url) + '&sig=x';
          urls.push(String(options.url));
        },
      ],
      afterResponse: [
        (response, retry) => {
          if (retried) {
            return response;
          }

          retried = true;

          return retry({headers: {'x-retried': 'yes'}});
        },
      ],
    },
  });

  await extClient.get<Echo>('echo', {searchParams: {page: '1'}});

  assert.deepStrictEqual(urls, ['http://localhost:3000/echo?page=1&sig=x', 'http://localhost:3000/echo?page=1&sig=x']);
});

/*
 * A hook that transforms `options.body` sees the first attempt's transformed body again on a
 * retry when the caller passed `body` - which is what got 14 does too (measured: `<PAY>` then
 * `<<PAY>>`). A caller who passed `json` gets the body re-serialised from it each time, so
 * the transformation is applied once per attempt.
 */
test('a retry re-serialises json rather than re-transforming the first attempt\u2019s body', async () => {
  const bodies: string[] = [];
  let retried = false;

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      beforeRequest: [
        (options) => {
          options.body = '<' + String(options.body) + '>';
          bodies.push(options.body);
        },
      ],
      afterResponse: [
        (response, retry) => {
          if (retried) {
            return response;
          }

          retried = true;

          return retry({headers: {'x-retried': 'yes'}});
        },
      ],
    },
  });

  await extClient.post<Echo>('echo', {json: {a: 1}});

  assert.deepStrictEqual(bodies, ['<{"a":1}>', '<{"a":1}>']);
});

test('a retry re-transforms a raw body the hook already touched, as got does', async () => {
  const bodies: string[] = [];
  let retried = false;

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      beforeRequest: [
        (options) => {
          options.body = '<' + String(options.body) + '>';
          bodies.push(options.body);
        },
      ],
      afterResponse: [
        (response, retry) => {
          if (retried) {
            return response;
          }

          retried = true;

          return retry({headers: {'x-retried': 'yes'}});
        },
      ],
    },
  });

  await extClient.post<Echo>('echo', {body: 'PAY'});

  assert.deepStrictEqual(bodies, ['<PAY>', '<<PAY>>']);
});

/*
 * Type-level assertions.
 *
 * `npm test` runs through node's type stripping, which erases types without checking them -
 * so these are enforced by `npm run typecheck`, which includes the spec files. The function
 * is never invoked; referencing it is enough to have `tsc` check the body.
 */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const expectType =
  <Expected>() =>
  <Actual>(_actual: Exact<Actual, Expected> extends true ? Actual : never): void => {};

async function typeAssertions() {
  type Thing = {id: number};

  // got's idiom: the body type comes from the call.
  expectType<Thing>()((await client.get<Thing>('u')).body);
  expectType<Thing>()((await client<Thing>('u')).body);
  expectType<Thing>()((await client.post<Thing>('u', {json: {a: 1}})).body);
  expectType<Thing>()((await client.query<Thing>('u', {json: {a: 1}})).body);
  expectType<Thing>()((await client.extend({prefixUrl: 'p'}).get<Thing>('u')).body);
  expectType<Thing>()((await new Gotlike({prefixUrl: 'p'}).get<Thing>('u')).body);
  expectType<Thing>()((await createClient({prefixUrl: 'p'}).get<Thing>('u')).body);

  // An extended client's own `responseType` settles the body type for calls that stay quiet,
  // the way got's does - this used to claim `Response<string>` while handing back an object.
  const jsonClient = client.extend({responseType: 'json'});
  const bufferClient = client.extend({responseType: 'buffer'});
  const bodyOnlyClient = client.extend({responseType: 'json', resolveBodyOnly: true});

  expectType<unknown>()((await jsonClient.get('u')).body);
  expectType<unknown>()((await jsonClient.get('u', {})).body);
  expectType<unknown>()((await jsonClient.get('u', {prefixUrl: 'p'})).body);
  expectType<Buffer>()((await bufferClient.get('u')).body);
  expectType<Thing>()((await jsonClient.get<Thing>('u')).body);
  expectType<unknown>()(await jsonClient.get('u', {resolveBodyOnly: true}));
  expectType<Thing>()(await bodyOnlyClient.get<Thing>('u'));
  expectType<unknown>()(await bodyOnlyClient.get('u'));
  // An explicit per-call `responseType` still wins over the client's.
  expectType<string>()((await jsonClient.get('u', {responseType: 'text'})).body);
  // ...and it survives another extend.
  expectType<unknown>()((await jsonClient.extend({prefixUrl: 'p'}).get('u')).body);
  expectType<string>()((await jsonClient.extend({responseType: 'text'}).get('u')).body);

  // `responseType` settles it when the caller doesn't.
  expectType<string>()((await client.get('u')).body);
  expectType<string>()((await client.get('u', {responseType: 'text'})).body);
  expectType<Buffer>()((await client.get('u', {responseType: 'buffer'})).body);
  expectType<Thing>()((await client.get<Thing>('u', {responseType: 'json'})).body);

  // `resolveBodyOnly` resolves with the body itself - it used to claim a whole `Response`.
  expectType<Thing>()(await client.get<Thing>('u', {resolveBodyOnly: true, responseType: 'json'}));
  expectType<string>()(await client.get('u', {resolveBodyOnly: true}));
  expectType<Buffer>()(await client.get('u', {resolveBodyOnly: true, responseType: 'buffer'}));

  expectType<Buffer>()((await client.get('u')).rawBody);
  expectType<number>()((await client.get('u')).retryCount);
  expectType<number>()((await (await client.stream('u')).response).retryCount);
}

void typeAssertions;

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import zlib from 'node:zlib';
import {clearInterval} from 'node:timers';
import {Writable} from 'node:stream';
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

  if (req.url === '/redirect') {
    res.statusCode = 302;
    res.statusMessage = 'Found';
    res.setHeader('Location', '/json');

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

test.before(() => {
  server.listen(3000);
});

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

  child.baseOptions.handlers!.push((options, next) => next(options));
  child.baseOptions.hooks!.beforeRequest!.push(() => undefined);
  child.baseOptions.context!.tenant = 'child';

  assert.strictEqual(parent.baseOptions.handlers!.length, 1);
  assert.strictEqual(parent.baseOptions.hooks!.beforeRequest!.length, 1);
  assert.strictEqual(parent.baseOptions.context!.tenant, 'parent');
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

  assert.strictEqual(attempts, 2);
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

  assert.strictEqual(err.code, 'ERR_REQUEST_ERROR');
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
  const body = (await client.get<Buffer>('http://localhost:3000/png', {
    responseType: 'buffer',
    resolveBodyOnly: true,
  })) as unknown as Buffer;

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
  })) as unknown as {test: string};

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
  })) as unknown as {test: string};

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
  const body = (await client<Buffer>('http://localhost:3000/png', {
    responseType: 'buffer',
    resolveBodyOnly: true,
  })) as unknown as Buffer;

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
    assert.ok(Object.getOwnPropertyDescriptor(callable, key)?.get, `${key} should forward to the instance`);
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

  assert.strictEqual(refused.code, 'ERR_REQUEST_ERROR');
  assert.match(refused.message, /ECONNREFUSED/);
  assert.notStrictEqual(refused.message, 'Request error');

  const malformed = await failure(client.get('not-a-url'));

  assert.strictEqual(malformed.code, 'ERR_REQUEST_ERROR');
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

test('an afterResponse hook that always retries fails instead of recursing forever', async () => {
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

  const error = await failure(extClient.get('http://localhost:3000/json'));

  assert.strictEqual(error.code, 'ERR_TOO_MANY_RETRIES');
  assert.ok(calls < 50, `expected a bounded number of retries, got ${calls}`);
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
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
  assert.deepStrictEqual(seen, ['ERR_REQUEST_ERROR']);
  // The underlying reason survives onto `message`, not just onto `cause`.
  assert.match(error.message, /ECONNREFUSED/);
});

test('a connection failure on an upload stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const duplex = await recording.stream('http://127.0.0.1:1/nothing-here', {method: 'POST'});

  duplex.end('body');

  const error = await failure(text(duplex));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
  assert.deepStrictEqual(seen, ['ERR_REQUEST_ERROR']);
});

test('the response promise of a failed upload stream rejects with the normalised error', async () => {
  const duplex = await client.stream('http://127.0.0.1:1/nothing-here', {method: 'POST'});

  duplex.end('body');
  duplex.resume();

  const error = await failure(duplex.response);

  // It used to reject with undici's raw error while the stream itself reported something else.
  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.strictEqual(error.code, 'ERR_REQUEST_ERROR');
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
  assert.deepStrictEqual(seen, ['ERR_REQUEST_ERROR']);
});

test('a truncated body on an upload stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const duplex = await recording.stream('http://localhost:3000/truncate', {method: 'POST'});

  duplex.end('body');

  const error = await failure(text(duplex));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.deepStrictEqual(seen, ['ERR_REQUEST_ERROR']);
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

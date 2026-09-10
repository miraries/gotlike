import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import zlib from 'node:zlib';
import {clearInterval} from 'node:timers';
import {Duplex, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {text} from 'node:stream/consumers';
import {randomUUID} from 'node:crypto';
import {getGlobalDispatcher, MockAgent, setGlobalDispatcher} from 'undici';
import nock from './nock';
import client, {Gotlike, HTTPError, ParseError, RequestError, TimeoutError} from './index';

const requestCounts: Record<string, number> = {};

const serverState: { retryCounts: Record<string, number> } = {
  retryCounts: {
    default: 0,
  }
};

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  // req.on('data', (...data) => {
  //   console.log('reqdata', data.toString());
  // });
  if (req.url === '/json') {
    res.write('{"test": "value"}\n');
    res.end();

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
      res.end(JSON.stringify({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }));
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
    res.statusCode = Number(qs.get('code')) ?? 200;
    res.statusMessage = qs.get('message') ?? 'OK';

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
  const response = await client.get<{ test: string }>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response.body.test, 'value');
});

test('returns error on parse failure', async () => {
  await assert.rejects(async () => {
    await client.get('http://localhost:3000/text', {
      responseType: 'json',
    });
  }, {
    code: 'ERR_BODY_PARSE_FAILURE'
  })
});

test('body is available as string on parse failure', async () => {
  const err = await client.get('http://localhost:3000/text', {
    responseType: 'json',
  }).catch(err => err);

  assert.strictEqual(err.response.body, 'hello\n');
});

test('throws error on timeout', async () => {
  await assert.rejects(async () => {
    await client.get('http://localhost:3000/timeout', {
      responseType: 'json',
      timeout: {
        request: 100,
      },
    });
  }, {
    code: 'ETIMEDOUT'
  });
});

/**
 * undici arms headers/body timeouts on its coarse timer wheel (lib/util/timers.js,
 * RESOLUTION_MS = 1000), so anything under a second is effectively a one second
 * timeout. Documented as a test so the floor isn't rediscovered the hard way.
 */
test('sub-second timeouts are floored to roughly one second', async () => {
  const start = process.hrtime.bigint();

  await assert.rejects(
    () => client.get('http://localhost:3000/timeout', {timeout: {request: 50}}),
    {code: 'ETIMEDOUT'},
  );

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.ok(elapsedMs > 900, `expected the 50ms timeout to be floored, fired after ${elapsedMs}ms`);
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
    }
  });

  const response = await extClient.get<{ foo: string }>('http://localhost:3000/headers', {
    responseType: 'json',
  });

  assert.strictEqual(response.body.foo, 'bar');
});

test('extend client twice', async () => {
  const extClient = client.extend({
    headers: {
      foo: 'bar',
    }
  }).extend({
    responseType: 'text',
  });

  const response = await extClient.get('http://localhost:3000/headers');

  assert(typeof response.body === 'string');
  assert.match(response.body, /"foo":"bar"/);
});

test('extend client with handler', async () => {
  const order: string[] = [];

  // @ts-ignore - fixme
  const handler1 = (options, next) => {
    order.push('before request');

    options.headers = {
      test: 'value',
    };

    return next(options);
  };

  // @ts-ignore - fixme
  const handler2 = async (options, next) => {
    try {
      const response = await next(options);

      order.push('after request');

      response.ok = true;

      return response;
    } catch (err) {

      throw err;
    }
  };

  const extClient = client.extend({
    handlers: [handler1, handler2]
  });

  const response = await extClient.get('http://localhost:3000/json');

  order.push('after response');

  assert.deepStrictEqual(order, ['before request', 'after request', 'after response']);
  assert.strictEqual(response.statusCode, 200);
});

test('extend client with hook', async () => {
  const extClient = client.extend({
    hooks: {
      afterResponse: [(response) => {
        if (response.headers) {
          response.headers['test'] = 'value';
        }

        return response;
      }],
    }
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
        async () => { order.push('before 1'); },
        async () => { order.push('before 2'); },
      ],
      afterResponse: [
        async (response) => { order.push('after 1'); return response; },
        async (response) => { order.push('after 2'); return response; },
      ],
    },
  });

  await extClient.get('http://localhost:3000/json');

  assert.deepStrictEqual(order, ['before 1', 'before 2', 'after 1', 'after 2']);
});

test('extend concatenates hooks with the parent client\'s', async () => {
  const order: string[] = [];

  const parent = client.extend({
    hooks: {beforeRequest: [() => { order.push('parent'); }]},
  });
  const child = parent.extend({
    hooks: {beforeRequest: [() => { order.push('child'); }]},
  });

  await child.get('http://localhost:3000/json');

  assert.deepStrictEqual(order, ['parent', 'child']);
});

test('beforeRequest can mutate headers and sees the resolved url and body', async () => {
  const seen: {url?: unknown, body?: unknown, method?: unknown} = {};

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    hooks: {
      beforeRequest: [(options) => {
        seen.url = options.url;
        seen.body = options.body;
        seen.method = options.method;
        options.headers['x-signature'] = 'signed';
      }],
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
      afterResponse: [(response) => {
        seenStatus = response.statusCode;

        return response;
      }],
    },
  });

  await assert.rejects(
    () => extClient.get('http://localhost:3000/status?code=401'),
    {code: 'ERR_HTTP_ERROR'},
  );

  assert.strictEqual(seenStatus, 401);
});

test('afterResponse can retry with merged options', async () => {
  let attempts = 0;

  const extClient = client.extend({
    responseType: 'json',
    context: {brandId: 7},
    hooks: {
      afterResponse: [async (response, retryWithMergedOptions) => {
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
      }],
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
      afterResponse: [async (response, retryWithMergedOptions) => {
        if (response.statusCode === 401) {
          return retryWithMergedOptions({headers: {authorization: 'Bearer refreshed'}});
        }

        return response;
      }],
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

test('hooks passed to a single call are ignored', async () => {
  let called = false;

  await client.get('http://localhost:3000/json', {
    hooks: {beforeRequest: [() => { called = true; }]},
  });

  assert.strictEqual(called, false);
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

  const response = await extClient2.get<{ foo: string, foo2: string }>('http://localhost:3000/headers');

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

  const response = await extClient.get<{ foo: string, foo2: string }>('http://localhost:3000/headers', {
    headers: {
      foo2: 'bar2'
    },
  });

  assert.strictEqual(response.body.foo, 'bar');
  assert.strictEqual(response.body.foo2, 'bar2');
  assert.strictEqual(response.statusCode, 200);
});

test('throw error on non-2xx if throwHttpErrors is true', () => {
  assert.rejects(async () => {
    await client.get('http://localhost:3000/status?code=403&message=Forbidden');
  }, {
    code: 'ERR_HTTP_ERROR',
    message: 'Response code 403',
  })
});

test('don\'t throw error on non-2xx if throwHttpErrors is false', async () => {
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
  const response = await client.get('http://localhost:3000/redirect', {
    followRedirect: true,
    responseType: 'text',
  });

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

  const err = await text(duplex).catch(e => e as Error);

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

  const err = await duplex.response.catch(e => e as Error);

  assert.ok(err instanceof Error);

  // the same failure surfaces on the stream itself
  await text(duplex).catch(() => undefined);
});

test('stream runs handlers and beforeRequest hooks', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    handlers: [(options, next) => {
      seen.push('handler');

      return next(options);
    }],
    hooks: {
      beforeRequest: [(options) => {
        seen.push('hook');
        options.headers['x-streamed'] = 'yes';
      }],
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
    }
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

  await assert.rejects(
    () => extClient.get('http://localhost:3000/retry'),
    {code: 'ERR_HTTP_ERROR'},
  );
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
  const {Gotlike} = await import('./index');
  const freshClient = new Gotlike({responseType: 'text'});

  const previous = getGlobalDispatcher();
  const agent = new MockAgent();

  agent.get('http://localhost:3001')
    .intercept({method: 'GET', path: '/late'})
    .reply(200, 'from the late dispatcher');

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

  const err = await extClient.get('http://localhost:3000/unauthorized').catch(e => e as RequestError);

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
  const err = await client.get('http://localhost:3000/text', {
    responseType: 'json',
  }).catch(e => e as RequestError);

  assert.strictEqual(err.code, 'ERR_BODY_PARSE_FAILURE');
  assert.strictEqual(err.response?.body, 'hello\n');
  assert.strictEqual(err.response?.statusCode, 200);
  assert.ok(err.cause instanceof SyntaxError);
});

test('timeout error preserves the underlying undici error as cause', async () => {
  const err = await client.get('http://localhost:3000/timeout', {
    timeout: {request: 100},
  }).catch(e => e as RequestError);

  assert.strictEqual(err.code, 'ETIMEDOUT');
  assert.strictEqual(err.cause instanceof Error, true);
  assert.strictEqual((err.cause as Error & {code: string}).code, 'UND_ERR_HEADERS_TIMEOUT');
  // Nothing was received, so there is no response to attach.
  assert.strictEqual(err.response, undefined);
});

test('connection error has no response and preserves the cause', async () => {
  const err = await client.get('http://localhost:3999/nothing-listening')
    .catch(e => e as RequestError);

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

  for (const [prefix, path] of [['http://localhost:3000/api', 'thing'], ['http://localhost:3000/api/', '/thing']] as const) {
    const seen: string[] = [];
    const probe = client.extend({
      prefixUrl: prefix,
      responseType: 'json',
      hooks: {beforeRequest: [(options) => { seen.push(options.url as string); }]},
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

  const response = await extClient.get<{ test: string }>('http://localhost:3000/json');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.test, 'value');
  assert.strictEqual(response.request.options.url, 'http://localhost:3000/json');
});

test('context is shallow-merged over the instance context', async () => {
  const seen: Record<string, any>[] = [];

  const extClient = client.extend({
    context: {service: 'test', keep: true},
    hooks: {beforeRequest: [(options) => { seen.push(options.context); }]},
  });

  await extClient.get('http://localhost:3000/json', {context: {service: 'override'}});

  assert.deepStrictEqual(seen[0], {service: 'override', keep: true});
});

test('context reads as empty when none was set', async () => {
  const seen: Record<string, any>[] = [];

  const extClient = client.extend({
    hooks: {beforeRequest: [(options) => { seen.push(options.context); }]},
  });

  await extClient.get('http://localhost:3000/json');

  assert.deepStrictEqual(seen[0], {});
  assert.strictEqual(seen[0].anything, undefined);
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

type Echo = {url: string, method: string, headers: Record<string, string>, body: string};

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
  const advertised = auto.body.headers['accept-encoding'].split(', ');

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
  }) as unknown as Buffer;

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

  assert.strictEqual(requestCounts['/counted'] - before, 1);
});

test('without dedupe every concurrent request reaches the server', async () => {
  const before = requestCounts['/counted'] ?? 0;

  const extClient = new Gotlike({responseType: 'json'});

  await Promise.all([
    extClient.get('http://localhost:3000/counted'),
    extClient.get('http://localhost:3000/counted'),
  ]);

  assert.strictEqual(requestCounts['/counted'] - before, 2);
});

test('cache serves a second request from the cache', async () => {
  const before = requestCounts['/cacheable'] ?? 0;

  const extClient = new Gotlike({responseType: 'json', cache: true});

  await extClient.get('http://localhost:3000/cacheable');
  await extClient.get('http://localhost:3000/cacheable');

  assert.strictEqual(requestCounts['/cacheable'] - before, 1);
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

test('followRedirect false on the client skips the redirect interceptor', async () => {
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
  const text = await client.get('http://localhost:3000/json');

  assert.ok(Buffer.isBuffer(text.rawBody));
  assert.strictEqual(text.rawBody.toString(), '{"test": "value"}\n');

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

  const err = await extClient.get('http://localhost:3000/retry').catch(e => e as RequestError);

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

  assert.strictEqual(
    response.body.headers['authorization'],
    'Basic ' + Buffer.from('apikey:').toString('base64'),
  );
});

test('errors use named classes and stay instanceof RequestError', async () => {
  const httpError = await client.get('http://localhost:3000/status?code=500').catch(e => e as Error);

  assert.ok(httpError instanceof HTTPError);
  assert.ok(httpError instanceof RequestError);
  assert.strictEqual(httpError.name, 'HTTPError');
  assert.strictEqual((httpError as HTTPError).code, 'ERR_HTTP_ERROR');

  const timeoutError = await client.get('http://localhost:3000/timeout', {
    timeout: {request: 100},
  }).catch(e => e as Error);

  assert.ok(timeoutError instanceof TimeoutError);
  assert.ok(timeoutError instanceof RequestError);
  assert.strictEqual(timeoutError.name, 'TimeoutError');

  const parseError = await client.get('http://localhost:3000/text', {
    responseType: 'json',
  }).catch(e => e as Error);

  assert.ok(parseError instanceof ParseError);
  assert.ok(parseError instanceof RequestError);
  assert.strictEqual(parseError.name, 'ParseError');

  const connectionError = await client.get('http://localhost:3999/nope').catch(e => e as Error);

  assert.ok(connectionError instanceof RequestError);
  assert.ok(!(connectionError instanceof HTTPError));
  assert.strictEqual(connectionError.name, 'RequestError');
});

test('beforeRetry fires for each retry with the failed attempt details', async () => {
  const seen: {statusCode?: number, retryCount: number}[] = [];

  const extClient = client.extend({
    headers: {'test-id': randomUUID()},
    retry: {limit: 3, backoffLimit: 10},
    hooks: {
      beforeRetry: [(_error, statusCode, retryCount) => {
        seen.push({statusCode, retryCount});
      }],
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
    hooks: {beforeRetry: [(error) => { seen.push(error); }]},
  });

  await extClient.get('http://localhost:3999/nope').catch(() => undefined);

  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0] instanceof Error);
});

test('beforeRetry does not fire when nothing is retried', async () => {
  let calls = 0;

  const extClient = client.extend({
    retry: {limit: 3, backoffLimit: 10},
    hooks: {beforeRetry: [() => { calls++; }]},
  });

  await extClient.get('http://localhost:3000/json');

  assert.strictEqual(calls, 0);
});

/**
 * undici's decompress interceptor skips error responses by default; got does not. A gzipped
 * error body is exactly what error handling needs to read, so the default is overridden.
 */
test('error responses are decompressed too', async () => {
  const err = await client.get('http://localhost:3000/gzip-error', {
    responseType: 'json',
  }).catch(e => e as RequestError);

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
    handlers: [async (options, next) => {
      const response = await next(options);

      seen.push(response.timings.phases.total);
      seen.push(response.statusCode);

      return response;
    }],
  });

  const body = await extClient.get('http://localhost:3000/json', {
    resolveBodyOnly: true,
  }) as unknown as {test: string};

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
      afterResponse: [(response) => {
        statusCode = response.statusCode;

        return response;
      }],
    },
  });

  const body = await extClient.get('http://localhost:3000/json', {
    resolveBodyOnly: true,
  }) as unknown as {test: string};

  assert.strictEqual(statusCode, 200);
  assert.deepStrictEqual(body, {test: 'value'});
});

test('nock mocks request once', async () => {
  nock('http://localhost:3000')
    .get('/json')
    .reply(201, '{"test": "newvalue"}');

  const response = await client.get<{ test: string }>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response.statusCode, 201);
  assert.strictEqual(response.body.test, 'newvalue');

  const response2 = await client.get<{ test: string }>('http://localhost:3000/json', {
    responseType: 'json',
  });

  assert.strictEqual(response2.body.test, 'value');
});

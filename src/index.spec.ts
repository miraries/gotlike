import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import {clearInterval} from 'node:timers';
import {Duplex} from 'node:stream';
import {randomUUID} from 'node:crypto';
import nock from './nock';
import client from './index';

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
    setTimeout(() => {
      res.write('hello\n');
      res.end();
    }, 500);

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

test('throws error on timeout', () => {
  assert.rejects(async () => {
    await client.get('http://localhost:3000/timeout', {
      responseType: 'json',
      timeout: {
        request: 100,
      },
    });
  }, {
    code: 'ETIMEDOUT'
  })
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
      afterResponse(response, _options) {
        if (response.headers) {
          response.headers['test'] = 'value';
        }
      }
    }
  });

  const response = await extClient.get('http://localhost:3000/json');

  assert.strictEqual(response.headers['test'], 'value');

  assert.strictEqual(response.statusCode, 200);
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
  const response = await client.get('http://localhost:3000/redirect');

  assert.strictEqual(response.statusCode, 200);
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
  const duplex = await client.stream('http://localhost:3000/stream') as unknown as Duplex;

  let response = '';

  duplex.on('data', (data) => {
    response += data.toString();
  });

  return new Promise((resolve) => {
    duplex.on('end', () => {
      assert.strictEqual(response, 'hello\n'.repeat(3));

      resolve();
    });
  });
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

test('failed retries return error', async () => {
  const extClient = client.extend({
    headers: {
      'test-id': randomUUID(),
    },
    retry: {
      limit: 1,
      backoffLimit: 10,
    }
  });

  const response = await extClient.get('http://localhost:3000/retry');

  assert.strictEqual(response.statusCode, 429);
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

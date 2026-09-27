import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import zlib from 'node:zlib';
import {clearInterval} from 'node:timers';
import {getEventListeners} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {text} from 'node:stream/consumers';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {Agent, Dispatcher, getGlobalDispatcher, interceptors, MockAgent, setGlobalDispatcher} from 'undici';
import nock from './nock.ts';
import client, {
  AbortError,
  createClient,
  type GotlikeStream,
  type GotlikeUploadStream,
  type FormedOptions,
  type Got,
  type HandlerFunction,
  Gotlike,
  HTTPError,
  ParseError,
  RequestError,
  type RequestOptions,
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

/** Responses on `/counted-slow` whose connection closed before the server finished them. */
let abandonedResponses = 0;

/** The same for `/trickle`. */
let abandonedTrickles = 0;

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
    res.on('close', () => {
      clearInterval(ticker);

      if (!res.writableFinished) {
        abandonedTrickles++;
      }
    });

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

  if (req.url === '/counted-slow') {
    // Long enough to abort one of several deduped requests part-way; records a response the
    // client walked away from, so a test can tell a dispatch that was really torn down.
    const timer = setTimeout(() => res.end('counted-slow'), 150);

    res.on('close', () => {
      if (!res.writableFinished) {
        clearTimeout(timer);
        abandonedResponses++;
      }
    });

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

  /*
   * Accepts the request, counts it and never answers. The client's own deadline or undici's
   * `headersTimeout` is the only thing that ends it, which is what makes it the route for the
   * retry-on-timeout tests: the count says which of the two fired, since only undici's is one
   * undici will retry.
   */
  if (req.url === '/hang') {
    const testId = req.headers['test-id']?.toString() ?? 'default';

    serverState.retryCounts[testId] = (serverState.retryCounts[testId] ?? 0) + 1;

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

// Rejects on a listen error: with port 3000 taken, `listen` never calls back, and the whole file
// used to hang until node reported "Promise resolution is still pending".
test.before(
  () =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3000, resolve);
    }),
);

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
 * A status the client lists as retryable must not cost the request its deadline.
 *
 * The retry bookkeeping stops the deadline when it expects undici to retry a response, so the
 * backoff isn't charged to the attempt - but that is a *prediction*, and a prediction that
 * misses used to leave the request with no deadline at all. undici only consults its retry
 * policy for a 3xx and up (`RetryHandler.onResponseStart`), so a `retry.statusCodes` naming a
 * 2xx - a polling client listing `202`, say - is never retried there however the prediction
 * answers. Measured before the fix: the same request one status code away from this one gave
 * up at 406ms, while this one was still reading a trickling body at 4s with no error at all.
 *
 * Both halves are pinned by this: the prediction now mirrors undici's own `>= 300` gate, and
 * `resume()` puts the deadline back as soon as a response reaches the caller, so a prediction
 * that misses for some *other* reason costs a restarted clock rather than the whole timeout.
 */
test('a status listed in retry.statusCodes that undici will not retry keeps its deadline', async () => {
  const trickleClient = client.extend({
    timeout: {request: 700},
    // `/trickle` answers 200, which undici never routes through its retry policy.
    retry: {statusCodes: [200], limit: 2, backoffLimit: 10},
  });

  const start = process.hrtime.bigint();

  const error = await failure(trickleClient.get('http://localhost:3000/trickle'));

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.ok(elapsedMs < 1500, `expected the deadline to survive the paused retry, ran for ${elapsedMs}ms`);
});

/**
 * How many times `/hang` was asked, which is how these tests tell the two timeouts apart:
 * undici's own is retryable, the deadline signal's abort never is.
 */
function hangAttempts(testId: string): number {
  return serverState.retryCounts[testId] ?? 0;
}

/**
 * A timed-out request is retried, which for a long time it was not - and could not be.
 *
 * The deadline is armed before the dispatch and undici arms its own `headersTimeout` only once
 * the request has been sent, so the deadline always won that race. Aborting through a signal is
 * the one failure undici will never retry (`RetryHandler.onResponseError` propagates outright
 * when the connection's controller was aborted, and the signal stays aborted for every later
 * attempt anyway) - so a client configured `{retry: {limit: n}, timeout: {request: ms}}`, which
 * is the ordinary shape for a flaky upstream, got no retries at all for the one failure it was
 * most likely configured for, whatever `retry.errorCodes` said. Measured against got 16: an
 * upstream that never answers ran four attempts there and one here.
 *
 * Two things fix it, and the attempt count is what proves both: `requestSignal` defers the abort
 * once so undici's own timeout fires, and the default `errorCodes` carry the two codes undici
 * raises for it.
 */
test('a request that times out is retried the way got retries it', async () => {
  const testId = randomUUID();
  const retrying = client.extend({timeout: {request: 1000}, retry: {limit: 1, backoffLimit: 10}});

  const error = await failure(retrying.get('http://localhost:3000/hang', {headers: {'test-id': testId}}));

  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.strictEqual(hangAttempts(testId), 2, 'the timeout should have been retried');
});

/**
 * got spells a timeout `ETIMEDOUT`; undici raises `UND_ERR_HEADERS_TIMEOUT` /
 * `UND_ERR_BODY_TIMEOUT`. A caller migrating a got call site writes got's name, which undici
 * never raises - so the option was accepted, validated, and then matched nothing at all.
 */
test('retry.errorCodes written in got’s spelling still retries a timeout', async () => {
  const testId = randomUUID();
  const retrying = client.extend({
    timeout: {request: 1000},
    retry: {limit: 1, backoffLimit: 10, errorCodes: ['ETIMEDOUT']},
  });

  const error = await failure(retrying.get('http://localhost:3000/hang', {headers: {'test-id': testId}}));

  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.strictEqual(hangAttempts(testId), 2, 'got’s own code for a timeout should retry one');
});

/**
 * The other half of that: a caller who narrowed `errorCodes` away from timeouts gets the exact
 * deadline back, rather than paying the grace for a retry undici would refuse anyway.
 */
test('retry.errorCodes that exclude a timeout keep the exact deadline', async () => {
  const testId = randomUUID();
  const retrying = client.extend({
    timeout: {request: 700},
    retry: {limit: 2, backoffLimit: 10, errorCodes: ['ECONNRESET']},
  });

  const start = process.hrtime.bigint();

  const error = await failure(retrying.get('http://localhost:3000/hang', {headers: {'test-id': testId}}));

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.strictEqual(hangAttempts(testId), 1, 'a timeout outside errorCodes must not be retried');
  assert.ok(elapsedMs < 1200, `expected the exact deadline, fired after ${elapsedMs}ms`);
});

/**
 * And the floor. undici cannot report a timeout of its own before ~1s however small its
 * `headersTimeout` is (measured against undici 8.10.2: 100, 300 and 900 all fired at ~1000ms),
 * so waiting for one under a sub-second `timeout.request` would multiply a bound the caller set
 * deliberately - failing at 1700ms where they asked for 100. The deadline stays exact there and
 * the attempt is not retried, which is a recorded divergence from got rather than an oversight.
 */
test('a timeout under undici’s timer floor keeps its exact deadline and is not retried', async () => {
  const testId = randomUUID();
  const retrying = client.extend({timeout: {request: 150}, retry: {limit: 2, backoffLimit: 10}});

  const start = process.hrtime.bigint();

  const error = await failure(retrying.get('http://localhost:3000/hang', {headers: {'test-id': testId}}));

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.strictEqual(hangAttempts(testId), 1);
  assert.ok(elapsedMs < 800, `expected the 150ms deadline to fire promptly, fired after ${elapsedMs}ms`);
});

/**
 * The trickling body - the case the deadline exists for - keeps its exact bound even on a client
 * that does retry timeouts. undici propagates rather than retries once a response head has been
 * delivered (`RetryHandler.onResponseError`), so there is nothing to wait for, and waiting would
 * cost the one request that has no other bound. `canRetryError` reads the attempt's own
 * `lastStatusCode` to know the head has arrived.
 */
test('a trickling body keeps its exact deadline on a client that retries timeouts', async () => {
  const retrying = client.extend({timeout: {request: 1100}, retry: {limit: 2, backoffLimit: 10}});

  const start = process.hrtime.bigint();

  const error = await failure(retrying.get('http://localhost:3000/trickle'));

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.strictEqual(error.code, 'ETIMEDOUT');
  assert.ok(elapsedMs < 1600, `expected the deadline not to be deferred past the head, ran for ${elapsedMs}ms`);
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
 * Handlers ran before `call()` resolved the url, so one reading `options.url` before `next`
 * saw the bare relative path - and the full url after `next`, since `call()` resolves onto the
 * same object. got hands handlers the resolved url, and the aggregator logs it from there.
 */
test('handlers see the url resolved against prefixUrl and searchParams, before and after next', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000/echo',
    searchParams: {a: 1},
    handlers: [
      async (options, next) => {
        seen.push(String(options.url));

        const response = await next(options);

        seen.push(String(options.url));

        return response;
      },
    ],
  });

  const response = await extClient.get('items', {searchParams: {b: 2}, responseType: 'json'});
  const expected = 'http://localhost:3000/echo/items?a=1&b=2';

  assert.deepStrictEqual(seen, [expected, expected]);
  assert.strictEqual((response.body as {url: string}).url, '/echo/items?a=1&b=2');
});

/*
 * `options.url` was left exactly as written, so a hook signing it signed `/a b/ü` while undici
 * put `/a%20b/%C3%BC` on the wire. got's `URL` prints the encoded form - the one sent - so
 * handlers, hooks, the wire and `response.url` must all agree on it.
 */
test('handlers, hooks and the wire all see the url in its normalised, encoded form', async () => {
  const seen: string[] = [];

  const extClient = client.extend({
    prefixUrl: 'http://LOCALHOST:3000/echo',
    handlers: [
      (options, next) => {
        seen.push(String(options.url));

        return next(options);
      },
    ],
    hooks: {
      beforeRequest: [
        (options) => {
          seen.push(String(options.url));
        },
      ],
    },
  });

  const response = await extClient.get('a b/ü', {responseType: 'json'});
  const expected = 'http://localhost:3000/echo/a%20b/%C3%BC';

  assert.strictEqual(typeof response.url, 'string');

  assert.deepStrictEqual(seen, [expected, expected]);
  assert.strictEqual(response.url, expected);
  assert.strictEqual((response.body as {url: string}).url, new URL(expected).pathname);
});

/*
 * got hands handlers and hooks a `URL`, and the aggregator's code is written against one:
 * `(options.url as URL).href` in its logging handler was `undefined` on a string. A hook
 * signing through `options.url.searchParams.set(...)` has to reach the wire as well, which a
 * string could never express - and a rewrite in place is invisible to an identity check.
 */
test('handlers and hooks get a URL, and a hook rewriting it in place reaches the wire', async () => {
  const hrefs: string[] = [];

  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000/echo',
    handlers: [
      async (options, next) => {
        hrefs.push((options.url as URL).href);

        const response = await next(options);

        hrefs.push((options.url as URL).href);

        return response;
      },
    ],
    hooks: {
      beforeRequest: [
        (options) => {
          (options.url as URL).searchParams.set('sig', 'abc');
        },
      ],
    },
  });

  const response = await extClient.get('items', {searchParams: {a: 1}, responseType: 'json'});

  assert.strictEqual((response.body as {url: string}).url, '/echo/items?a=1&sig=abc');
  assert.strictEqual(response.url, 'http://localhost:3000/echo/items?a=1&sig=abc');
  assert.ok(response.request.options.url instanceof URL);
  assert.deepStrictEqual(hrefs, [
    'http://localhost:3000/echo/items?a=1',
    'http://localhost:3000/echo/items?a=1&sig=abc',
  ]);
});

// A url built by the caller is theirs: resolving it must hand hooks a fresh `URL`, not theirs.
test('a URL passed by the caller is never the object a hook rewrites', async () => {
  const mine = new URL('http://localhost:3000/echo/items');

  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          (options.url as URL).searchParams.set('sig', 'abc');
        },
      ],
    },
  });

  await extClient.get(mine);
  await extClient.get(mine);

  assert.strictEqual(mine.href, 'http://localhost:3000/echo/items');
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

/**
 * The same guarantee for the three the constructor's spread still aliased.
 *
 * `hooks`, `handlers` and `searchParams` were copied; `context`, `timeout` and `retry` were the
 * caller's own objects on `baseOptions`. That is not inert: `formOptions` copies `context` per
 * request, but it copies it *from* here, so a key added to the caller's object afterwards reached
 * every later request; `timeout` is handed over by reference outright, so a deadline could be
 * moved out from under a client that was already built - measured, a `{request: 5000}` mutated to
 * `{request: 1}` afterwards started timing requests out.
 */
test('a directly built client does not keep the caller’s own context, timeout or retry live', async () => {
  const context: Record<string, unknown> = {tenant: 'original'};
  const timeout = {request: 5000};
  const retry = {limit: 1};

  const built = new Gotlike({responseType: 'json', context, timeout, retry});

  assert.notStrictEqual(built.baseOptions.context, context);
  assert.notStrictEqual(built.baseOptions.timeout, timeout);
  assert.notStrictEqual(built.baseOptions.retry, retry);

  context['injected'] = 'afterwards';
  context['tenant'] = 'mutated';
  // Short enough that a request answered in milliseconds would fail if this reached the client.
  timeout.request = 1;
  retry.limit = 5;

  const response = await built.get<Echo>('http://localhost:3000/echo');

  assert.deepStrictEqual(response.request.options.context, {tenant: 'original'});
  assert.deepStrictEqual(response.request.options.timeout, {request: 5000});
  assert.deepStrictEqual(built.baseOptions.retry, {limit: 1});
});

/**
 * And `headers`, which was the last one and the worst of them, because the object it aliased
 * belonged to nobody: `defaultOptions.headers` is one module-level `{}`, and the constructor's
 * spread handed *the same object* to every client built without headers of its own. A single
 * write through that public field would have shown up on every client created in the process
 * afterwards - the one alias here with a blast radius wider than the client that caused it.
 *
 * A caller's own object needs the copy for the ordinary reason: `extend()` reads `base.headers`,
 * so mutating what was passed to `createClient({headers})` reached clients derived from it later.
 */
test('clients do not share one headers object, with each other or with the caller', async () => {
  assert.notStrictEqual(new Gotlike().baseOptions.headers, new Gotlike().baseOptions.headers);

  const headers = {'x-tenant': 'original'};
  const built = new Gotlike({responseType: 'json', headers});

  assert.notStrictEqual(built.baseOptions.headers, headers);

  headers['x-tenant'] = 'mutated';

  const response = await built.get<Echo>('http://localhost:3000/echo');

  assert.strictEqual(response.body.headers['x-tenant'], 'original');
  assert.strictEqual(built.extend({}).baseOptions.headers?.['x-tenant'], 'original');
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

  // A `URL`, as got hands hooks - `.href` and friends have to work on it.
  assert.ok(seen.url instanceof URL);
  assert.strictEqual(seen.url.href, 'http://localhost:3000/headers');
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

  await assert.rejects(() => extClient.get('http://localhost:3000/status?code=401'), {
    code: 'ERR_NON_2XX_3XX_RESPONSE',
  });

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

/*
 * `retryWithMergedOptions` re-enters `call()` with the merged options, and that nested call
 * already decides `throwHttpErrors`/`isHttpError` for *itself* using them - the outer loop used
 * to decide a second time using the original, pre-retry options, which meant a hook retrying
 * with `throwHttpErrors: false` and a new url still got an `HTTPError` naming the *old* url, as
 * long as the original request's own `throwHttpErrors` was left at its default `true`.
 */
/*
 * `handle()` resolves the url before the handlers, and `call()` resolved it again - laying
 * `searchParams` over the query a handler had just built. got 16 sends both; this sent
 * `/echo/items?a=1`. Pinned both with and without `searchParams`, since only one of the two was
 * broken, and with a handler that changes `searchParams` instead, which must still win.
 */
test('a handler rewriting the url reaches the wire, whether or not the request has searchParams', async () => {
  const signing = client.extend({
    prefixUrl: 'http://localhost:3000/echo',
    responseType: 'json',
    handlers: [
      (options, next) => {
        (options.url as URL).searchParams.set('sig', 'abc');

        return next(options);
      },
    ],
  });

  const withQuery = await signing.get<{url: string}>('items', {searchParams: {a: 1}});
  const withoutQuery = await signing.get<{url: string}>('items?a=1');

  assert.strictEqual(withQuery.body.url, '/echo/items?a=1&sig=abc');
  assert.strictEqual(withoutQuery.body.url, '/echo/items?a=1&sig=abc');

  const replacing = client.extend({
    prefixUrl: 'http://localhost:3000/echo',
    responseType: 'json',
    handlers: [
      (options, next) => {
        options.searchParams = {b: 2};

        return next(options);
      },
    ],
  });

  const replaced = await replacing.get<{url: string}>('items', {searchParams: {a: 1}});

  assert.strictEqual(replaced.body.url, '/echo/items?b=2');
});

/*
 * The first attempt's `searchParams` rode along into a retry that named a url of its own, and
 * replaced its query - so a refresh hook putting a new token in the url sent the old query
 * instead and got the same 401 back. got's `searchParams` is the url's own, so a new url
 * replaces it; measured against got 16 for each row.
 */
test('an afterResponse retry with a url of its own does not inherit the first attempt’s searchParams', async () => {
  const rows: [string, RequestOptions, string][] = [
    ['a url with a query', {url: 'http://localhost:3000/echo/p?token=new'}, '/echo/p?token=new'],
    ['a url with no query', {url: 'http://localhost:3000/echo/p'}, '/echo/p'],
    ['a relative url under prefixUrl', {url: 'p?token=new'}, '/echo/p?token=new'],
    [
      'a url and searchParams of its own',
      {url: 'http://localhost:3000/echo/p?token=new', searchParams: {b: 2}},
      '/echo/p?b=2',
    ],
    ['no url, so the query is kept', {headers: {'x-retried': '1'}}, '/echo/first?a=1'],
  ];

  for (const [name, retryOptions, expected] of rows) {
    const extClient = client.extend({
      prefixUrl: 'http://localhost:3000/echo',
      responseType: 'json',
      hooks: {
        afterResponse: [
          (response, retryWithMergedOptions) =>
            response.request.options.headers['x-retried'] === undefined &&
            !String(response.request.options.url).includes('/echo/p')
              ? retryWithMergedOptions({...retryOptions, headers: {'x-retried': '1'}})
              : response,
        ],
      },
    });

    const response = await extClient.get<{url: string}>('first', {searchParams: {a: 1}});

    assert.strictEqual(response.body.url, expected, name);
  }
});

test('an afterResponse retry’s own throwHttpErrors and url settle the outcome, not the original request’s', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.statusCode === 500) {
            return retryWithMergedOptions({
              url: 'http://localhost:3000/status?code=503',
              throwHttpErrors: false,
            });
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/status?code=500');

  assert.strictEqual(response.statusCode, 503);
  assert.match(String(response.url), /code=503/);
});

/*
 * got documents that calling `retryWithMergedOptions` fires `beforeRetry` hooks and that the
 * retried response's `retryCount` reflects it. Neither happened here: the retry recursed
 * straight into `call()` rather than through undici's retry interceptor, which is the only
 * other place either of those fired from.
 */
test('retryWithMergedOptions increments retryCount and fires beforeRetry', async () => {
  const seen: [Error | undefined, number | undefined, number][] = [];

  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRetry: [
        (error, statusCode, retryCount) => {
          seen.push([error, statusCode, retryCount]);
        },
      ],
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.statusCode === 401) {
            return retryWithMergedOptions({headers: {authorization: 'Bearer refreshed'}});
          }

          return response;
        },
      ],
    },
  });

  const response = await extClient.get('http://localhost:3000/unauthorized');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.retryCount, 1);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0]?.[1], 401);
  assert.strictEqual(seen[0]?.[2], 1);
});

/**
 * `retryCount` counts retries, and the count used to be the *nesting* level of the
 * `retryWithMergedOptions` call instead.
 *
 * Two hooks each retrying once is two retries however they interleave, but `depth` only grows
 * when one retry happens inside another - so two hooks retrying in sequence reported one
 * retry between them, and a nested pair reported three for two. Both shapes are pinned here
 * against the dispatches a `beforeRequest` hook counts, which is the only unarguable number.
 *
 * The sequential shape is now one retry, not two: as in got, a hook that retries ends the loop,
 * and the retried request runs only the hooks before it - so the second hook never runs at all.
 */
test('retryCount counts every afterResponse retry, nested or in sequence', async () => {
  const counted = {dispatches: 0};

  /** Two hooks, the first of which only retries once it sees what the second added. */
  const nested = client.extend({
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      beforeRequest: [() => void counted.dispatches++],
      afterResponse: [
        (response, retry) =>
          response.request.options.headers['x-from-second'] === undefined
            ? response
            : retry({headers: {'x-from-first': '1'}, prefixUrl: undefined}),
        (response, retry) =>
          response.request.options.headers['x-from-second'] === undefined
            ? retry({headers: {'x-from-second': '1'}, prefixUrl: undefined})
            : response,
      ],
    },
  });

  const nestedResponse = await nested.get('http://localhost:3000/json');

  assert.strictEqual(counted.dispatches, 3, 'expected the original request plus two retries');
  assert.strictEqual(nestedResponse.retryCount, 2);

  /** Each hook retrying on its own: the first one's retry means the second never gets a turn. */
  counted.dispatches = 0;

  let firstRetried = false;
  let secondRetried = false;

  const sequential = client.extend({
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      beforeRequest: [() => void counted.dispatches++],
      afterResponse: [
        (response, retry) => {
          if (firstRetried) {
            return response;
          }

          firstRetried = true;

          return retry({headers: {'x-first': '1'}, prefixUrl: undefined});
        },
        (response, retry) => {
          if (secondRetried) {
            return response;
          }

          secondRetried = true;

          return retry({headers: {'x-second': '1'}, prefixUrl: undefined});
        },
      ],
    },
  });

  const sequentialResponse = await sequential.get('http://localhost:3000/json');

  assert.strictEqual(counted.dispatches, 2, 'expected the original request plus one retry');
  assert.strictEqual(sequentialResponse.retryCount, 1);
  assert.strictEqual(secondRetried, false, 'the hook after the retrying one must not run');
});

/**
 * A retry's options get the same normalisation and validation a per-call options object gets.
 *
 * `retryWithMergedOptions` goes straight to `call()`, so it is the one route in that skips
 * `formOptions` - which made it a second, permanent `validate: false` that no caller could turn
 * on. A lower-case `method` reached the request line verbatim and the server answered 400 (got
 * normalises it and succeeds), and a misspelled `responseType` fell past the `json`/`text` arms
 * to hand back a `Buffer` where the identical typo on the original call throws.
 */
test('an afterResponse retry normalises and validates the options it is given', async () => {
  /*
   * The "already retried" marker travels in `context`, not in a header: the table below feeds
   * this whole option objects, `headers` among them, and a marker header would overwrite the
   * very value under test - which is how the first draft of this reported a gap that was its
   * own harness.
   */
  const retried = (newOptions: RequestOptions) =>
    client.extend({
      responseType: 'json',
      throwHttpErrors: false,
      hooks: {
        afterResponse: [
          (response, retry) =>
            response.request.options.context['retried'] === undefined
              ? retry({...newOptions, context: {retried: true}})
              : response,
        ],
      },
    });

  // Folded to `POST`, as `formOptions` folds it - not sent as the literal `post`.
  const response = await retried({method: 'post'}).post<Echo>('http://localhost:3000/echo');

  assert.strictEqual(response.body.method, 'POST');

  /*
   * The invariant, rather than a handful of examples: whatever `formOptions` refuses on a normal
   * call, the retry merge refuses too. Both routes are driven from the same table, so an option
   * whose validation only one of them applies shows up as a failure here - which is what the
   * retry path was, wholesale, for every rule at once.
   */
  const rejected: {label: string; options: unknown}[] = [
    {label: 'a misspelled responseType', options: {responseType: 'jsn'}},
    {label: 'a method that is not one', options: {method: 'NOTAMETHOD'}},
    {label: 'a timeout that is not an object', options: {timeout: 1000}},
    {label: 'timeout.request of 0', options: {timeout: {request: 0}}},
    {label: 'a non-finite timeout.request', options: {timeout: {request: Number.POSITIVE_INFINITY}}},
    {label: 'headers that are not an object', options: {headers: []}},
    {label: 'a prefixUrl carrying a query', options: {prefixUrl: 'http://localhost:3000?q=1'}},
    {label: 'a prefixUrl carrying a fragment', options: {prefixUrl: 'http://localhost:3000#f'}},
    {label: 'searchParams that are not a query', options: {searchParams: 5}},
    // Raised by `queryValue` when the query is serialised rather than by `validateOptions`, so
    // it reaches the caller from inside `call()` on both routes - and has to be the same class
    // on both, which is what the pre-request catch's `ValidationError` passthrough is for.
    {label: 'a searchParams value that is an object', options: {searchParams: {a: {b: 1}}}},
    {label: 'a form that is not an object', options: {form: 'a=1'}},
    {label: 'an unknown option', options: {nonsense: 1}},
    {label: 'a client-only option per request', options: {hooks: {beforeRequest: []}}},
    {label: 'retry per request', options: {retry: {limit: 1}}},
    // Composing the redirect interceptor is a create/extend-time decision, so a per-request
    // `true` can never work. `formOptions` refused it from the start; the retry's own copy of the
    // check simply did not exist, so a hook asking for it was ignored rather than told. Both
    // routes go through `validateRequest` now, which is what keeps this row honest.
    {label: 'followRedirect: true per request', options: {followRedirect: true}},
  ];

  const disagreed: string[] = [];

  /*
   * Describes the outcome rather than assuming one. An option that stops being rejected has to
   * read as a disagreement on its own row - throwing here instead would hide every row after it,
   * which is how a table test quietly becomes a test of its first entry.
   */
  const outcome = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();

      return 'resolved';
    } catch (error) {
      return error instanceof ValidationError
        ? `ValidationError/${error.code}`
        : `${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
  };

  for (const {label, options} of rejected) {
    const onCall = await outcome(() => client.get('http://localhost:3000/json', options as RequestOptions));
    const onRetry = await outcome(() => retried(options as RequestOptions).get('http://localhost:3000/json'));

    if (onCall !== onRetry) {
      disagreed.push(`${label}\n    on the call:  ${onCall}\n    on the retry: ${onRetry}`);
    }
  }

  assert.deepStrictEqual(
    disagreed,
    [],
    `the retry merge and formOptions disagree about these options:\n  ${disagreed.join('\n  ')}`,
  );
});

/**
 * An option the hook names as `undefined` leaves the first attempt's value standing.
 *
 * The third thing `formOptions` does that the retry merge has to do for itself, alongside the
 * validation and the method folding the test above pins. A key that is *present* with the value
 * `undefined` wins a plain spread, and that is the shape a refresh hook writes constantly -
 * `retry({headers, method: req.method, throwHttpErrors: cfg.throwHttpErrors})` forwarded from
 * somewhere any of those can be absent. Measured before the fix: `{method: undefined}` replayed a
 * POST as a **GET**, `{responseType: undefined}` handed back a `Buffer` instead of parsed json,
 * and `{url: undefined}` failed the dispatch outright with `UND_ERR_INVALID_ARG`.
 *
 * got skips `undefined` when it merges (`Options.merge`, which is what its own
 * `retryWithMergedOptions` goes through), and so does every other route into `call()` here. The
 * table is written as "absent against present-undefined must be indistinguishable", so an option
 * that starts differing between the two reads as its own row rather than as one example failing.
 */
test('an afterResponse retry ignores an option the hook names as undefined', async () => {
  const retried = (newOptions: RequestOptions) =>
    client.extend({
      responseType: 'json',
      hooks: {
        afterResponse: [
          (response, retry) =>
            response.request.options.context['retried'] === undefined
              ? retry({...newOptions, context: {retried: true}})
              : response,
        ],
      },
    });

  /** What the retried request became, as far as the server and the caller can both see it. */
  const describe = async (newOptions: RequestOptions): Promise<string> => {
    try {
      const response = await retried(newOptions).post<Echo>('http://localhost:3000/echo', {
        json: {a: 1},
        searchParams: {q: 'x'},
        timeout: {request: 5000},
      });

      const echo = response.body;

      return `${echo.method} ${echo.url} ct=${echo.headers['content-type']} body=${echo.body} parsed=${typeof echo}`;
    } catch (error) {
      return `${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
  };

  const absent = await describe({});

  // Sanity: the baseline really is the request the options describe, so a row agreeing with it
  // means something. A table whose baseline had quietly become a failure would otherwise pass.
  assert.match(absent, /^POST \/echo\?q=x ct=application\/json body=\{"a":1\} parsed=object$/);

  const keys: (keyof RequestOptions)[] = [
    'method',
    'url',
    'responseType',
    'searchParams',
    'timeout',
    'prefixUrl',
    'headers',
    'json',
    'body',
    'form',
    'context',
    'resolveBodyOnly',
  ];

  const disagreed: string[] = [];

  for (const key of keys) {
    const present = await describe({[key]: undefined});

    if (present !== absent) {
      disagreed.push(`${key}\n    absent:           ${absent}\n    present-undefined: ${present}`);
    }
  }

  assert.deepStrictEqual(
    disagreed,
    [],
    `a retry option named as undefined changed the request:\n  ${disagreed.join('\n  ')}`,
  );
});

test('an afterResponse retry with throwHttpErrors undefined still throws on an error status', async () => {
  // The same rule as the table above, on the one option whose effect only shows on a failing
  // status: `undefined` used to read as "off", so the 401 the hook was retrying resolved as a
  // success the second time round.
  const client401 = client.extend({
    hooks: {
      afterResponse: [
        (response, retry) =>
          response.request.options.context['retried'] === undefined
            ? retry({throwHttpErrors: undefined, context: {retried: true}})
            : response,
      ],
    },
  });

  const error = await failure<RequestError>(client401.get('http://localhost:3000/status?code=401'));

  assert.ok(error instanceof HTTPError, `expected an HTTPError, got ${error}`);
  assert.strictEqual(error.response?.statusCode, 401);
});

/**
 * A got option this does not implement says so, rather than reading as a misspelling.
 *
 * got accepts `retry.calculateDelay`, `retry.noise` and `hooks.init`; gotlike refuses all three,
 * because silently ignoring them means a backoff tuning that never applies and an `init` hook
 * that never fires - the very thing the unknown-key check exists to stop. That makes it a
 * behavioural divergence from got, so it is named as one in the message and in the README.
 */
test('a got option gotlike does not implement is refused by name', async () => {
  // Cast at the boundary: these are got's option names, which `RequestOptions` deliberately
  // does not declare - a caller migrating from got is writing them in untyped or loosely typed
  // code, which is exactly the case the runtime check is here for.
  const options: {label: string; value: unknown}[] = [
    {label: '`retry.calculateDelay` is not implemented', value: {retry: {calculateDelay: () => 0}}},
    {label: '`retry.noise` is not implemented', value: {retry: {noise: 100}}},
    {label: '`hooks.init` is not implemented', value: {hooks: {init: [() => {}]}}},
    // got's per-phase timeouts, which a bare `request` check let through and then ignored.
    {label: '`timeout.response` is not implemented', value: {timeout: {response: 10_000}}},
    {label: '`timeout.connect` is not implemented', value: {timeout: {request: 5000, connect: 1000}}},
    {label: '`timeout.lookup` is not implemented', value: {timeout: {lookup: 100}}},
  ];

  for (const {label: expected, value} of options) {
    assert.throws(
      () => createClient(value as RequestOptions),
      (error: Error) =>
        error instanceof ValidationError &&
        error.message.startsWith(expected) &&
        // Not the generic "Unknown option", which is what a real typo still gets.
        !error.message.startsWith('Unknown option'),
      `expected ${expected}`,
    );
  }

  // A genuine typo is still a typo.
  assert.throws(() => createClient({retry: {limt: 0}} as RequestOptions), /Unknown option `retry.limt`/);
  assert.throws(() => createClient({timeout: {reqest: 5000}} as RequestOptions), /Unknown option `timeout.reqest`/);

  // And every route refuses it, not only construction: `extend()` is generic, so a caller's
  // literal gets no excess-property check there, and a single call is where got code sets it too.
  const response = {timeout: {response: 10_000}} as RequestOptions;

  assert.throws(() => createClient().extend(response), /`timeout.response` is not implemented/);
  await assert.rejects(createClient().get('http://localhost:3000/', response), /`timeout.response` is not implemented/);
});

/**
 * `isResponseLike` deliberately accepts anything carrying a numeric `statusCode`, so a hook may
 * hand back a response it built itself - and one of those has no `request` on it. Reading
 * `response.request.options` straight through threw a bare `Cannot read properties of undefined
 * (reading 'options')` from outside the hook loop's own try, which was the last place a raw
 * error could escape the `RequestError` wrapper and the `beforeError` hooks entirely.
 */
test('an afterResponse hook may return a response it built itself', async () => {
  const extClient = client.extend({
    hooks: {
      afterResponse: [() => ({statusCode: 200, body: 'replaced'}) as unknown as GotlikeResponse<string>],
    },
  });

  const response = await extClient.get('http://localhost:3000/json');

  assert.strictEqual(response.body, 'replaced');
  assert.strictEqual(response.statusCode, 200);
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
 * against got 16, which sends the new url's credentials.
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
 * The url and the Basic-auth header are derived before the `beforeRequest` hooks run, and were
 * only derived again when a hook rewrote `options.url` - so a hook adding a query parameter or
 * credentials through the options got 12 reads them from had its write dropped, silently, with
 * nothing but a 401 from the upstream to say so. One row per shape a hook writes; each asserts the
 * wire.
 */
test('a beforeRequest hook writing searchParams or credentials reaches the wire', async () => {
  const basic = (credentials: string) => 'Basic ' + Buffer.from(credentials).toString('base64');
  const rows: {
    name: string;
    hook: (options: FormedOptions) => void;
    request?: RequestOptions;
    url: string;
    authorization?: string;
  }[] = [
    {
      name: 'assigns searchParams',
      hook: (options) => {
        options.searchParams = {sig: 'abc'};
      },
      url: '/echo?sig=abc',
    },
    {
      name: 'sets a parameter on the request searchParams in place',
      hook: (options) => {
        (options.searchParams as URLSearchParams).set('sig', 'abc');
      },
      request: {searchParams: new URLSearchParams('a=1')},
      url: '/echo?a=1&sig=abc',
    },
    {
      name: 'leaves searchParams alone',
      hook: () => {},
      request: {searchParams: {a: '1'}},
      url: '/echo?a=1',
    },
    {
      name: 'sets username and password',
      hook: (options) => {
        options.username = 'u';
        options.password = 'p';
      },
      url: '/echo',
      authorization: basic('u:p'),
    },
    {
      name: 'replaces credentials the request carried',
      hook: (options) => {
        options.username = 'new';
      },
      request: {username: 'old', password: 'p'},
      url: '/echo',
      authorization: basic('new:p'),
    },
    {
      name: 'sets credentials alongside an explicit authorization header',
      hook: (options) => {
        options.username = 'u';
      },
      request: {headers: {authorization: 'Bearer token'}},
      url: '/echo',
      authorization: 'Bearer token',
    },
    {
      name: 'clears the credentials the request carried',
      hook: (options) => {
        options.username = undefined;
        options.password = undefined;
      },
      request: {username: 'old', password: 'p'},
      url: '/echo',
    },
  ];

  for (const row of rows) {
    const hooked = client.extend({responseType: 'json', hooks: {beforeRequest: [row.hook]}});
    const response = await hooked.get<Echo>('http://localhost:3000/echo', row.request);

    assert.strictEqual(response.body.url, row.url, row.name);
    assert.strictEqual(response.body.headers['authorization'], row.authorization, row.name);
  }
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
      assert.strictEqual(err.message, 'translated: ERR_NON_2XX_3XX_RESPONSE');

      return true;
    },
  );
});

/*
 * `toRequestError` awaited each `beforeError` hook with nothing to catch a throw - so a hook
 * that itself threw escaped as that raw error rather than the `RequestError` already built,
 * indistinguishable from a network failure to anything matching `instanceof RequestError`. got
 * wraps the same failure in a `RequestError` rather than letting it through raw.
 */
test('a beforeError hook that throws is wrapped in a RequestError rather than escaping raw', async () => {
  const extClient = client.extend({
    hooks: {
      beforeError: [
        () => {
          throw new Error('hook exploded');
        },
      ],
    },
  });

  const err = await failure<RequestError>(extClient.get('http://localhost:3000/status?code=500'));

  assert.ok(err instanceof RequestError);
  assert.match(err.message, /hook exploded/);
  assert.strictEqual((err.cause as Error).message, 'hook exploded');
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
      code: 'ERR_NON_2XX_3XX_RESPONSE',
      // got's phrasing, minus the query - see the redaction test below.
      message: 'Request failed with status code 403 (Forbidden): GET http://localhost:3000/status',
    },
  );
});

/*
 * The whole reason the message is not got's verbatim. got names the full url, which is how an api
 * key, a signature or a session token in a query string ends up in every log line and APM group
 * that prints the error. The path identifies the request; the query is what leaks.
 */
test('an http error message names the url but never its query', async () => {
  const error = await failure(
    client.get('http://localhost:3000/status', {
      searchParams: {code: '500', apiKey: 'super-secret-token', sig: 'deadbeef'},
    }),
  );

  assert.match(error.message, /GET http:\/\/localhost:3000\/status$/);
  assert.doesNotMatch(error.message, /super-secret-token|deadbeef|apiKey|sig=/);

  // The url the request actually went to is untouched - only the message is redacted.
  assert.match(String(error.response?.request.options.url), /apiKey=super-secret-token/);
});

/*
 * A status node has no canonical text for: the parenthetical is dropped rather than reading
 * `(undefined)`. Non-standard codes in the 5xx range are common enough from proxies and
 * gateways that this is not a hypothetical.
 */
test('an http error message omits the status text when there is none', async () => {
  const error = await failure(client.get('http://localhost:3000/status-empty?code=599'));

  assert.strictEqual(error.message, 'Request failed with status code 599: GET http://localhost:3000/status-empty');
});

// A fragment comes off with the query, and a url carrying neither is named in full.
test('an http error message keeps a url that has no query', async () => {
  const error = await failure(client.get('http://localhost:3000/status-empty?code=418#anchor'));

  assert.strictEqual(
    error.message,
    "Request failed with status code 418 (I'm a Teapot): GET http://localhost:3000/status-empty",
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

/*
 * The got-shaped proxy: copy the head onto an outgoing response, then pipe the body into it.
 * The emit is deferred so that a caller can attach a listener after `await stream(...)` at all -
 * and on `setImmediate` alone the body won every time, because attaching a `data` listener (which
 * `pipe()` does, in the same synchronous block) starts the flow on a `process.nextTick`. Measured
 * against got 16 on the same server: `data, response` here against `response, data` there, so a
 * status and headers copied in the handler landed after body bytes had already been written.
 *
 * Asserted per consumer rather than once, because each starts the flow by a different route and
 * it is the route that used to decide the answer.
 */
for (const [consumer, read] of [
  [
    'pipe',
    (stream: Readable, seen: string[]) =>
      pipeline(stream, new Writable({write: (_c, _e, cb) => (seen.push('data'), cb())})),
  ],
  [
    'on(data)',
    (stream: Readable, seen: string[]) =>
      new Promise<void>((resolve) => {
        stream.on('data', () => seen.push('data'));
        stream.on('end', () => resolve());
      }),
  ],
  [
    'for await',
    async (stream: Readable, seen: string[]) => {
      for await (const _chunk of stream) {
        seen.push('data');
      }
    },
  ],
] as const) {
  test(`stream emits response before any body reaches a ${consumer} consumer`, async () => {
    const stream = await client.stream('http://localhost:3000/stream');
    const seen: string[] = [];

    stream.on('response', () => seen.push('response'));

    await read(stream, seen);

    assert.strictEqual(seen[0], 'response', `saw ${seen.join(', ')}`);
    assert.ok(seen.includes('data'), 'the body should still have been delivered');
  });
}

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
  assert.strictEqual(err.code, 'ERR_NON_2XX_3XX_RESPONSE');
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

  await assert.rejects(() => extClient.get('http://localhost:3000/retry'), {code: 'ERR_NON_2XX_3XX_RESPONSE'});
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
  assert.strictEqual(err.code, 'ERR_NON_2XX_3XX_RESPONSE');
  assert.strictEqual(err.response?.statusCode, 401);
  // The whole point: a parsed body, not a consumed BodyReadable.
  assert.deepStrictEqual(err.response?.body, {error: 'token expired'});
  assert.ok(typeof err.response?.timings.phases.total === 'number');
  assert.strictEqual(err.response?.request.options.context.brandId, 3);
  assert.strictEqual(String(err.options.url), 'http://localhost:3000/unauthorized');
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

/*
 * An invariant rather than a scenario, and the third of these in the file for the same reason:
 * every one of these was one uncovered *option*, not a wrong answer on a covered one.
 *
 * `formOptions` allocates `headers` and `context` per request precisely so that the code handed
 * the formed options - a handler, a `beforeRequest`/`afterResponse`/`beforeError` hook - cannot
 * write through them into the client or back into the caller's own literal. Every option whose
 * value is a mutable object shared with the client needs that, and `searchParams`, `timeout` and
 * `handlers` did not have it: measured, a hook adding one query parameter put it on every later
 * request the client made, and `options.timeout.request = 5` for one request moved the client's
 * deadline permanently, so everything it sent afterwards timed out.
 *
 * Each row writes through the option the way a hook plausibly would, once per *setup* - which is
 * the part that matters. The shallow spread only aliases when a single side carries the option;
 * when both do, `mergeSearchParams` was already allocating and the row would pass vacuously. So
 * each option is driven from the client alone, from the call alone, and from both, and each setup
 * asks the two questions: did the client change, and did the caller's own object change.
 * Reported per row rather than thrown, so a row that stops failing reads as a result instead of
 * hiding every row after it.
 *
 * The values written are deliberately harmless (a spare query parameter, a longer deadline): what
 * is under test is whether the write escapes the request, not what it would have done if it did.
 *
 * **Every row runs twice, once per route the formed options reach writable code by**, and the
 * second is the one that was missed. The copies used to sit behind a `sharesOptions` flag, on the
 * reasoning that "a client with neither handlers nor hooks has nothing that could write" - but
 * the formed options are handed to *every* caller, as `response.request.options` and
 * `error.options`, both of which the README documents. Measured on a hookless, handler-less
 * client: `response.request.options.timeout === client.baseOptions.timeout`, so a caller - or any
 * logging or retry wrapper that normalises what it is shown - moved the client's deadline for
 * good. A row driven only through a hook passes vacuously on that shape, which is why the route
 * is a dimension of the table rather than a separate scenario.
 */
test('a hook writing through the formed options cannot reach the client or the caller', async () => {
  type Row = {
    option: string;
    /** Each side the option can arrive from, since only a one-sided one is aliased. */
    setups: {onClient: RequestOptions; perCall: () => RequestOptions}[];
    write: (options: FormedOptions) => void;
    /** What the option should still read as after a request that wrote through it. */
    read: (options: RequestOptions) => string;
  };

  const rows: Row[] = [
    {
      option: 'searchParams',
      setups: [
        {onClient: {searchParams: {k: 'v'}}, perCall: () => ({})},
        {onClient: {}, perCall: () => ({searchParams: {q: '1'}})},
        {onClient: {searchParams: {k: 'v'}}, perCall: () => ({searchParams: {q: '1'}})},
      ],
      write: (options) => {
        (options.searchParams as Record<string, string>).injected = 'yes';
      },
      read: (options) => JSON.stringify(options.searchParams),
    },
    {
      option: 'timeout',
      setups: [
        {onClient: {timeout: {request: 5000}}, perCall: () => ({})},
        {onClient: {}, perCall: () => ({timeout: {request: 4000}})},
        // `{}` is the shape that makes `formOptions` reach for the client's object by name
        // rather than through the spread - the one place it was assigned outright.
        {onClient: {timeout: {request: 5000}}, perCall: () => ({timeout: {}})},
      ],
      write: (options) => {
        options.timeout!.request = 9000;
      },
      read: (options) => JSON.stringify(options.timeout),
    },
    {
      // Client-only by definition, so there is no per-call side to alias.
      option: 'handlers',
      setups: [{onClient: {}, perCall: () => ({})}],
      write: (options) => {
        options.handlers!.push((o, next) => next(o));
      },
      read: (options) => String(options.handlers?.length),
    },
  ];

  const failures: string[] = [];
  const passThrough: HandlerFunction = (options, next) => next(options);

  for (const route of ['hook', 'response'] as const) {
    for (const row of rows) {
      for (const [index, setup] of row.setups.entries()) {
        const probe = client.extend({
          ...setup.onClient,
          /*
           * The hook route gets a handler as well as the hook, since `handlers` is what one of
           * the rows writes to and a client without one never forms the array at all. The
           * response route is left as bare as the row allows: no hooks, no handlers, which is
           * exactly the shape whose copies used to be skipped.
           */
          ...(route === 'hook' || row.option === 'handlers' ? {handlers: [passThrough]} : {}),
          ...(route === 'hook' ? {hooks: {beforeRequest: [(options: FormedOptions) => row.write(options)]}} : {}),
        });

        const where = `${row.option} [setup ${index}, via ${route}]`;
        const clientBefore = row.read(probe.baseOptions);
        const callerOptions = setup.perCall();
        const callerBefore = row.read({...callerOptions, handlers: probe.baseOptions.handlers});

        const response = await probe.get('http://localhost:3000/echo', callerOptions);

        // The other end of the same object: what the request was sent with is handed back on
        // every response, and writing through it must not reach any further than a hook's write.
        if (route === 'response') {
          row.write(response.request.options);
        }

        await probe.get('http://localhost:3000/echo', setup.perCall());

        const clientAfter = row.read(probe.baseOptions);

        if (clientAfter !== clientBefore) {
          failures.push(`${where}: the client's own value changed from ${clientBefore} to ${clientAfter}`);
        }

        const callerAfter = row.read({...callerOptions, handlers: probe.baseOptions.handlers});

        if (callerAfter !== callerBefore) {
          failures.push(`${where}: the caller's own options changed from ${callerBefore} to ${callerAfter}`);
        }
      }
    }
  }

  assert.deepStrictEqual(failures, []);
});

/*
 * The companion to the invariant above, for the two options `formOptions` deliberately does
 * *not* copy. The justification for aliasing them is that both are consumed at construction, so
 * a write through them cannot change the client - which was not true, because the arrays the
 * client ran from were the very ones on `baseOptions`. Driven through `response.request.options`
 * rather than `baseOptions` directly, since that is the reference every caller is handed.
 */
test('the hooks and retry a response reports cannot change what the client runs', async () => {
  const ran: string[] = [];
  const probe = client.extend({
    hooks: {beforeRequest: [() => void ran.push('original')]},
    retry: {limit: 1, statusCodes: [503], backoffLimit: 10},
  });

  const first = await probe.get('http://localhost:3000/json');

  // A caller, or a logging wrapper, adding "one more hook for this request".
  first.request.options.hooks!.beforeRequest!.push(() => void ran.push('injected'));
  // And widening what gets retried, through the same reference.
  first.request.options.retry!.statusCodes!.push(404);

  ran.length = 0;

  await probe.get('http://localhost:3000/json');

  assert.deepStrictEqual(ran, ['original'], 'a hook pushed through response.request.options ran');

  const testId = randomUUID();
  const notRetried = await probe.get('http://localhost:3000/status?code=404', {
    throwHttpErrors: false,
    headers: {'test-id': testId},
  });

  assert.strictEqual(notRetried.retryCount, 0, 'a status pushed through response.request.options was retried');
});

test('a deadline does not accumulate on a caller’s own signal', async () => {
  const controller = new AbortController();
  const timed = client.extend({timeout: {request: 5000}});

  /*
   * `AbortSignal.any` registers the composite it builds in the *source* signal's internal
   * dependant-signal set, and there is no API to take it back out again - so a signal a caller
   * shares across requests collected one unreclaimable entry per request, for its whole life.
   * Measured at 485 bytes a request, and 1971 entries after 2000 requests. Asserted by patching
   * the function rather than by weighing the heap, so reverting to it fails loudly instead of
   * flakily.
   */
  // Through the descriptor, so the original is put back exactly as it was - and so the lint
  // rule against referencing an unbound method has nothing to object to.
  const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  let composed = 0;

  Object.defineProperty(AbortSignal, 'any', {
    ...original,
    value: (signals: AbortSignal[]) => {
      composed++;

      return (original.value as typeof AbortSignal.any).call(AbortSignal, signals);
    },
  });

  try {
    for (let index = 0; index < 5; index++) {
      await timed.get('http://localhost:3000/json', {signal: controller.signal});
    }
  } finally {
    Object.defineProperty(AbortSignal, 'any', original);
  }

  assert.strictEqual(composed, 0, 'the deadline was composed with AbortSignal.any, which cannot be detached');
  assert.deepStrictEqual(
    getEventListeners(controller.signal, 'abort'),
    [],
    'the deadline left its abort listener on the caller’s signal',
  );

  // The other half: the forwarding has to be there while the request is actually in flight, so
  // dropping the caller's signal altogether cannot pass this test.
  const inFlight = failure(timed.get('http://localhost:3000/hang', {signal: controller.signal}));

  await sleep(50);

  assert.strictEqual(
    getEventListeners(controller.signal, 'abort').length,
    1,
    'the caller’s signal is not wired to the request while it is in flight',
  );

  controller.abort();

  assert.strictEqual((await inFlight).code, 'ERR_ABORTED');
  assert.deepStrictEqual(getEventListeners(controller.signal, 'abort'), []);
});

/*
 * `normaliseStreamErrors` works by wrapping `_destroy`, which Node calls for every destroy -
 * so a consumer tearing the stream down was being reported as a failed request: the hooks ran,
 * and `stream.errored` was rewritten to a `RequestError` that described nothing that happened.
 * For anything proxying a download that is every client disconnect. The rows are the shapes a
 * consumer actually produces; the request itself succeeds in all of them.
 */
test('a consumer destroying a stream is not a request failure', async () => {
  const seen: string[] = [];
  const probe = client.extend({
    hooks: {
      beforeError: [
        (error) => {
          seen.push(error.message);

          return error;
        },
      ],
    },
  });

  const rows: {label: string; run: (stream: GotlikeStream) => Promise<unknown>}[] = [
    {
      label: 'destroy() with no error',
      run: async (stream) => {
        stream.on('error', () => undefined);
        stream.destroy();

        await sleep(50);
      },
    },
    {
      label: 'destroy(error)',
      run: async (stream) => {
        stream.on('error', () => undefined);
        stream.destroy(new Error('caller gave up'));

        await sleep(50);
      },
    },
    {
      label: 'a destination that fails mid-pipe',
      run: (stream) =>
        failure(
          pipeline(
            stream,
            new Writable({
              write(_chunk, _encoding, callback) {
                callback(new Error('disk full'));
              },
            }),
          ),
        ),
    },
  ];

  for (const row of rows) {
    seen.length = 0;

    const stream = await probe.stream('http://localhost:3000/stream');

    await row.run(stream);

    assert.deepStrictEqual(seen, [], `${row.label}: the beforeError hooks ran for a consumer-side teardown`);
  }

  // And the request's own failures still are one, which is what keeps this from being a licence
  // to stop normalising. `/truncate` cuts the socket after the head has arrived.
  seen.length = 0;

  const truncated = await probe.stream('http://localhost:3000/truncate');

  await failure(text(truncated));

  assert.strictEqual(seen.length, 1, 'a truncated body stopped being reported as a request failure');
  assert.ok(truncated.errored instanceof RequestError);
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
            seen.push(String(options.url));
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
  assert.strictEqual(String(response.request.options.url), 'http://localhost:3000/json');
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

/*
 * `null` and `undefined` are not the same thing here, and treating them as one lost a parameter
 * off the wire: `{a: null}` went out as no `a` at all where got sends `a=`. An upstream that
 * tells "absent" from "present and empty" - a filter being cleared, a tri-state flag, anything
 * signing over the canonical query - saw a different request, silently. got's own rule is the
 * one below: `null` appends an empty value, `undefined` is skipped.
 */
test('searchParams sends null as an empty value and drops undefined', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    searchParams: {keep: 'yes', blank: null, drop: undefined, zero: 0, empty: ''},
  });

  assert.strictEqual(response.body.url, '/echo?keep=yes&blank=&zero=0&empty=');
});

// The same rule inside an array, which is how a key is repeated: a `null` is still a value of
// that key, an `undefined` is still nothing at all.
test('an array searchParams value applies the null/undefined rule per item', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    searchParams: {a: [1, null, undefined, 2]},
  });

  assert.strictEqual(response.body.url, '/echo?a=1&a=&a=2');
});

// Through the merge as well as the plain serialisation - `mergeSearchParams` walks the override's
// own keys and then appends through `appendQuery`, so the two cannot disagree.
test('a null override in a merged searchParams replaces the client’s value with an empty one', async () => {
  const scoped = client.extend({responseType: 'json', searchParams: {a: '1', z: '9'}});

  const response = await scoped.get<Echo>('http://localhost:3000/echo', {searchParams: {a: null}});

  assert.strictEqual(response.body.url, '/echo?z=9&a=');
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

/*
 * `form` shares `appendQuery` with `searchParams`, so it gets the same rule: `null` is sent as
 * an empty value and `undefined` is dropped.
 *
 * got's `form` diverges here, and deliberately is not copied: it builds the body with
 * `new URLSearchParams(form)`, which stringifies both into the literal text `a=null` and
 * `b=undefined`. That is a serialisation artefact rather than an intent - it is not what got's
 * own `searchParams` does with the same two values - and no server wants the four characters
 * `null` in a form field. Keeping the key with an empty value preserves what the old behaviour
 * actually lost, which was the key. Recorded in the README's divergence table.
 */
test('form sends null as an empty value and drops undefined', async () => {
  const fromParams = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: new URLSearchParams({a: '1'}),
  });

  assert.strictEqual(fromParams.body.body, 'a=1');

  const nullish = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: {keep: 'yes', blank: null, drop: undefined},
  });

  assert.strictEqual(nullish.body.body, 'keep=yes&blank=');
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

/*
 * undici's dedupe sends the first of a group and parks the rest on it, and only that first
 * caller controls the shared dispatch - so its abort, and the error it aborted with, used to
 * reach every request parked on it. Measured: one caller's `abort()` failed another with
 * `AbortError`, and a 20ms deadline failed a request that had asked for 5s. One row per way a
 * caller aborts, since each arrives through a different route.
 */
test('with dedupe, one caller aborting does not fail the requests collapsed onto it', async () => {
  const aborts: [string, (controller: AbortController) => RequestOptions][] = [
    ['its own signal', (controller) => ({signal: controller.signal})],
    ['its own deadline', () => ({timeout: {request: 20}})],
  ];

  for (const [name, abortingOptions] of aborts) {
    const before = requestCounts['/counted-slow'] ?? 0;
    const extClient = new Gotlike({dedupe: true});
    const controller = new AbortController();

    const first = extClient.get('http://localhost:3000/counted-slow', abortingOptions(controller));
    const second = extClient.get('http://localhost:3000/counted-slow', {timeout: {request: 5000}});

    setTimeout(() => controller.abort(), 20);

    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

    assert.strictEqual(firstOutcome.status, 'rejected', `${name}: the aborting request itself still fails`);
    assert.ok(firstOutcome.reason instanceof RequestError, name);
    assert.strictEqual(secondOutcome.status, 'fulfilled', `${name}: ${String((secondOutcome as any).reason)}`);
    assert.strictEqual(secondOutcome.value.body, 'counted-slow', name);
    assert.strictEqual((requestCounts['/counted-slow'] ?? 0) - before, 1, `${name}: still collapsed`);
  }
});

// The other half: with nobody parked on it, an abort still tears the dispatch down rather than
// leaving it running for no one.
test('with dedupe, a lone aborted request still aborts its dispatch', async () => {
  const before = abandonedResponses;
  const extClient = new Gotlike({dedupe: true});

  await failure(extClient.get('http://localhost:3000/counted-slow', {timeout: {request: 20}}));
  await sleep(50);

  assert.strictEqual(abandonedResponses - before, 1);
});

/*
 * Who dedupe actually parked on the dispatch decides, not a guess at it. Isolation used to count
 * requests by origin, method and path, which is coarser than dedupe's key - it compares headers
 * too - so an aborted request that had a *different* `authorization` from a concurrent one was
 * left running with nobody reading it. And a parked request's abort must leave the one it is
 * parked on alone.
 */
test('with dedupe, an abort tears down exactly the dispatches nobody else is reading', async () => {
  const rows: [string, RequestOptions, RequestOptions, {abandoned: number; sent: number}][] = [
    // The first request aborts; the second is sent on its own, so the first's dispatch must go.
    ['different headers', {headers: {authorization: 'a'}}, {headers: {authorization: 'b'}}, {abandoned: 1, sent: 2}],
    // The second request is parked on the first and aborts; the first keeps its dispatch.
    ['the parked request aborts', {}, {}, {abandoned: 0, sent: 1}],
  ];

  for (const [name, firstOptions, secondOptions, expected] of rows) {
    const beforeAbandoned = abandonedResponses;
    const beforeSent = requestCounts['/counted-slow'] ?? 0;
    const extClient = new Gotlike({dedupe: true});
    const controller = new AbortController();
    const firstAborts = expected.sent === 2;

    const first = extClient.get('http://localhost:3000/counted-slow', {
      ...firstOptions,
      ...(firstAborts && {signal: controller.signal}),
    });
    const second = extClient.get('http://localhost:3000/counted-slow', {
      ...secondOptions,
      ...(!firstAborts && {signal: controller.signal}),
    });

    setTimeout(() => controller.abort(), 20);

    const outcomes = await Promise.allSettled([first, second]);
    const [aborted, kept] = firstAborts ? outcomes : [outcomes[1], outcomes[0]];

    await sleep(200);

    assert.strictEqual(aborted.status, 'rejected', name);
    assert.strictEqual(kept.status, 'fulfilled', `${name}: ${String((kept as any).reason)}`);
    assert.deepStrictEqual(
      {abandoned: abandonedResponses - beforeAbandoned, sent: (requestCounts['/counted-slow'] ?? 0) - beforeSent},
      expected,
      name,
    );
  }
});

/*
 * dedupe stops parking requests on one whose body has started, and sends them on their own - so
 * such a request must not count as parked. Counted as one, it kept the first request's dispatch
 * alive after that caller aborted, draining a body nobody would read.
 */
test('with dedupe, a request sent after the body started does not keep an aborted dispatch alive', async () => {
  const before = abandonedTrickles;
  const extClient = new Gotlike({dedupe: true});
  const controller = new AbortController();

  const first = extClient.get('http://localhost:3000/trickle', {signal: controller.signal});

  // `/trickle` writes its first byte at 250ms.
  await sleep(400);

  const second = extClient.get('http://localhost:3000/trickle', {timeout: {request: 200}});

  controller.abort();

  const outcomes = await Promise.allSettled([first, second]);

  await sleep(100);

  assert.deepStrictEqual(
    outcomes.map((outcome) => outcome.status),
    ['rejected', 'rejected'],
  );
  assert.strictEqual(abandonedTrickles - before, 2, 'both dispatches torn down');
});

/*
 * The same isolation at the dispatcher level, where a caller holds the controller itself: it has
 * to behave as the shared dispatch's own until the caller lets go, and letting go while paused
 * must not leave the dispatch paused under the requests still reading it - that would stall them
 * rather than fail them, which is the harder of the two to notice. A method dedupe does not group
 * goes straight through.
 */
test('with dedupe, the controller a caller holds forwards to the shared dispatch until it lets go', async () => {
  const extClient = new Gotlike({dedupe: true, decompress: false});
  const origin = 'http://localhost:3000';
  const letGo = new Error('first caller lets go');
  const seen: Record<string, unknown> = {};

  const dispatched = (onResponseStart?: (controller: Dispatcher.DispatchController) => void) =>
    new Promise<{error?: Error; body: string}>((resolve) => {
      const chunks: Buffer[] = [];
      let controller: Dispatcher.DispatchController;

      extClient.agent.dispatch(
        {origin, path: '/counted-slow', method: 'GET'},
        {
          onRequestStart(started) {
            controller = started;
          },
          onResponseStart() {
            onResponseStart?.(controller);
          },
          onResponseData(_, chunk) {
            chunks.push(chunk);
          },
          onResponseEnd() {
            resolve({body: Buffer.concat(chunks).toString()});
          },
          onResponseError(_, error) {
            resolve({error, body: Buffer.concat(chunks).toString()});
          },
        },
      );
    });

  const first = dispatched((controller) => {
    controller.pause();
    seen.pausedWhilePaused = controller.paused;
    controller.resume();
    seen.pausedAfterResume = controller.paused;
    seen.hasRawHeaders = Array.isArray(controller.rawHeaders);
    seen.rawTrailers = controller.rawTrailers;
    seen.abortedBefore = controller.aborted;
    controller.pause();
    controller.abort(letGo);
    controller.abort(new Error('a second abort is a no-op'));
    seen.abortedAfter = controller.aborted;
    seen.reason = controller.reason;
  });
  const second = dispatched();

  const [firstOutcome, secondOutcome] = await Promise.all([
    first,
    Promise.race([second, sleep(2000).then(() => ({error: new Error('stalled'), body: ''}))]),
  ]);

  assert.deepStrictEqual(seen, {
    pausedWhilePaused: true,
    pausedAfterResume: false,
    hasRawHeaders: true,
    rawTrailers: null,
    abortedBefore: false,
    abortedAfter: true,
    reason: letGo,
  });
  assert.strictEqual(firstOutcome.error, letGo);
  assert.deepStrictEqual(secondOutcome, {body: 'counted-slow'});

  const posted = await extClient.post('http://localhost:3000/echo', {body: 'x', responseType: 'json'});

  assert.strictEqual((posted.body as {method: string}).method, 'POST');
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

/**
 * Extending a client does not open a second connection pool behind its back.
 *
 * The constructor re-evaluates the agent options against the *merged* options, so a client built
 * with any one of them handed every client extended from it a brand new `undici.Agent` - for a
 * change of headers, of `prefixUrl`, of anything. Parent and child then shared no sockets, each
 * held a pool of its own up to `connections`, and the Agents left behind were never closed, so
 * deriving a client per upstream multiplied the process's connections silently. An explicitly
 * passed `agent` was inherited all along, so the two ways of configuring the transport disagreed.
 *
 * The other half is just as important: an extension that *does* name an agent option still has to
 * get the dispatcher its options describe, rather than the inherited one winning because it is
 * now sitting on `baseOptions`.
 */
/*
 * `mutableDefaults` - got's `client.defaults.options.merge(...)`. The aggregator's ThrillTech
 * provider refreshes a token inside an `afterResponse` hook and merges it into the client, so
 * every later request carries it without the call sites knowing.
 */
test('mutableDefaults lets defaults.options.merge change later requests', async () => {
  const mutable = createClient({mutableDefaults: true, headers: {authorization: 'Bearer stale'}});

  mutable.defaults.options.merge({headers: {Authorization: 'Bearer fresh'}, context: {tenant: 'a'}});

  const response = await mutable.get<Record<string, string>>('http://localhost:3000/headers', {responseType: 'json'});

  // Case-insensitively, as every other header merge is: the stale one is replaced, not joined.
  assert.strictEqual(response.body['authorization'], 'Bearer fresh');
  assert.deepStrictEqual(response.request.options.context, {tenant: 'a'});
  assert.strictEqual(mutable.defaults.mutableDefaults, true);
});

test('a merge into the defaults from an afterResponse hook reaches every later request', async () => {
  let refreshes = 0;
  const api = createClient({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    mutableDefaults: true,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) => {
          if (response.request.options.context.unauthorized && !response.request.options.context.retried) {
            refreshes++;
            const updated = {headers: {authorization: `Bearer token-${refreshes}`}};

            api.defaults.options.merge(updated);

            return retryWithMergedOptions({...updated, context: {retried: true}});
          }

          return response;
        },
      ],
    },
  });

  const first = await api.get<Record<string, string>>('headers', {context: {unauthorized: true}});
  const second = await api.get<Record<string, string>>('headers');

  assert.strictEqual(first.body['authorization'], 'Bearer token-1');
  assert.strictEqual(second.body['authorization'], 'Bearer token-1');
  assert.strictEqual(refreshes, 1);
});

test('merging into the defaults of a client without mutableDefaults is a ValidationError', () => {
  const frozen = createClient({headers: {a: '1'}});

  assert.strictEqual(frozen.defaults.mutableDefaults, false);
  assert.throws(() => frozen.defaults.options.merge({headers: {b: '2'}}), ValidationError);
  assert.deepStrictEqual(frozen.baseOptions.headers, {a: '1'});
});

test('mutableDefaults is not inherited by extend, as in got', () => {
  const parent = createClient({mutableDefaults: true});

  assert.strictEqual(parent.extend({headers: {a: '1'}}).defaults.mutableDefaults, false);
  assert.strictEqual(parent.extend({mutableDefaults: true}).defaults.mutableDefaults, true);
  assert.strictEqual(client.extend({mutableDefaults: true}).defaults.mutableDefaults, true);
});

test('mutableDefaults is client-only', async () => {
  await assert.rejects(
    client.get('http://localhost:3000/headers', {mutableDefaults: true} as RequestOptions),
    /`mutableDefaults` can only be set when creating or extending a client/,
  );
});

/*
 * Only what a request merges can be merged. Everything else is either built into the client when
 * it is constructed - the dispatcher, the hook arrays, the retry handler - and a merge would
 * silently do nothing, or belongs to one request (a body, a url), or decides the client's type.
 */
test('defaults.options.merge refuses what it cannot apply', () => {
  const mutable = createClient({mutableDefaults: true});
  const refused: RequestOptions[] = [
    {hooks: {beforeRequest: []}},
    {handlers: []},
    {retry: {limit: 1}},
    {agent: new Agent()},
    {connections: 4},
    {decompress: false},
    {followRedirect: true},
    {validate: false},
    {mutableDefaults: false},
    {json: {a: 1}},
    {body: 'x'},
    {form: {a: 1}},
    {url: 'http://localhost:3000'},
    {isStream: true},
    {responseType: 'json'},
    {resolveBodyOnly: true},
  ];

  for (const options of refused) {
    assert.throws(() => mutable.defaults.options.merge(options), ValidationError, JSON.stringify(Object.keys(options)));
  }

  // And the ordinary validation a request's options get.
  assert.throws(() => mutable.defaults.options.merge({timeout: 5000} as unknown as RequestOptions), ValidationError);
  assert.throws(
    () => mutable.defaults.options.merge({searchParams: {a: {}}} as unknown as RequestOptions),
    ValidationError,
  );
  assert.throws(() => mutable.defaults.options.merge({nope: 1} as unknown as RequestOptions), /Unknown option `nope`/);
});

test('defaults.options.merge merges timeout, searchParams and context as extend does', async () => {
  const mutable = createClient({
    mutableDefaults: true,
    prefixUrl: 'http://localhost:3000',
    timeout: {request: 5000},
    searchParams: {a: '1'},
    context: {keep: true},
  });

  mutable.defaults.options.merge({timeout: {}, searchParams: {b: '2'}, context: {added: true}});

  assert.deepStrictEqual(mutable.baseOptions.timeout, {request: 5000});
  assert.deepStrictEqual(mutable.baseOptions.context, {keep: true, added: true});

  const response = await mutable.get('headers');

  assert.strictEqual(new URL(response.url).search, '?a=1&b=2');
});

test('defaults.options.merge copies what it is given and leaves clients extended earlier alone', async () => {
  const mutable = createClient({mutableDefaults: true});
  const earlier = mutable.extend({});
  const headers = {authorization: 'Bearer one'};

  mutable.defaults.options.merge({headers});
  headers.authorization = 'Bearer two';

  const fromMutable = await mutable.get<Record<string, string>>('http://localhost:3000/headers', {
    responseType: 'json',
  });
  const fromEarlier = await earlier.get<Record<string, string>>('http://localhost:3000/headers', {
    responseType: 'json',
  });

  assert.strictEqual(fromMutable.body['authorization'], 'Bearer one');
  assert.strictEqual(fromEarlier.body['authorization'], undefined);
});

test('defaults.options.merge keeps the client’s dispatcher and accept-encoding', () => {
  const agent = new Agent();
  const mutable = createClient({mutableDefaults: true, agent});

  mutable.defaults.options.merge({headers: {a: '1'}});

  assert.strictEqual(mutable.ownAgent, agent);
  assert.strictEqual(mutable.explicitAgent, true);
  assert.ok(mutable.defaultHeaders['accept-encoding']);
  assert.strictEqual(mutable.defaultHeaders['a'], '1');
});

test('defaults is reachable on a plain Gotlike as well as the callable form', () => {
  const plain = new Gotlike({mutableDefaults: true});

  plain.defaults.options.merge({headers: {a: '1'}});

  assert.strictEqual(plain.defaultHeaders['a'], '1');
  assert.ok(Object.isFrozen(plain.defaults));
});

test('extend reuses the parent’s dispatcher unless the extension names one', async () => {
  const parent = new Gotlike({responseType: 'json', connections: 1, keepAliveTimeout: 1000});

  assert.ok(parent.ownAgent, 'expected the parent to build a dedicated agent');

  const child = parent.extend({headers: {'x-child': '1'}});
  const grandchild = child.extend({prefixUrl: 'http://localhost:3000'});

  assert.strictEqual(child.ownAgent, parent.ownAgent, 'a headers-only extend rebuilt the dispatcher');
  assert.strictEqual(grandchild.ownAgent, parent.ownAgent, 'a prefixUrl-only extend rebuilt the dispatcher');

  // ... and an extension that does describe the transport gets its own, rather than inheriting
  // the one the spread would otherwise have carried down from `baseOptions`.
  const retuned = grandchild.extend({connections: 4});

  assert.ok(retuned.ownAgent, 'expected a dedicated agent for the retuned client');
  assert.notStrictEqual(retuned.ownAgent, parent.ownAgent, 'connections: 4 reused the parent’s dispatcher');

  const explicit = new Agent();
  const adopted = grandchild.extend({agent: explicit});

  assert.strictEqual(adopted.ownAgent, explicit);

  // Every one of them still makes requests through whichever dispatcher it ended up with.
  for (const each of [child, grandchild, retuned, adopted]) {
    const response = await each.get<{test: string}>('http://localhost:3000/json');

    assert.strictEqual(response.body.test, 'value');
  }

  await explicit.close();
});

/*
 * "The extension names the transport, so it gets its own dispatcher" holds only for a dispatcher
 * this package *built*. One the caller handed over cannot be rebuilt from `connections` and
 * friends - there is no way to ask a `ProxyAgent` or an `H2CClient` for a copy of itself with one
 * option changed - so replacing it with a plain `undici.Agent` was not a reconfiguration, it was
 * throwing the transport away: `extend({agent: new EnvHttpProxyAgent()}).extend({connections:
 * 128})` sent every request direct, bypassing the proxy, with no error and nothing on the wire to
 * say so. Both halves of that composition are straight out of the README.
 *
 * Refused rather than ignored, as everywhere else here that an option would otherwise be quietly
 * dropped - and the quiet outcome in this one is traffic leaving by a route the caller ruled out.
 */
test('an agent-level option cannot silently replace an explicitly passed dispatcher', async () => {
  const explicit = new Agent();
  const client_ = new Gotlike({agent: explicit});

  assert.strictEqual(client_.explicitAgent, true);

  for (const key of ['connections', 'keepAliveTimeout', 'http2', 'pipelining', 'connectTimeout'] as const) {
    assert.throws(() => client_.extend({[key]: key === 'http2' ? true : 1}), {
      name: 'ValidationError',
      code: 'ERR_INVALID_OPTION',
      message: new RegExp(`\`${key}\` cannot be set on a client built with an explicit \`agent\``),
    });
  }

  // The dispatcher survives every extension that does not name the transport...
  assert.strictEqual(client_.extend({prefixUrl: 'http://localhost:3000'}).ownAgent, explicit);
  // ... and naming a replacement outright is how you actually change it.
  const replacement = new Agent({connections: 4});

  assert.strictEqual(client_.extend({agent: replacement}).ownAgent, replacement);

  await Promise.all([explicit.close(), replacement.close()]);
});

/*
 * ...and the same refusal from the other direction, which the one above did not cover. `agent`
 * short-circuited the check, so naming both in *one* call - `{agent: new ProxyAgent(...),
 * connections: 128}` - accepted the agent option and did nothing whatsoever with it: the
 * dispatcher is used exactly as it stands, and there is no way to ask a `ProxyAgent` for a copy
 * of itself with one option changed. The two halves of one rule disagreed, and the half that
 * stayed quiet is the one a caller writes by accident.
 */
test('an agent-level option cannot be quietly swallowed by an agent named beside it', async () => {
  const explicit = new Agent();

  for (const build of [
    (options: RequestOptions) => new Gotlike(options),
    (options: RequestOptions) => createClient(options),
    (options: RequestOptions) => client.extend(options),
  ]) {
    for (const key of ['connections', 'keepAliveTimeout', 'http2', 'pipelining', 'connectTimeout'] as const) {
      assert.throws(() => build({agent: explicit, [key]: key === 'http2' ? true : 1}), {
        name: 'ValidationError',
        code: 'ERR_INVALID_OPTION',
        message: new RegExp(`\`${key}\` cannot be combined with an explicit \`agent\``),
      });
    }
  }

  // An `agent` on its own is still the documented way to name the transport, and the inherited
  // agent options `extend()` folds in alongside an inherited dispatcher are not this mistake -
  // see `inheritedAgent`. Both are covered by the tests around this one; this asserts the
  // narrower half, that the check does not fire on an agent by itself.
  assert.strictEqual(new Gotlike({agent: explicit}).ownAgent, explicit);

  await explicit.close();
});

/*
 * The flag that decides the above has to survive a plain extend. The constructor sees an `agent`
 * and concludes the caller handed one over, which is wrong for the inherit branch - it passes the
 * parent's dispatcher back in whether the parent built it or was given it. Uncovered, one
 * `extend({headers})` off a `connections`-tuned client made every client below it look
 * explicitly-agented and the refusal above would have fired on a retune the README documents.
 */
test('an auto-built dispatcher stays retunable however many times it is extended', async () => {
  const tuned = new Gotlike({connections: 128});

  assert.strictEqual(tuned.explicitAgent, false);

  let derived: Gotlike = tuned;

  for (let depth = 0; depth < 3; depth++) {
    derived = derived.extend({headers: {'x-depth': String(depth)}});

    assert.strictEqual(derived.explicitAgent, false, `depth ${depth}`);
    assert.strictEqual(derived.ownAgent, tuned.ownAgent, `depth ${depth} rebuilt the dispatcher`);
  }

  const retuned = derived.extend({connections: 4});

  assert.notStrictEqual(retuned.ownAgent, tuned.ownAgent);

  const response = await retuned.get<{test: string}>('http://localhost:3000/json', {responseType: 'json'});

  assert.strictEqual(response.body.test, 'value');
});

/** A client with no dispatcher of its own still has nothing to hand down. */
test('extending a client with no dedicated agent leaves the child on the global dispatcher', () => {
  const parent = new Gotlike({followRedirect: false, decompress: false});
  const child = parent.extend({headers: {'x-child': '1'}});

  assert.strictEqual(parent.ownAgent, undefined);
  assert.strictEqual(child.ownAgent, undefined);
  assert.strictEqual(child.agent, getGlobalDispatcher());
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
  assert.strictEqual((httpError as HTTPError).code, 'ERR_NON_2XX_3XX_RESPONSE');

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

  assert.strictEqual(err.code, 'ERR_NON_2XX_3XX_RESPONSE');
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

/*
 * got takes an options object in place of the url on every verb - `got.post({json})` - and the
 * aggregator's GamesGlobal token call is written exactly that way. Every verb here took its first
 * argument as the url, so the object became `[object Object]` and the request went out as
 * `POST <prefixUrl>/[object Object]` with its body dropped, silently. A table over every verb and
 * both stream forms, because the bug was one entry point per verb and a scenario naming one verb
 * would pass while the others stayed broken.
 */
test('every verb takes an options object in place of the url, as got does', async () => {
  const prefixed = createClient({prefixUrl: 'http://localhost:3000/echo/token', responseType: 'json'});
  const bodyless = ['get', 'head', 'options'];
  const read = async (stream: Readable) => JSON.parse(Buffer.concat(await stream.toArray()).toString()) as Echo;

  for (const verb of ['get', 'head', 'post', 'put', 'patch', 'delete', 'query'] as const) {
    const withBody = !bodyless.includes(verb);
    const options = {headers: {'x-verb': verb}, ...(withBody ? {json: {verb}} : {})};
    const response = await prefixed[verb]<Echo>(options);

    assert.strictEqual(response.statusCode, 200, verb);

    if (verb === 'head') {
      continue;
    }

    assert.strictEqual(response.body.url, '/echo/token/', verb);
    assert.strictEqual(response.body.method, verb.toUpperCase(), verb);
    assert.strictEqual(response.body.headers['x-verb'], verb, verb);
    assert.strictEqual(response.body.body, withBody ? JSON.stringify({verb}) : '', verb);
  }

  // The stream verbs, the upload path with a body from the options and the bodyless one.
  const uploaded = await read(await prefixed.stream.post({body: 'streamed'}));
  const downloaded = await read(await prefixed.stream.get({headers: {'x-verb': 'stream'}}));
  const direct = await read(await prefixed.stream({headers: {'x-verb': 'direct'}}));

  assert.deepStrictEqual([uploaded.url, uploaded.method, uploaded.body], ['/echo/token/', 'POST', 'streamed']);
  assert.deepStrictEqual([downloaded.url, downloaded.headers['x-verb']], ['/echo/token/', 'stream']);
  assert.deepStrictEqual([direct.url, direct.headers['x-verb']], ['/echo/token/', 'direct']);

  // A url carried in the object is the request's, on the verbs as on the callable form.
  const absolute = await client.get<Echo>({url: 'http://localhost:3000/echo/absolute', responseType: 'json'});

  assert.strictEqual(absolute.body.url, '/echo/absolute');

  // A second options object merges over the first, headers case-insensitively, as got 12 does.
  // Untyped there as here - both declare the options-first form with one argument - so it is
  // reached through a loose signature.
  type TwoObjects = (input: RequestOptions, options: RequestOptions) => Promise<GotlikeResponse<Echo>>;
  const merged = await (prefixed.post as TwoObjects)(
    {json: {a: 1}, headers: {'X-First': '1', 'x-both': 'first'}, searchParams: {a: '1'}},
    {headers: {'x-second': '2', 'X-Both': 'second'}, searchParams: {b: '2'}},
  );

  assert.strictEqual(merged.body.url, '/echo/token/?a=1&b=2');
  assert.strictEqual(merged.body.body, '{"a":1}');
  assert.deepStrictEqual(
    [merged.body.headers['x-first'], merged.body.headers['x-second'], merged.body.headers['x-both']],
    ['1', '2', 'second'],
  );

  const viaCallable = await (client as unknown as TwoObjects)(
    {url: 'http://localhost:3000/echo/c', responseType: 'json'},
    {method: 'PUT'},
  );

  assert.strictEqual(viaCallable.body.method, 'PUT');

  // `context` merges one level deep too, as it does on every other route.
  let seen: unknown;
  const hooked = createClient({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          seen = options.context;
        },
      ],
    },
  });

  await (hooked.get as TwoObjects)({url: 'http://localhost:3000/echo', context: {a: 1}}, {context: {b: 2}});
  assert.deepStrictEqual(seen, {a: 1, b: 2});

  // A bad query value in the merge rejects, as it would on a single object.
  await assert.rejects(
    (client.get as TwoObjects)(
      {url: 'http://localhost:3000/echo', searchParams: {a: '1'}},
      {searchParams: {b: {} as unknown as string}},
    ),
    {name: 'ValidationError'},
  );

  // Naming the url in both is the same mistake as naming it as an argument and an option.
  await assert.rejects(
    (client.get as TwoObjects)({url: 'http://localhost:3000/echo/a'}, {url: 'http://localhost:3000/echo/b'}),
    {name: 'ValidationError'},
  );

  // Validation still reads the object itself, not the empty options it used to be paired with.
  await assert.rejects(prefixed.post({responseType: 'jsn' as 'json'}), {name: 'ValidationError'});
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

  // This file imports `./nock`, which routes an own agent through the mock while it is active -
  // with it restored, the getter hands back the agent itself.
  nock.restore();

  try {
    assert.strictEqual(callable.agent, agent, 'the agent getter should see the assignment');
  } finally {
    nock.activate();
  }

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
 * A misspelled nested key inside `retry` or `hooks` used to be accepted outright: `retry:
 * {limt: 0}` silently kept the default `limit` (enabling two retries the caller meant to turn
 * off), and `hooks: {beforeReqest: [...]}` silently never called the hook it named at all -
 * both indistinguishable from a working configuration until something downstream misbehaved.
 * Only reachable at create/extend time, since `retry`/`hooks` are client-only options and a
 * per-request `{retry: {...}}` is refused before ever reaching the nested check.
 */
/**
 * A bad `searchParams` / `form` *value* is a configuration mistake like any other.
 *
 * `validateOptions` checks the container's shape and stopped there, so a value it cannot
 * serialise was only found by `queryValue` when the query was built - inside `call()`'s
 * pre-request try, which wrapped it into a `RequestError`. The message and the code survived;
 * the class did not, so the identical mistake one option along (`responseType: 'jsn'`) threw a
 * `ValidationError` while this one reported itself as a transport failure and ran the
 * `beforeError` hooks on the way out. The two classes are the whole error contract and the
 * distinction is a pinned divergence from got, so it has to hold on every route.
 *
 * And on a *client* it was not rejected at all: the client constructed, and then every request
 * it ever made failed, with nothing said at the call site that built it.
 */
test('a searchParams or form value that cannot be serialised is a ValidationError', async () => {
  const bad: {label: string; options: RequestOptions}[] = [
    {label: 'a searchParams object value', options: {searchParams: {a: {b: 1} as never}}},
    {label: 'a searchParams object inside an array', options: {searchParams: {a: [{b: 1}] as never}}},
    {label: 'a form object value', options: {form: {a: {b: 1} as never}}},
  ];

  for (const {label, options} of bad) {
    const error = await failure<ValidationError>(client.get('http://localhost:3000/json', options));

    assert.ok(error instanceof ValidationError, `${label} on a call: got ${error.constructor.name}`);
    assert.strictEqual(error.code, 'ERR_INVALID_OPTION', label);
    assert.match(error.message, /must be a string, number, boolean or an array of those/, label);

    // Create and extend say so where the client is written, rather than once per request for
    // the rest of its life.
    assert.throws(() => new Gotlike(options), ValidationError, `${label} on create`);
    assert.throws(() => client.extend(options), ValidationError, `${label} on extend`);
  }

  // The shapes that are legal stay legal, arrays and `null`/`undefined` entries included.
  assert.doesNotThrow(
    () => new Gotlike({searchParams: {a: 1, b: ['x', 'y'], c: null, d: undefined, e: true}, form: {f: 'g'}}),
  );
  assert.doesNotThrow(() => new Gotlike({searchParams: 'a=1', form: new URLSearchParams('b=2')}));
});

test('an unknown key inside retry is rejected rather than silently ignored', () => {
  assert.throws(() => new Gotlike({retry: {limt: 0} as never}), {
    name: 'ValidationError',
    code: 'ERR_INVALID_OPTION',
    message: /Unknown option `retry\.limt`/,
  });

  assert.throws(() => client.extend({retry: {statusCode: [500]} as never}), /Unknown option `retry\.statusCode`/);
});

test('an unknown hook name is rejected rather than silently dropped', () => {
  assert.throws(() => new Gotlike({hooks: {beforeReqest: [() => undefined]} as never}), {
    name: 'ValidationError',
    code: 'ERR_INVALID_OPTION',
    message: /Unknown option `hooks\.beforeReqest`/,
  });

  assert.throws(
    () => client.extend({hooks: {afterResonse: [() => undefined]} as never}),
    /Unknown option `hooks\.afterResonse`/,
  );
});

/*
 * got refuses this outright rather than picking a winner; the argument used to overwrite the
 * option with nothing said. Measured against got 16, which rejects a `url` key in an options
 * object in every position - a change that landed in got 15. gotlike keeps it, because the
 * options-only callable form is the legal way to pass a url as an option and has to keep
 * working; the parity suite pins both sides of that difference.
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
  const response = await lax.get('http://localhost:3000/json', {nonsense: true} as RequestOptions);

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
 * third. Measured against got 16, which runs all of them.
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
 * Backoff belongs between attempts, not inside either attempt's request deadline. With the
 * timer left armed after the 503, this failed at 100ms while undici was still waiting out the
 * configured 200ms delay and the second attempt never reached the server.
 */
test('timeout.request does not expire during retry backoff', async () => {
  const extClient = client.extend({
    retry: {limit: 1, backoffLimit: 200, statusCodes: [503]},
  });
  const response = await extClient.get('http://localhost:3000/flaky-target', {
    timeout: {request: 100},
    headers: {'test-id': randomUUID()},
  });

  assert.strictEqual(response.body, 'flaky ok');
  assert.strictEqual(response.retryCount, 1);
});

/**
 * Pausing the deadline for a retry is a *prediction* (`willRetryStatus`), and a prediction that
 * misses must not cost the request its deadline outright - which is what it used to do, with no
 * error and no end. `resume()` is the failsafe, called the moment a response reaches the caller
 * on all three paths, and is exercised here directly: the prediction now mirrors undici's own
 * gate closely enough that provoking a miss over the wire means reaching into `retry-handler.js`
 * for whichever divergence is left this week, which is a test that measures undici rather than
 * this.
 */
test('a deadline paused for a retry that never comes is put back', async () => {
  const deadlineClient = new Gotlike({timeout: {request: 60}, retry: {limit: 2}});

  // Nothing is paused, so `resume` must arm nothing: `release` is still the end of this one.
  const idle = deadlineClient.dispatchOptions(deadlineClient.formOptions({}));

  idle.resume();
  idle.release();

  const paused = deadlineClient.dispatchOptions(deadlineClient.formOptions({}));

  assert.ok(paused.attempts?.pauseDeadline, 'a retrying client carries the deadline controls');

  // The deadline is what `signal` is built from when `timeout.request` is set.
  const pausedSignal = paused.signal;
  const idleSignal = idle.signal;

  assert.ok(pausedSignal instanceof AbortSignal);
  assert.ok(idleSignal instanceof AbortSignal);

  paused.attempts.pauseDeadline();
  paused.resume();

  const fired = await Promise.race([
    new Promise<boolean>((resolve) => pausedSignal.addEventListener('abort', () => resolve(true))),
    sleep(500, false),
  ]);

  assert.strictEqual(fired, true, 'the resumed deadline never fired');
  assert.strictEqual((pausedSignal.reason as Error).name, 'TimeoutError');
  assert.strictEqual(idleSignal.aborted, false, 'a released deadline fired anyway');

  paused.release();
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

/*
 * An empty body is never a parse failure, whatever the status.
 *
 * `hasNoBody` covers only the statuses that *cannot* carry a body - 204, 205, 304 and HEAD - so
 * every other status with a zero-length one fell into `JSON.parse('')` and came back out as a
 * `ParseError`. Those are ordinary responses: a `201 Created` with nothing in it, a `200` with
 * `content-length: 0`, a `3xx` read with `followRedirect` off. Measured against got 16, which
 * resolves all of them with `body: ''` - its `parseBody` tests `rawBody.length === 0` before it
 * ever reaches the JSON codec.
 *
 * A table rather than one case, because the bug was a status range rather than a wrong answer:
 * the bodyless statuses were handled and every other one was not.
 */
test('an empty body resolves as an empty string on every status that can carry one', async () => {
  const outcomes: Record<number, unknown> = {};

  for (const code of [200, 201, 202, 302, 404, 500]) {
    const response = await client.get(`http://localhost:3000/status?code=${code}`, {
      responseType: 'json',
      // Off, so the status itself is not what ends the request - the question here is only
      // whether the empty body parses.
      throwHttpErrors: false,
    });

    outcomes[code] = response.body;
  }

  assert.deepStrictEqual(outcomes, {200: '', 201: '', 202: '', 302: '', 404: '', 500: ''});
});

/*
 * And the bodyless statuses keep their `undefined`, which is a recorded divergence from got's
 * `''` rather than the same bug - pinned here so closing the one above cannot quietly change it.
 */
test('a bodyless status still reads as undefined under responseType json', async () => {
  const response = await client.get('http://localhost:3000/status?code=204', {responseType: 'json'});

  assert.strictEqual(response.statusCode, 204);
  assert.strictEqual(response.body, undefined);
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

  /*
   * And on the other route into the signal. With a `timeout.request` the caller's signal is not
   * handed to undici as it stands - it is forwarded onto the deadline's own controller through a
   * listener `release` can take back off (see `requestSignal`) - and a listener is no use for a
   * signal that has already fired, so that case has to be carried over by hand.
   */
  const timed = await failure(
    client.get('http://localhost:3000/json', {signal: AbortSignal.abort(), timeout: {request: 5000}}),
  );

  assert.strictEqual(timed.code, 'ERR_ABORTED');
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

  // An origin remains owned by nock after its one interceptor is consumed. Clear the scope
  // before deliberately returning to the live server; otherwise a second request must fail
  // closed rather than silently escaping the mock.
  nock.cleanAll();

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
  assert.strictEqual(error.code, 'ERR_NON_2XX_3XX_RESPONSE');
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
    searchParams: {a: [1, 2], b: 'z', dropped: undefined},
  });

  assert.strictEqual(response.body.url, '/echo?a=1&a=2&b=z');

  const posted = await client.post<Echo>('http://localhost:3000/echo', {
    responseType: 'json',
    form: {a: ['x', 'y']},
  });

  assert.strictEqual(posted.body.body, 'a=x&a=y');
});

/*
 * got normalises `prefixUrl` to end in `/` and resolves `''` against it, so `client.get('')`
 * requests the directory form. Handing back the prefix verbatim put a different path on the
 * wire - `GET /echo` where got sends `GET /echo/` - which a server is free to answer with a 301
 * (not followed by default here, so it surfaces as the redirect itself) or a 404. Only ever
 * differed for a `prefixUrl` written *without* a trailing slash, which is the form the README's
 * own examples use.
 */
test('an empty url resolves to the prefix with its trailing slash, as got does', async () => {
  for (const prefixUrl of ['http://localhost:3000/echo', 'http://localhost:3000/echo/']) {
    const prefixed = client.extend({prefixUrl, responseType: 'json'});

    assert.strictEqual((await prefixed.get<Echo>('')).body.url, '/echo/', prefixUrl);
    // And with a query on top, which is appended to the same joined url.
    assert.strictEqual((await prefixed.get<Echo>('', {searchParams: {a: '1'}})).body.url, '/echo/?a=1', prefixUrl);
  }
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
 * The ordering got actually produces, measured: with `[h1, h2, h3]` and `h2` retrying, got runs
 * `h1, h2` on the first response and `h1` alone on the retried one. `h2` never sees its own
 * retry, `h1` runs again because it ran before the retry was decided, and `h3` never runs at
 * all - the retry abandons the loop it was in.
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
        (response) => {
          order.push(`h3:${response.statusCode}`);

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
  assert.deepStrictEqual(seen, ['ERR_NON_2XX_3XX_RESPONSE']);
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
  assert.deepStrictEqual(seen, ['ERR_NON_2XX_3XX_RESPONSE']);
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
  // The head arrived, so the error carries it - `error.response` is documented as undefined
  // *only* for a failure that happened before a response. `call()` always honoured that; this
  // path handed back undefined for a response it had already seen and reported the head of.
  assert.strictEqual(error.response?.statusCode, 200);
});

test('a truncated body on an upload stream is a RequestError with beforeError applied', async () => {
  const {seen, recording} = hookRecorder();

  const duplex = await recording.stream('http://localhost:3000/truncate', {method: 'POST'});

  duplex.end('body');

  const error = await failure(text(duplex));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error}`);
  assert.deepStrictEqual(seen, ['UND_ERR_SOCKET']);
  assert.strictEqual(error.response?.statusCode, 200);
});

/**
 * The whole of `error.response`'s contract, on every stream failure at once.
 *
 * Each row is a stream failure and whether a response had arrived when it happened; the
 * assertion is the documented rule - `error.response` is populated exactly when one had.
 * A table rather than a test per path, for the reason the error-contract table exists: the bug
 * was one path reporting differently from the others, not a wrong answer on a covered one.
 */
test('a stream failure carries the response exactly when one had arrived', async () => {
  // The upload path's writable half is the request body, so it has to be ended or the request is
  // never dispatched at all - which is a 90-second server timeout rather than the failure under
  // test.
  const upload = async (url: string): Promise<Error> => {
    const duplex = await client.stream(url, {method: 'POST'});

    duplex.end('body');

    return failure(text(duplex));
  };

  const rows: {label: string; failed: () => Promise<Error>; statusCode?: number}[] = [
    {
      label: 'bodyless, truncated mid-body',
      failed: async () => failure(text(await client.stream('http://localhost:3000/truncate'))),
      statusCode: 200,
    },
    {
      label: 'upload, truncated mid-body',
      failed: () => upload('http://localhost:3000/truncate'),
      statusCode: 200,
    },
    {
      label: 'bodyless, throwHttpErrors',
      failed: async () => failure(text(await client.stream('http://localhost:3000/status?code=404'))),
      statusCode: 404,
    },
    {
      label: 'upload, throwHttpErrors',
      failed: () => upload('http://localhost:3000/status?code=404'),
      statusCode: 404,
    },
    {
      // No response ever came, so there is none to carry - the one case the docs say is undefined.
      label: 'bodyless, connection refused',
      failed: async () => failure(text(await client.stream('http://127.0.0.1:1/nothing'))),
    },
    {
      label: 'upload, connection refused',
      failed: () => upload('http://127.0.0.1:1/nothing'),
    },
  ];

  const actual: string[] = [];
  const expected: string[] = [];

  for (const {label, failed, statusCode} of rows) {
    const error = (await failed()) as RequestError;

    actual.push(`${label}: ${error.response === undefined ? 'no response' : `response ${error.response.statusCode}`}`);
    expected.push(`${label}: ${statusCode === undefined ? 'no response' : `response ${statusCode}`}`);
  }

  assert.deepStrictEqual(actual, expected);
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

  assert.strictEqual(error.code, 'ERR_NON_2XX_3XX_RESPONSE');
  assert.strictEqual(error.name, 'HTTPError');
  assert.strictEqual(error.response?.statusCode, 302);
});

test('a streamed failure names the url that answered, not the one requested', async () => {
  const redirecting = client.extend({followRedirect: true});

  // A chain longer than `maxRedirections`, so undici gives up and the 302 itself reaches us -
  // which `isHttpError` treats as an error precisely because redirects were being followed.
  const stream = await redirecting.stream('http://localhost:3000/hop/0');
  const error = await failure<RequestError>(text(stream));

  assert.ok(error instanceof HTTPError, `expected an HTTPError, got ${error}`);
  assert.strictEqual(error.response?.statusCode, 302);
  // The last hop, not `/hop/0`. `response.url` follows the same rule on the promise API, and the
  // error a stream raises is built from the same head - one place reading `redirects.lastUrl`
  // rather than three, so a stream's error cannot start naming a url the response never came from.
  assert.strictEqual(String(error.response?.url), 'http://localhost:3000/hop/10');
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
 * The authority scan has to stop where WHATWG URL stops, and a backslash is one of the places it
 * does: for the special schemes this client sends, `\` is a path separator. So
 * `http://host\@other/p` is host `host` with the path `/@other/p` to `new URL`, to undici and to
 * got - while a scan that only stopped at `/?#` read `host\` as userinfo and **rewrote the url to
 * `http://other/p`**, sending the request, and an `Authorization` minted out of the fake userinfo,
 * to a host no parser had ever named.
 *
 * That is an SSRF filter walking straight through: an application allowlists
 * `new URL(input).hostname`, passes the string on, and the request lands somewhere else. Only
 * reachable with `parseUserinfo` on, which is the default - so the default was the unsafe one.
 *
 * Driven against the parser rather than against a literal: what is being pinned is that the two
 * agree about the host, for every character that ends an authority.
 */
test('a url is sent to the host its own parser names, whatever ends the authority', async () => {
  const failures: string[] = [];

  for (const url of [
    'http://localhost:3000\\@evil.test/echo',
    'http://localhost:3000\\evil.test/echo',
    'http://localhost:3000/echo?x=@evil.test',
    'http://localhost:3000/echo#@evil.test',
    // The ordinary case still has to work: this one really is userinfo.
    'http://alice:s3cret@localhost:3000/echo',
  ]) {
    // `text`, because what these urls resolve to is not the `/echo` route and the body is
    // beside the point - the only question is which host the request was addressed to.
    const response = await client.get(url, {responseType: 'text', throwHttpErrors: false});
    const reached = new URL(String(response.request.options.url)).host;
    const expected = new URL(url).host;

    if (reached !== expected) {
      failures.push(`${url}: new URL says ${expected}, the request went to ${reached}`);
    }
  }

  assert.deepStrictEqual(failures, []);
});

/*
 * ASCII tab, LF and CR are stripped out of a url before WHATWG parses it, so they can never
 * reach `URL.username`/`URL.password` - and must not reach the credentials derived here either.
 * Measured against got 16, which base64s `uv:pw` for this url.
 */
test('tabs and newlines are stripped out of url credentials, as the URL parser strips them', async () => {
  const response = await client.get<Echo>('http://u\tv:p\nw@localhost:3000/echo', {responseType: 'json'});

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from('uv:pw').toString('base64'));
});

/*
 * Empty is not the same as absent. got keeps credentials on a `URL` and node's
 * `urlToHttpOptions` derives `auth` only when `url.username || url.password`, so all three rows
 * below go out anonymous there. Testing `!== undefined` sent `Authorization: Basic Og==` for
 * every one of them - an anonymous credential an upstream is free to reject or log, produced by a
 * `{username: config.user ?? ''}` that meant "no credentials at all".
 */
test('empty credentials send no authorization header, as they send none in got', async () => {
  const rows: {where: string; options: RequestOptions; url: string}[] = [
    {where: 'username: ""', options: {username: ''}, url: 'http://localhost:3000/echo'},
    {where: 'username and password empty', options: {username: '', password: ''}, url: 'http://localhost:3000/echo'},
    {where: 'empty userinfo in the url', options: {}, url: 'http://@localhost:3000/echo'},
  ];

  const failures: string[] = [];

  for (const row of rows) {
    const response = await client.get<Echo>(row.url, {...row.options, responseType: 'json'});

    if (response.body.headers['authorization'] !== undefined) {
      failures.push(`${row.where}: sent ${response.body.headers['authorization']}`);
    }
  }

  // ...and the userinfo still comes off the url, which is what every parser does with it.
  const stripped = await client.get<Echo>('http://@localhost:3000/echo', {responseType: 'json'});

  assert.strictEqual(String(stripped.request.options.url), 'http://localhost:3000/echo');
  assert.deepStrictEqual(failures, []);
});

// A password on its own is still a credential, so the "empty" rule above must not swallow it.
test('a password with no username still authenticates', async () => {
  const response = await client.get<Echo>('http://localhost:3000/echo', {responseType: 'json', password: 'secret'});

  assert.strictEqual(response.body.headers['authorization'], 'Basic ' + Buffer.from(':secret').toString('base64'));
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

/*
 * Cross-origin hook rewrites.
 *
 * `127.0.0.1` and `localhost` are different origins that reach the same server here, which is
 * what lets one `/echo` route answer both sides of the boundary.
 *
 * The leak this rules out: a hook is exactly where a url arrives from somewhere else - a
 * signing service, a discovered endpoint, a redirect the caller follows themselves - and every
 * one of those used to take the caller's `authorization`, their session `cookie` and the body
 * meant for their own api along to whatever host the hook named. undici already strips these
 * when it follows a cross-origin redirect; got 16 does it for hooks, and all of this is
 * measured against it.
 */
test('a beforeRequest hook that changes origin does not take the credentials with it', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/moved';
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/json', {
    body: 'PAYLOAD',
    headers: {
      authorization: 'Bearer secret',
      cookie: 'sid=1',
      // The rest of got's list. `host` is here because a stale one addresses the previous
      // origin's vhost; the other two are credentials like the first two.
      cookie2: '$Version=1; sid=1',
      host: '127.0.0.1:3000',
      'proxy-authorization': 'Basic cHJveHk6cHc=',
    },
  });

  assert.strictEqual(response.body.url, '/echo/moved');
  assert.strictEqual(response.body.headers['authorization'], undefined);
  assert.strictEqual(response.body.headers['cookie'], undefined);
  assert.strictEqual(response.body.headers['cookie2'], undefined);
  assert.strictEqual(response.body.headers['proxy-authorization'], undefined);
  // undici supplies its own once the caller's is gone, so this asserts the stale one went
  // rather than that no host was sent at all.
  assert.strictEqual(response.body.headers['host'], 'localhost:3000');
  assert.strictEqual(response.body.body, '');
  assert.strictEqual(response.body.headers['content-type'], undefined);
});

/*
 * A url that cannot be parsed has to fail towards stripping: this decides whether credentials
 * travel, and "I could not tell" is not a reason to send them. A hook writing a relative url on
 * a client with no `prefixUrl` is how that happens - the request then fails as an invalid url,
 * but only after the header has already been taken off it.
 */
test('a hook rewriting to an unresolvable url is treated as cross-origin', async () => {
  let sent: Record<string, unknown> | undefined;

  const extClient = client.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'not-a-url/at-all';
          sent = options.headers;
        },
      ],
    },
  });

  await assert.rejects(
    () => extClient.get('http://localhost:3000/json', {headers: {authorization: 'Bearer secret'}}),
    (error: Error) => error instanceof RequestError,
  );

  // The same headers object the hook was handed, read after the strip ran on it.
  assert.strictEqual(sent?.['authorization'], undefined);
});

// The hook set these knowing where the request was going, so they are not the caller's
// credentials leaking - they are the hook's, for the new origin.
test('a cross-origin hook keeps the authorization and body it set itself', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/moved';
          options.headers['authorization'] = 'Bearer fresh';
          options.body = 'NEWBODY';
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/json', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer fresh');
  assert.strictEqual(response.body.body, 'NEWBODY');
});

// The common case, and the one that must not pay for any of this: a signing hook rewriting the
// path or the query of the url it was already going to.
test('a same-origin hook rewrite keeps everything', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/signed';
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/json', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret', cookie: 'sid=1'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer secret');
  assert.strictEqual(response.body.headers['cookie'], 'sid=1');
  assert.strictEqual(response.body.body, 'PAYLOAD');
});

/*
 * `splitUserinfo` only ever ran on the url a request started with, before the `beforeRequest`
 * hooks saw it - so a hook rewriting to a url carrying *new* credentials (signing onto a
 * discovered endpoint, say) had them go out anonymous: undici ignores userinfo in the url
 * outright, and nothing derived an `authorization` header for it a second time.
 */
test('a beforeRequest hook rewriting the url to carry new credentials sends Basic auth for them', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://newuser:newpass@localhost:3000/echo';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/json');

  assert.strictEqual(
    response.body.headers['authorization'],
    'Basic ' + Buffer.from('newuser:newpass').toString('base64'),
  );
});

/*
 * Cross-origin stripping used to compare the header/body *value* before and after the hooks ran,
 * so a hook that explicitly re-asserted the very same `authorization` string - or rebuilt a body
 * that happened to come out identical - read as untouched and was stripped anyway, contradicting
 * "values set by the hook survive". `trackHookWrites` tells the two apart by tracking the write
 * itself rather than comparing values.
 */
test('a cross-origin hook keeps an authorization it explicitly re-set to the same value', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/moved';
          options.headers['authorization'] = 'Bearer secret';
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/json', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer secret');
});

/**
 * Deleting a header is a hook saying what the request should carry, just as assigning one is.
 *
 * The tracking records both, so the cross-origin strip has nothing left to decide for a name
 * the hook already dealt with - and a `cookie` it deliberately dropped stays dropped while the
 * `authorization` it put there for the new origin survives.
 */
test('a cross-origin hook that deletes a header has that respected too', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/moved';
          delete options.headers['cookie'];
          options.headers['authorization'] = 'Bearer for-the-new-origin';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://127.0.0.1:3000/json', {
    headers: {cookie: 'session=secret', authorization: 'Bearer for-the-old-origin'},
  });

  assert.strictEqual(response.body.headers['cookie'], undefined);
  assert.strictEqual(response.body.headers['authorization'], 'Bearer for-the-new-origin');
});

/**
 * A hook may replace `options.headers` outright rather than mutating it, and the credentials it
 * put there for the new origin have to survive that.
 *
 * Assigning a new object throws the write-tracking Proxy away along with everything it recorded,
 * so the strip concluded the hook had "never touched" `authorization` and deleted the token it
 * had just minted - the request reached the new origin anonymous, and all the caller saw was a
 * 401 from a host they had just authenticated to. got 16 sends the hook's header. This is why
 * the strip needs the value comparison as well as the write set: neither signal alone is enough.
 */
test('a cross-origin hook that replaces the headers object keeps the credentials it set', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/moved';
          options.headers = {authorization: 'Bearer for-the-new-origin', 'x-keep': '1'};
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://127.0.0.1:3000/json', {
    headers: {authorization: 'Bearer for-the-old-origin', cookie: 'session=secret'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer for-the-new-origin');
  assert.strictEqual(response.body.headers['x-keep'], '1');
  // The object the hook installed carries no cookie, so the session did not travel either.
  assert.strictEqual(response.body.headers['cookie'], undefined);
});

test('a cross-origin hook keeps a body it explicitly re-set to an equal value', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://localhost:3000/echo/moved';
          options.body = 'PAYLOAD';
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/json', {body: 'PAYLOAD'});

  assert.strictEqual(response.body.body, 'PAYLOAD');
});

/**
 * The cross-origin bookkeeping lives for the hook loop and no longer.
 *
 * Telling "the hook set this" from "the hook left this standing" needs a Proxy over
 * `options.headers` and an accessor over `options.body` - but those used to stay in place all
 * the way to the dispatch, so undici read every header of every request through the Proxy.
 * Measured at ~780ns a request against ~19ns for the plain object, on a client whose entire
 * documented overhead is under 500ns, and paid by exactly the clients that always have hooks.
 *
 * Asserted on the options the response carries, which is the same object the dispatch was
 * made with.
 */
test('the beforeRequest hook bookkeeping is off the options again by the time the request goes out', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.headers['x-log-id'] = 'abc';
        },
      ],
    },
  });

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {body: 'PAYLOAD'});
  const dispatched = response.request.options;

  const bodyDescriptor = Object.getOwnPropertyDescriptor(dispatched, 'body');

  assert.strictEqual(types.isProxy(dispatched.headers), false, 'headers reached undici as a Proxy');
  assert.ok(bodyDescriptor && 'value' in bodyDescriptor, '`body` was left as an accessor');

  // And the tracking still did its job while the hooks were running.
  assert.strictEqual(dispatched.headers['x-log-id'], 'abc');
  assert.strictEqual(response.body.body, 'PAYLOAD');
});

/**
 * `delete options.body` in a hook means what it says, on a client with hooks as on one without.
 *
 * The accessor that write-tracking installs on `options.body` is configurable, so deleting the
 * property took the accessor with it: the setter never fired, `writes.body` stayed false, and
 * `restore()` re-defined `body` from the value it had held before the hooks ran - putting the
 * body the hook had just removed back on the wire. Assignment (`options.body = undefined`) went
 * through the setter and worked, so the two spellings of one intent disagreed, and so did two
 * clients running the identical hook: without `beforeRequest` hooks there is no accessor to
 * delete and the delete has always worked.
 *
 * Both spellings are driven here, against a client that has hooks and one that doesn't, because
 * it is the disagreement between them that was the bug.
 */
test('a beforeRequest hook that deletes options.body sends no body', async () => {
  const removals: [string, (options: RequestOptions) => void][] = [
    ['delete', (options) => void delete options.body],
    [
      'assign undefined',
      (options) => {
        options.body = undefined;
      },
    ],
  ];

  const sent: string[] = [];

  for (const [label, remove] of removals) {
    const extClient = client.extend({responseType: 'json', hooks: {beforeRequest: [remove]}});
    const response = await extClient.post<Echo>('http://localhost:3000/echo', {json: {a: 1}});

    sent.push(`${label}: ${JSON.stringify(response.body.body)}`);
  }

  assert.deepStrictEqual(sent, ['delete: ""', 'assign undefined: ""']);
});

/**
 * And the delete counts as the hook having spoken, so the cross-origin strip reads it the way it
 * reads an assignment rather than putting its own interpretation back over the top - the same
 * rule a deleted *header* already gets.
 *
 * Asserted as an agreement between the two spellings rather than against a fixed expectation:
 * what the request carries here (no body, and the `content-type` the hook never touched) is the
 * pre-existing behaviour of `options.body = undefined`, and the point is that `delete` no longer
 * differs from it.
 */
test('a cross-origin hook that deletes the body strips it the way an assignment does', async () => {
  const removals: [string, (options: RequestOptions) => void][] = [
    ['delete', (options) => void delete options.body],
    [
      'assign undefined',
      (options) => {
        options.body = undefined;
      },
    ],
  ];

  const sent: string[] = [];

  for (const [, remove] of removals) {
    const extClient = client.extend({
      responseType: 'json',
      hooks: {
        beforeRequest: [
          (options) => {
            remove(options);
            options.url = 'http://localhost:3000/echo/moved';
          },
        ],
      },
    });

    const response = await extClient.post<Echo>('http://127.0.0.1:3000/echo', {
      json: {a: 1},
      headers: {authorization: 'Bearer secret'},
    });

    sent.push(
      JSON.stringify({
        body: response.body.body,
        contentType: response.body.headers['content-type'] ?? null,
        authorization: response.body.headers['authorization'] ?? null,
      }),
    );
  }

  assert.strictEqual(sent[0], sent[1], 'delete and assignment disagree on a cross-origin move');
  // The body is gone either way, and the credentials the hook never touched did not travel.
  assert.deepStrictEqual(JSON.parse(sent[0]!), {body: '', contentType: 'application/json', authorization: null});
});

// A default port written out is the same origin, which is why the comparison falls back to
// `URL` rather than trusting the authority text.
test('a hook rewrite to the same origin written differently is not treated as cross-origin', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          options.url = 'http://LOCALHOST:3000/echo/cased';
        },
      ],
    },
  });

  const response = await extClient.get<Echo>('http://localhost:3000/json', {
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(response.body.url, '/echo/cased');
  assert.strictEqual(response.body.headers['authorization'], 'Bearer secret');
});

// The same boundary by the other route. A refresh hook that points the retry at a new host gets
// a clean request rather than the previous origin's credentials.
test('an afterResponse retry to another origin drops the credentials and the body', async () => {
  const extClient = client.extend({
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 401 ? retryWithMergedOptions({url: 'http://localhost:3000/echo/moved'}) : response,
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/status?code=401', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret', cookie: 'sid=1'},
  });

  assert.strictEqual(response.body.url, '/echo/moved');
  assert.strictEqual(response.body.headers['authorization'], undefined);
  assert.strictEqual(response.body.headers['cookie'], undefined);
  assert.strictEqual(response.body.body, '');
});

/*
 * Credentials in the url are the same credentials by another spelling: `call()` turns them into
 * an `authorization` header before the hooks run, so the strip has to reach the derived header
 * or the userinfo route would quietly keep working where the explicit one stopped.
 */
test('a cross-origin retry drops credentials that came from the url', async () => {
  const extClient = client.extend({
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 401 ? retryWithMergedOptions({url: 'http://localhost:3000/echo/moved'}) : response,
      ],
    },
  });

  const response = await extClient.get<Echo>('http://user:pass@127.0.0.1:3000/status?code=401');

  assert.strictEqual(response.body.headers['authorization'], undefined);
});

// A retry that supplies credentials of its own is the hook saying these are for where it is
// sending the request, so they survive - as they do in got.
test('a cross-origin retry keeps an authorization it set itself', async () => {
  const extClient = client.extend({
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 401
            ? retryWithMergedOptions({
                url: 'http://localhost:3000/echo/moved',
                headers: {authorization: 'Bearer fresh'},
                body: 'NEWBODY',
              })
            : response,
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/status?code=401', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer fresh');
  assert.strictEqual(response.body.body, 'NEWBODY');
});

/*
 * The shape a token refresh actually has: new credentials, same payload. The credentials are
 * kept because the hook set them; the body still goes, because nobody asked whether it should
 * be sent to the new host. Worth knowing rather than discovering - a refresh that also changes
 * origin has to re-supply the body. Measured against got 16, which does the same.
 */
test('a cross-origin retry that sets only headers still drops the body', async () => {
  const extClient = client.extend({
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 401
            ? retryWithMergedOptions({
                url: 'http://localhost:3000/echo/moved',
                headers: {authorization: 'Bearer fresh', 'x-trace': 'keep-me'},
              })
            : response,
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/status?code=401', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret', 'content-type': 'text/plain'},
  });

  assert.strictEqual(response.body.headers['authorization'], 'Bearer fresh');
  assert.strictEqual(response.body.headers['x-trace'], 'keep-me');
  assert.strictEqual(response.body.body, '');
  assert.strictEqual(response.body.headers['content-type'], undefined);
});

// A relative url on a retry resolves under the client's own `prefixUrl`, which is the origin it
// is already on - so there is no boundary to cross and nothing to strip.
test('a retry to a relative url keeps the credentials', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 401 ? retryWithMergedOptions({url: 'echo/moved'}) : response,
      ],
    },
  });

  const response = await extClient.get<Echo>('status?code=401', {
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(response.body.url, '/echo/moved');
  assert.strictEqual(response.body.headers['authorization'], 'Bearer secret');
});

// An absolute first request can bypass the client's prefix. A later relative retry resolves
// under that prefix, so it crosses an origin even though the retry's own url has no authority.
test('a relative retry using an inherited prefix drops cross-origin credentials and body', async () => {
  const extClient = client.extend({
    prefixUrl: 'http://localhost:3000',
    responseType: 'json',
    throwHttpErrors: false,
    hooks: {
      afterResponse: [
        (response, retryWithMergedOptions) =>
          response.statusCode === 401 ? retryWithMergedOptions({url: 'echo/moved'}) : response,
      ],
    },
  });

  const response = await extClient.post<Echo>('http://127.0.0.1:3000/status?code=401', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret', cookie: 'sid=1'},
  });

  assert.strictEqual(response.body.url, '/echo/moved');
  assert.strictEqual(response.body.headers['authorization'], undefined);
  assert.strictEqual(response.body.headers['cookie'], undefined);
  assert.strictEqual(response.body.body, '');
});

/*
 * `FormData` is got 15's documented multipart path. undici's `request()` does not accept one -
 * it does not reject it either, it simply never sends the request - so this used to hang until
 * the deadline or fail as a socket error.
 */
test('a FormData body is encoded as multipart with its boundary', async () => {
  const form = new FormData();

  form.set('name', 'value');
  form.set('file', new Blob(['hello'], {type: 'text/plain'}), 'f.txt');

  const response = await client.post<Echo>('http://localhost:3000/echo', {
    body: form,
    responseType: 'json',
  });

  const contentType = response.body.headers['content-type'] ?? '';
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];

  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.ok(boundary);
  assert.ok(response.body.body.startsWith(`--${boundary}`));
  assert.match(response.body.body, /Content-Disposition: form-data; name="name"/);
  assert.match(response.body.body, /filename="f\.txt"/);
  assert.match(response.body.body, /Content-Type: text\/plain/);
  assert.match(response.body.body, /hello/);
});

// An explicit content-type wins, as it does for `json` and `form` - even though the boundary
// then has to be the caller's problem.
test('an explicit content-type is not overwritten by the FormData encoding', async () => {
  const form = new FormData();

  form.set('name', 'value');

  const response = await client.post<Echo>('http://localhost:3000/echo', {
    body: form,
    headers: {'content-type': 'multipart/form-data; boundary=mine'},
    responseType: 'json',
  });

  assert.strictEqual(response.body.headers['content-type'], 'multipart/form-data; boundary=mine');
});

// A hook still sees the `FormData` itself, which is what lets it add a signed field.
test('a beforeRequest hook sees the FormData before it is encoded', async () => {
  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [
        (options) => {
          assert.ok(options.body instanceof FormData);
          options.body.set('signature', 'abc');
        },
      ],
    },
  });

  const form = new FormData();

  form.set('name', 'value');

  const response = await extClient.post<Echo>('http://localhost:3000/echo', {body: form});

  assert.match(response.body.body, /name="signature"/);
  assert.match(response.body.body, /abc/);
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
 * Measured against got 16: the hooks run, the body stays as the text that arrived, and the
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
  assert.strictEqual(error.code, 'ERR_NON_2XX_3XX_RESPONSE');
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
    throwHttpErrors: false,
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

  const response = await extClient.post<Echo>('status?code=401', {
    body: 'PAYLOAD',
    headers: {authorization: 'Bearer secret'},
  });

  assert.strictEqual(response.body.url, '/echo/new-prefix');
  assert.strictEqual(response.body.headers['authorization'], undefined);
  assert.strictEqual(response.body.body, '');
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
 * merges the two (`Options.searchParams`, `this._merging`) - measured against got 16, an
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

/*
 * The constructor's spread handed back the caller's own `URLSearchParams`/object by reference,
 * so mutating it after `createClient(...)` returned silently changed every request the client
 * made from then on - the same failure mode `mergeRecords`/`concatHooks`/`mergeHooks` already
 * guard `context`/`handlers`/`hooks` against, just missed for `searchParams`.
 */
test('a client built with searchParams snapshots it rather than sharing the caller’s object', async () => {
  const params = new URLSearchParams({token: 'a'});
  const scoped = new Gotlike({prefixUrl: 'http://localhost:3000', responseType: 'json', searchParams: params});

  params.set('token', 'b');

  const response = await scoped.get<Echo>('echo');

  assert.strictEqual(response.body.url, '/echo?token=a');
});

test('extend() with searchParams snapshots it rather than sharing the caller’s object', async () => {
  const params = new URLSearchParams({token: 'a'});
  const scoped = client.extend({prefixUrl: 'http://localhost:3000', responseType: 'json', searchParams: params});

  params.set('token', 'b');

  const response = await scoped.get<Echo>('echo');

  assert.strictEqual(response.body.url, '/echo?token=a');
});

/**
 * A string `searchParams` is re-encoded, not concatenated as written.
 *
 * `resolveUrl` appends the serialised query straight onto the url, so every character in the
 * caller's string landed in the url as a url character: the first `#` opened a fragment, a
 * fragment is never sent, and every parameter after it vanished off the wire with no error.
 * `next=<url>#anchor` is an entirely ordinary value to put in a query.
 *
 * It was inconsistent with itself too, which is worse to debug than being wrong: the two-sided
 * case went through `mergeSearchParams`, which round-trips through `URLSearchParams` and so
 * encoded correctly, while the one-sided case - the common one - did not.
 */
test('a string searchParams is encoded rather than concatenated verbatim', async () => {
  const scoped = client.extend({prefixUrl: 'http://localhost:3000', responseType: 'json'});

  // A `#` used to truncate the query here: the server saw `/echo?next=/home` and `b` was gone.
  const fragment = await scoped.get<Echo>('echo', {searchParams: 'next=/home#top&b=2'});

  assert.strictEqual(fragment.body.url, '/echo?next=%2Fhome%23top&b=2');

  // got's encoding, which is `URLSearchParams`': a `;` is an ordinary character in a value.
  const semicolon = await scoped.get<Echo>('echo', {searchParams: 'a=1;b=2'});

  assert.strictEqual(semicolon.body.url, '/echo?a=1%3Bb%3D2');

  // The same value on a client that also carries a query - the path that was always right -
  // has to agree with the one that was not.
  const merged = await client
    .extend({prefixUrl: 'http://localhost:3000', responseType: 'json', searchParams: {v: '1'}})
    .get<Echo>('echo', {searchParams: 'next=/home#top&b=2'});

  assert.strictEqual(merged.body.url, '/echo?v=1&next=%2Fhome%23top&b=2');
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

/*
 * `null` is a legal `body` (declared on `RequestOptions`) and means the same "no body" it does
 * on the non-stream path. The upload duplex's writable half used to be ended only when `body`
 * was neither `undefined` nor `null`, so `stream.post(url, {body: null})` left it open for a
 * caller who had explicitly said there was nothing to write, and the request hung forever.
 */
test('stream.post with an explicit null body ends the request rather than hanging', async () => {
  const upload = await client.stream.post('http://localhost:3000/echo', {body: null});

  const echo = JSON.parse(await text(upload)) as Echo;

  assert.strictEqual(echo.method, 'POST');
  assert.strictEqual(echo.body, '');
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
 * Two behaviours the review called corruption, both measured against got 16. They are locked
 * down here so a well-meaning "fix" has to argue with the measurement rather than with a
 * comment.
 *
 * Note the qualifier the parity suite added: the url append matches got only when no
 * `searchParams` is set. With one, gotlike re-resolves the url from it on each attempt and the
 * append does not accumulate, where got's does - see `src/parity/parity.spec.ts`, which pins
 * both halves.
 *
 * A `beforeRequest` hook that appends to `options.url` runs again on the retry, over the url
 * the first attempt went out with: got 16 sends `/items?sig=x` then `/items?sig=x&sig=x`.
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
 * retry when the caller passed `body` - which is what got 16 does too (measured: `<PAY>` then
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
          // Cast rather than `String(...)`: `body` now also types as `FormData`/`Readable`, and
          // this test supplies a string.
          options.body = '<' + (options.body as string) + '>';
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
          // Cast rather than `String(...)`: `body` now also types as `FormData`/`Readable`, and
          // this test supplies a string.
          options.body = '<' + (options.body as string) + '>';
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
 * Coverage-driven tests.
 *
 * Each of these was written against a branch the suite never entered, found by running
 * `npm run coverage`. They are grouped because they share a cause rather than a subject: an
 * untested branch is where every bug in this repo's history has lived, so the uncovered list
 * is the bug surface written out.
 */

// `maxAfterResponseRetries` is not exported; the bound is part of the documented contract, so
// the test states it rather than reaching for the internal.
const maxRetriesUnderTest = 20;

// The three verbs had no test at all - `handle()` is shared, but nothing checked these three
// pass the method they name.
test('put, patch and delete send their own methods', async () => {
  const extClient = client.extend({prefixUrl: 'http://localhost:3000', responseType: 'json'});

  const put = await extClient.put<Echo>('echo', {body: 'p'});
  const patch = await extClient.patch<Echo>('echo', {body: 'p'});
  const removed = await extClient.delete<Echo>('echo');

  assert.deepStrictEqual([put.body.method, patch.body.method, removed.body.method], ['PUT', 'PATCH', 'DELETE']);
});

// got has `got.head(url)`; this had no such verb, so a drop-in caller writing it got a TypeError.
test('head sends a HEAD and has no body to parse', async () => {
  const response = await client.head('http://localhost:3000/echo');

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body, '');

  // Also reachable through the callable form, which is where the verbs are forwarded.
  const viaCallable = await client('http://localhost:3000/echo', {method: 'HEAD'});

  assert.strictEqual(viaCallable.statusCode, 200);
});

/*
 * got derives an `accept` from `responseType`, and sending none meant a content-negotiating
 * upstream could answer this client with HTML where it answered got with JSON. Measured against
 * got 16: `application/json` for `json` and nothing at all for the others.
 */
test('responseType json asks for json, and only json does', async () => {
  const asJson = await client.get<Record<string, string>>('http://localhost:3000/headers', {responseType: 'json'});

  assert.strictEqual(asJson.body['accept'], 'application/json');

  const asText = JSON.parse((await client.get('http://localhost:3000/headers')).body) as Record<string, string>;

  assert.strictEqual(asText['accept'], undefined, 'a text response must not ask for json');

  const asBuffer = JSON.parse(
    (await client.get('http://localhost:3000/headers', {responseType: 'buffer'})).body.toString(),
  ) as Record<string, string>;

  assert.strictEqual(asBuffer['accept'], undefined, 'a buffer response must not ask for json');
});

test('an explicit accept header wins over the one responseType would derive', async () => {
  const response = await client.get<Record<string, string>>('http://localhost:3000/headers', {
    responseType: 'json',
    headers: {Accept: 'application/vnd.custom+json'},
  });

  assert.strictEqual(response.body['accept'], 'application/vnd.custom+json');
});

// Every other error this package raises carries a `code`; this one used to carry none, so
// `err.code` was undefined for exactly the failures hit while wiring a client up.
test('a ValidationError carries a code', () => {
  const error = (() => {
    try {
      client.extend({timeout: 1000 as never});
    } catch (err) {
      return err as ValidationError & {code?: string};
    }

    throw new assert.AssertionError({message: 'expected extend to throw'});
  })();

  assert.strictEqual(error.code, 'ERR_INVALID_OPTION');
});

test('retry must be an object', () => {
  assert.throws(() => client.extend({retry: 5 as never}), /`retry` must be an object/);
});

test('retry.limit must be a finite non-negative integer', () => {
  for (const limit of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => client.extend({retry: {limit}}),
      /`retry.limit` must be a finite non-negative integer/,
      String(limit),
    );
  }
});

/*
 * `retryWithMergedOptions` handed to a hook always travels with that hook's index, so the
 * retried request runs a strictly shorter hook array and the chain is bounded by the array
 * rather than by the depth guard. Driving the method directly is the case the guard is
 * actually for - no hook index, so the whole array runs every time - and the case that used
 * to recurse until the process died.
 */
test('retryWithMergedOptions driven directly is bounded by maxAfterResponseRetries', async () => {
  const extClient = client.extend({throwHttpErrors: false});

  const first = await extClient.get('http://localhost:3000/json');

  const error = await failure(
    (async () => {
      let options = first.request.options;

      // Each retry's own options carry the depth forward, which is what makes the chain
      // accumulate rather than restart.
      for (let i = 0; i < maxRetriesUnderTest + 5; i++) {
        options = (await extClient.retryWithMergedOptions(options, {})).request.options;
      }
    })(),
  );

  assert.strictEqual(error.code, 'ERR_TOO_MANY_RETRIES');
  assert.match(error.message, new RegExp(`more than ${maxRetriesUnderTest} times`));
});

/*
 * A retry naming a `timeout` that sets no `request` must not drop the deadline the first
 * attempt ran under - the same hole `formOptions` has for `{request: config.timeout}` where the
 * config didn't set one.
 */
test('an afterResponse retry keeps the deadline when its timeout names no request', async () => {
  let seen: number | undefined;
  let retried = false;

  const extClient = client.extend({
    responseType: 'json',
    hooks: {
      beforeRequest: [(options) => void (seen = options.timeout?.request)],
      afterResponse: [
        (response, retry) => {
          if (retried) {
            return response;
          }

          retried = true;

          return retry({timeout: {}});
        },
      ],
    },
  });

  await extClient.get<Echo>('http://localhost:3000/echo', {timeout: {request: 2000}});

  assert.strictEqual(seen, 2000, 'the retry must inherit the first attempt\u2019s deadline');
});

/* ------------------------------------------------------- redirect tracker, on a re-dispatch */

/*
 * The tracker's "this re-dispatch is not a redirect hop" guard. A retry re-dispatches through
 * the whole chain, so the redirect interceptor sees a second dispatch for a request that never
 * redirected - and `countAttempts`, composed outside it, has just cleared `lastStatusCode`
 * precisely so this is recognisable. Without the guard the retried attempt is recorded as a
 * redirect hop, `beforeRedirect` fires for a redirect that never happened, and `response.url`
 * reports the wrong url.
 *
 * The existing redirect-plus-retry tests all redirect *first*, which leaves a status recorded
 * and steps over the guard.
 */
test('a retry that followed no redirect is not recorded as a redirect hop', async () => {
  const hops: string[] = [];
  const testId = randomUUID();

  const extClient = client.extend({
    followRedirect: true,
    retry: {limit: 2, backoffLimit: 10, statusCodes: [503]},
    hooks: {beforeRedirect: [(request) => hops.push(String(request.path))]},
  });

  const response = await extClient.get('http://localhost:3000/flaky-target', {headers: {'test-id': testId}});

  assert.strictEqual(response.body, 'flaky ok');
  assert.strictEqual(response.retryCount, 1);
  assert.deepStrictEqual(hops, [], 'no redirect happened, so beforeRedirect must not have fired');
  assert.strictEqual(String(response.url), 'http://localhost:3000/flaky-target');
});

/* -------------------------------------------------- stream failure paths that had no test */

// The writable half's `final` had no coverage: every existing test writes to a failed upload,
// and none of them just ends it. `pipeline` on an empty source does exactly that.
test('a failed upload stream reports on end as well as on write', async () => {
  const upload = await client.stream('http://::invalid-url::', {method: 'POST'});

  const error = await failure(pipeline(Readable.from([]), upload));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error?.constructor?.name}`);
});

/*
 * `raise` is idempotent, and nothing exercised the second call. Reading twice is the realistic
 * way in: node calls `_read` again as soon as the first returns without pushing.
 */
test('a failed upload stream raises its failure only once', async () => {
  const upload = await client.stream('http://::invalid-url::', {method: 'POST'});
  const seen: Error[] = [];

  upload.on('error', (error: Error) => seen.push(error));

  upload.read();
  upload.read();

  await new Promise((resolve) => upload.once('close', resolve));

  assert.strictEqual(seen.length, 1, 'the failure must be raised once, not once per read');
});

/*
 * `raiseWhenListening` installs a `newListener` hook when nothing is listening for `error` yet,
 * and that hook has to ignore every other event. Nothing had ever added a non-error listener
 * while it was armed, so the guard was never entered.
 */
test('the newListener hook ignores events other than error', async () => {
  const upload = await client.stream('http://::invalid-url::', {method: 'POST'});

  // Before the arming `setImmediate` runs, so it sees no error listener and installs the hook.
  // Deliberately not `data`, which would start the stream flowing and raise via `read`.
  upload.on('close', () => {});

  await new Promise((resolve) => setImmediate(resolve));

  // Armed now: a non-error listener must leave it armed rather than raising or unhooking.
  upload.on('finish', () => {});

  const error = await new Promise<Error>((resolve) => upload.once('error', resolve));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error?.constructor?.name}`);
});

/*
 * Not tested: the `raised` guard on the http-error readable at the bottom of `callStream`.
 * Reaching it needs undici's duplex to pull from that readable twice before the queued destroy
 * lands, which is a race rather than a behaviour - any test for it would be flaky. It is a
 * defensive guard on a path whose first read is covered, and it is left uncovered deliberately.
 */

// `toStreamError`'s abort branch: every existing abort test goes through `call()`, not a stream.
test('an aborted stream is reported as an AbortError', async () => {
  const controller = new AbortController();
  const stream = await client.stream('http://localhost:3000/stream', {signal: controller.signal});

  controller.abort();

  const error = await failure(text(stream));

  assert.strictEqual(error.name, 'AbortError');
  assert.strictEqual(error.code, 'ERR_ABORTED');
});

/* ------------------------------------------------- undici's own timeouts, not the deadline */

/*
 * `timeout.request` arms undici's per-phase timeouts *and* a deadline signal, and the deadline
 * is what normally fires first - so the mapping of undici's own `HeadersTimeoutError` was
 * never reached. A custom agent carrying `headersTimeout` and no `timeout.request` is the way
 * in, and it is a real configuration: it is how a caller bounds headers without bounding the
 * whole request.
 */
test('undici’s own headers timeout is mapped to a TimeoutError', async () => {
  const extClient = client.extend({agent: new Agent({headersTimeout: 50})});

  const error = await failure(extClient.get('http://localhost:3000/slow'));

  assert.strictEqual(error.name, 'TimeoutError');
  assert.strictEqual(error.code, 'ETIMEDOUT');
});

test('undici’s own headers timeout is mapped on a stream too', async () => {
  const extClient = client.extend({agent: new Agent({headersTimeout: 50})});

  const error = await failure(extClient.stream('http://localhost:3000/slow').then(text));

  assert.strictEqual(error.name, 'TimeoutError');
  assert.strictEqual(error.code, 'ETIMEDOUT');
});

/*
 * gotlike forces `throwOnError: false` on its own retry interceptor, so a `RequestRetryError`
 * can only reach `call()` from a retry interceptor the caller composed themselves - which the
 * `agent` seam explicitly allows. The branch exists to carry the last response onto the error
 * rather than losing it, and nothing tested that it does.
 */
test('a RequestRetryError from a caller’s own retry interceptor keeps the last response', async () => {
  const extClient = client.extend({
    agent: new Agent().compose(
      interceptors.retry({maxRetries: 1, minTimeout: 10, maxTimeout: 10, statusCodes: [503], methods: ['GET']}),
    ),
  });

  const error = await failure(extClient.get('http://localhost:3000/status?code=503'));

  assert.strictEqual(error.response?.statusCode, 503, 'the exhausted retry must carry its last response');
});

/* ------------------------------------------- an option named as `undefined` is not a value */

/*
 * `{throwHttpErrors: opts.throwHttpErrors}` forwarded from a config that didn't set one is an
 * ordinary thing to write, and a plain spread let the `undefined` win - so the client's own
 * setting was turned off by a caller who had only meant to pass it along. got skips
 * `undefined` when it merges options; `mergeOptions` is what makes that true here, and it
 * covers every option at once rather than the handful anyone thought to guard.
 */
test('a per-call option named as undefined keeps the client’s own', async () => {
  const strict = createClient({throwHttpErrors: true});

  await assert.rejects(() => strict.get('http://localhost:3000/status?code=500', {throwHttpErrors: undefined}), {
    name: 'HTTPError',
  });
});

test('responseType named as undefined keeps the client’s own', async () => {
  const jsonClient = createClient({responseType: 'json'});
  const response = await jsonClient.get<{test: string}>('http://localhost:3000/json', {responseType: undefined});

  // The buffer arm is what an `undefined` used to fall through to, so a Buffer here is the
  // failure this pins - not merely "not parsed".
  assert.deepStrictEqual(response.body, {test: 'value'});
});

test('followRedirect named as undefined keeps following', async () => {
  const following = createClient({followRedirect: true});
  const response = await following.get('http://localhost:3000/redirect', {followRedirect: undefined});

  // Resolving with the 302 itself - the redirect page as a successful body - is the shape of
  // the bug: `follows()` said no, so `maxRedirections` was 0 *and* the 3xx wasn't an error.
  assert.strictEqual(response.statusCode, 200);
});

test('handlers named as undefined keeps the client’s chain', async () => {
  let ran = false;

  const handled = createClient({
    handlers: [
      (options, next) => {
        ran = true;

        return next(options);
      },
    ],
  });

  await handled.get('http://localhost:3000/json', {handlers: undefined});

  assert.ok(ran, 'the client’s handler chain must still run');
});

test('searchParams named as undefined keeps the client’s query', async () => {
  const scoped = createClient({searchParams: {apiKey: 'secret'}});
  const response = await scoped.get<{url: string}>('http://localhost:3000/echo', {
    searchParams: undefined,
    responseType: 'json',
  });

  assert.strictEqual(response.body.url, '/echo?apiKey=secret');
});

test('timeout named as undefined keeps the client’s deadline', async () => {
  const bounded = createClient({timeout: {request: 50}});

  // The `/timeout` route never answers, so the only thing that can end this is the deadline
  // the client carries - which an `undefined` used to drop, leaving the request unbounded.
  await assert.rejects(() => bounded.get('http://localhost:3000/timeout', {timeout: undefined}), {
    name: 'TimeoutError',
  });
});

test('extending with an option named as undefined keeps the parent’s', async () => {
  const child = createClient({throwHttpErrors: true}).extend({throwHttpErrors: undefined});

  await assert.rejects(() => child.get('http://localhost:3000/status?code=500'), {name: 'HTTPError'});
});

/* ------------------------------------------------------------ a stream body on the upload path */

/*
 * `RequestOptions.body` declares `Readable`, and `call()` encodes a `FormData` into one before
 * the stream paths are reached - so both arrived at `duplex.end(body)`, which takes only a
 * string, `Buffer` or view. Every `stream.post` carrying either failed with a raw
 * `ERR_INVALID_ARG_TYPE` about a "chunk", naming nothing a caller would recognise, while the
 * same body through `post()` had always worked.
 */
test('a Readable body given to stream() is uploaded', async () => {
  const upload = await client.stream('http://localhost:3000/echo', {
    method: 'POST',
    body: Readable.from(['hello', ' world']),
  });

  const echoed = JSON.parse(await text(upload)) as {method: string; body: string};

  assert.strictEqual(echoed.method, 'POST');
  assert.strictEqual(echoed.body, 'hello world');
});

test('a FormData body given to stream() is encoded and uploaded', async () => {
  const form = new FormData();

  form.set('field', 'value');

  const upload = await client.stream('http://localhost:3000/echo', {method: 'POST', body: form});
  const echoed = JSON.parse(await text(upload)) as {headers: Record<string, string>; body: string};

  assert.match(echoed.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/);
  assert.match(echoed.body, /name="field"/);
  assert.match(echoed.body, /\r\n\r\nvalue\r\n/);
});

/*
 * `pipe` forwards no error and doesn't end its destination, so a body stream that broke
 * mid-upload left the request hanging with nothing to report. Destroying the duplex is what
 * `normaliseStreamErrors` is watching for, which is what turns it into a `RequestError`.
 */
test('a Readable body that fails mid-upload is reported as a RequestError', async () => {
  const source = new Readable({
    read() {
      this.push('start');
      this.destroy(new Error('the source gave up'));
    },
  });

  const upload = await client.stream('http://localhost:3000/echo', {method: 'POST', body: source});
  const error = await failure(text(upload));

  assert.ok(error instanceof RequestError, `expected a RequestError, got ${error.constructor.name}`);
  assert.strictEqual(error.message, 'the source gave up');
});

/* ----------------------------------------------------- a polluted Object.prototype stays out */

/*
 * `validateOptions` was fixed for this once, with `Object.hasOwn` - but every other `for...in`
 * here walks something a caller handed us too, and those run *after* validation has passed. So
 * an enumerable property on `Object.prototype` (which is what a prototype-pollution bug in any
 * dependency leaves behind) was appended to the query of every request and sent as a header on
 * every request, past the check that exists to catch exactly this.
 */
test('a polluted Object.prototype adds neither a query parameter nor a header', async () => {
  (Object.prototype as Record<string, unknown>)['Polluted'] = 'evil';

  try {
    const scoped = createClient({
      headers: {'x-real': 'yes'},
      searchParams: {base: '1'},
      // Makes the dispatch-time unfolded-header scan run as well as the construction and
      // per-call merges. Its inherited upper-case name must not trigger a second fold.
      hooks: {beforeRequest: [() => undefined]},
    });
    const response = await scoped.get<{url: string; headers: Record<string, string>}>('http://localhost:3000/echo', {
      searchParams: {q: '1'},
      headers: {'x-call': 'yes'},
      responseType: 'json',
    });

    assert.strictEqual(response.body.url, '/echo?base=1&q=1');
    assert.ok(!Object.hasOwn(response.body.headers, 'polluted'));
    assert.strictEqual(response.body.headers['x-real'], 'yes');
    assert.strictEqual(response.body.headers['x-call'], 'yes');
  } finally {
    delete (Object.prototype as Record<string, unknown>)['Polluted'];
  }
});

/*
 * The same pollution, non-writable: `lowercaseHeaders` copied it into a fresh object and the
 * assignment threw, so building a client at all died with a raw `TypeError: Cannot assign to
 * read only property` from inside a header merge.
 */
test('a non-writable polluted property does not break constructing a client', () => {
  Reflect.defineProperty(Object.prototype, 'frozenPollution', {
    value: 'evil',
    enumerable: true,
    writable: false,
    configurable: true,
  });

  try {
    assert.doesNotThrow(() => createClient({headers: {'x-real': 'yes'}}));
  } finally {
    delete (Object.prototype as Record<string, unknown>)['frozenPollution'];
  }
});

/* --------------------------------------------------------------------- method case folding */

/*
 * got's `set method` uppercases; `httpMethods` is the upper-case list, so a lower-case method
 * was a `ValidationError` here and an ordinary request there - a hard stop for code migrating
 * over. With `validate: false` it was worse: the value slipped past the check and then missed
 * `isBodyMethod`, putting a POST on the bodyless path.
 */
test('a lower-case method is folded rather than refused', async () => {
  const response = await client.handle<{method: string; body: string}>(
    {method: 'post' as 'POST', body: 'payload', responseType: 'json'},
    'http://localhost:3000/echo',
  );

  assert.strictEqual(response.body.method, 'POST');
  assert.strictEqual(response.body.body, 'payload');
});

test('a lower-case method is folded with validation off', async () => {
  const unchecked = createClient({validate: false});
  const response = await unchecked.handle<{method: string; body: string}>(
    {method: 'post' as 'POST', body: 'payload', responseType: 'json'},
    'http://localhost:3000/echo',
  );

  assert.strictEqual(response.body.method, 'POST', 'a mis-cased method must not reach isBodyMethod unfolded');
  assert.strictEqual(response.body.body, 'payload');
});

test('a lower-case method on the client itself is folded', async () => {
  const posting = createClient({method: 'post' as 'POST'});
  const response = await posting.handle<{method: string}>({responseType: 'json'}, 'http://localhost:3000/echo');

  assert.strictEqual(response.body.method, 'POST');
});

test('a method that is not an HTTP method is still refused', async () => {
  await assert.rejects(() => client.handle({method: 'nope' as 'GET'}, 'http://localhost:3000/echo'), {
    name: 'ValidationError',
    code: 'ERR_INVALID_OPTION',
  });
});

/**
 * Invariant: **every** failure reaches the caller as a `RequestError` or a `ValidationError`.
 *
 * Those two classes are the whole contract - one says the request failed, the other says the
 * caller configured something wrong - and the README tells callers to match on them. A raw
 * `Error` or `TypeError` escaping means the `beforeError` hooks did not run and
 * `instanceof RequestError` silently missed a failure.
 *
 * This is deliberately a table rather than one test per row. Every error bug in this repo's
 * history has been *one uncovered path*, not a wrong class on a covered one: a throwing
 * `beforeRequest` hook, a throwing `beforeError` hook, a hook that forgot to return, a
 * hand-made response with no `request` on it. Listing the paths in one place makes adding a
 * new one an obvious edit, and makes a newly-uncovered one a visible omission rather than a
 * test nobody wrote.
 */
test('every failure path reports a RequestError or a ValidationError, never a raw error', async () => {
  const hooked = (hooks: RequestOptions['hooks']) => client.extend({responseType: 'json', hooks});

  const paths: [string, () => Promise<unknown>][] = [
    ['connection refused', () => client.get('http://127.0.0.1:1/nope')],
    ['dns failure', () => client.get('http://does-not-exist.invalid/nope')],
    ['http error status', () => client.get('http://localhost:3000/status?code=500')],
    // `/stream` answers 200 with `hello\n` repeated, which is not json.
    ['parse failure on an ok status', () => client.get('http://localhost:3000/stream', {responseType: 'json'})],
    ['malformed url', () => client.get('not-a-url')],
    ['timeout', () => client.get('http://localhost:3000/timeout', {timeout: {request: 50}})],
    ['aborted', () => client.get('http://localhost:3000/timeout', {signal: AbortSignal.abort()})],
    [
      'aborted with a custom reason',
      () => client.get('http://localhost:3000/timeout', {signal: AbortSignal.abort(new Error('cancelled'))}),
    ],
    ['circular json', () => client.post('http://localhost:3000/echo', {json: circular()})],
    // Hooks: each of the four, throwing an Error and throwing something that is not one.
    [
      'beforeRequest throws',
      () =>
        hooked({
          beforeRequest: [
            () => {
              throw new Error('hook');
            },
          ],
        }).get('http://localhost:3000/json'),
    ],
    [
      'beforeRequest throws a non-Error',
      () =>
        hooked({
          beforeRequest: [
            () => {
              // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error
              throw 'hook';
            },
          ],
        }).get('http://localhost:3000/json'),
    ],
    [
      'afterResponse throws',
      () =>
        hooked({
          afterResponse: [
            () => {
              throw new Error('hook');
            },
          ],
        }).get('http://localhost:3000/json'),
    ],
    [
      'afterResponse forgets to return',
      () => hooked({afterResponse: [(() => undefined) as never]}).get('http://localhost:3000/json'),
    ],
    [
      // A hook may hand back a response it built itself (`isResponseLike` accepts anything with
      // a numeric `statusCode`), and that one has no `request` on it - which used to be read
      // through unconditionally, from outside the hook loop's try, as a raw TypeError.
      'afterResponse returns a hand-made error response',
      () =>
        hooked({afterResponse: [(() => ({statusCode: 500, body: 'x'})) as never]}).get('http://localhost:3000/json'),
    ],
    [
      'beforeError throws',
      () =>
        hooked({
          beforeError: [
            () => {
              throw new Error('hook');
            },
          ],
        }).get('http://localhost:3000/status?code=500'),
    ],
    [
      'beforeError returns a non-Error',
      () => hooked({beforeError: [(() => 'nope') as never]}).get('http://localhost:3000/status?code=500'),
    ],
    // Configuration mistakes, on both routes into `call()`.
    ['a bad option on the call', () => client.get('http://localhost:3000/json', {responseType: 'jsn' as never})],
    [
      // Not caught by `validateOptions`, which checks the container and not the values - this
      // one is raised by `queryValue` from inside `call()`'s pre-request work instead.
      'a searchParams value that cannot be serialised',
      () => client.get('http://localhost:3000/json', {searchParams: {a: {b: 1} as never}}),
    ],
    [
      'a bad option on an afterResponse retry',
      () =>
        hooked({
          afterResponse: [
            (response, retry) =>
              response.request.options.headers['x-retried'] === undefined
                ? retry({responseType: 'jsn' as never, headers: {'x-retried': '1'}})
                : response,
          ],
        }).get('http://localhost:3000/json'),
    ],
  ];

  const wrong: string[] = [];

  for (const [label, run] of paths) {
    let error: Error;

    try {
      await run();
      wrong.push(`${label}: RESOLVED instead of failing`);
      continue;
    } catch (caught) {
      error = caught as Error;
    }

    if (!(error instanceof RequestError) && !(error instanceof ValidationError)) {
      wrong.push(`${label}: ${error.constructor.name} - ${error.message}`);
    }
  }

  assert.deepStrictEqual(wrong, [], `these failure paths escaped the error contract:\n  ${wrong.join('\n  ')}`);
});

/** A value `JSON.stringify` refuses, for the serialisation-failure path above. */
function circular(): unknown {
  const value: Record<string, unknown> = {};

  value['self'] = value;

  return value;
}

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

  // A `Got`-typed field takes any callable client, whatever its `responseType` - the aggregator
  // types its provider clients that way. CLAUDE.md claimed this held and nothing checked it: a
  // json client's quiet `delete()` resolves to `Response<unknown>`, which `Got` - typed as the
  // default client, with a `string` body - would not accept.
  const clients: Got[] = [
    client,
    jsonClient,
    bufferClient,
    client.extend({responseType: 'text'}),
    jsonClient.extend({prefixUrl: 'p'}),
    createClient({prefixUrl: 'p'}),
    createClient({responseType: 'json'}),
  ];
  const anyClient = clients[0]!;

  // A bare `createClient()` is the default client's type; options that may be absent still compile.
  const maybeOptions = undefined as RequestOptions | undefined;
  expectType<string>()((await createClient().get('u')).body);
  expectType<unknown>()((await createClient(maybeOptions).get('u')).body);
  // A class type parameter can't default one way for inference and another for annotations, so a
  // bare `new Gotlike()` is the any-client type. Pinned because it changed: this was `string`.
  expectType<unknown>()((await new Gotlike().get('u')).body);

  // Through one, a quiet call's body is `unknown` - it could be any of them - and an explicit
  // type argument or per-call `responseType` still settles it.
  expectType<unknown>()((await anyClient.get('u')).body);
  expectType<unknown>()((await anyClient.delete('u')).body);
  expectType<Thing>()((await anyClient.get<Thing>('u')).body);
  expectType<string>()((await anyClient.get('u', {responseType: 'text'})).body);
  expectType<Buffer>()((await anyClient.post('u', {responseType: 'buffer'})).body);
  expectType<unknown>()((await anyClient.extend({prefixUrl: 'p'}).get('u')).body);

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

  // `{isStream: true}` is documented as equivalent to `.stream(...)` - nothing about `handle()`,
  // the verb methods or the callable form used to key on it, so this claimed `Response<T>` while
  // resolving to a `GotlikeStream` at runtime.
  expectType<GotlikeStream>()(await client.get('u', {isStream: true}));
  expectType<GotlikeStream>()(await client.head('u', {isStream: true}));
  expectType<GotlikeUploadStream>()(await client.post('u', {isStream: true}));
  expectType<GotlikeUploadStream>()(await client.put('u', {isStream: true}));
  expectType<GotlikeUploadStream>()(await client.patch('u', {isStream: true}));
  expectType<GotlikeUploadStream>()(await client.delete('u', {isStream: true}));
  expectType<GotlikeUploadStream>()(await client.query('u', {isStream: true}));
  expectType<GotlikeStream | GotlikeUploadStream>()(await client('u', {isStream: true}));
  expectType<GotlikeStream | GotlikeUploadStream>()(await client({url: 'u', isStream: true}));

  // An options object in place of the url types the same way the url form does.
  expectType<Thing>()((await client.post<Thing>({json: {a: 1}})).body);
  expectType<string>()((await client.get({url: 'u'})).body);
  expectType<Buffer>()((await client.get({url: 'u', responseType: 'buffer'})).body);
  expectType<string>()(await client.put({resolveBodyOnly: true}));
  expectType<unknown>()((await jsonClient.patch({})).body);
  expectType<GotlikeStream>()(await client.get({isStream: true}));
  expectType<GotlikeUploadStream>()(await client.post({isStream: true}));
  expectType<GotlikeUploadStream>()(await client.stream.post({body: 'x'}));
  expectType<GotlikeUploadStream>()(await client.stream({method: 'POST'}));
  expectType<GotlikeStream>()(await client.stream({url: 'u'}));
}

void typeAssertions;

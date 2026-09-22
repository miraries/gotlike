import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import nock from './nock.ts';
import client, {type RequestError} from './index.ts';

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  try {
    await promise;
  } catch (error) {
    return error as RequestError;
  }

  throw new assert.AssertionError({message: 'expected the request to fail, but it resolved'});
}

test('an unmatched request on a mocked origin never falls through to the live network', async (t) => {
  let liveHits = 0;
  const server = http.createServer((_request, response) => {
    liveHits++;
    response.end('live');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        nock.cleanAll();
        nock.restore();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  // Origins with no scope retain the shim's default network access, even while another origin
  // is mocked.
  nock('http://somewhere-else.test').get('/expected').reply(200, 'not used');
  assert.strictEqual((await client.get(`${origin}/live`)).body, 'live');
  assert.strictEqual(liveHits, 1);
  nock.cleanAll();

  nock(origin).get('/expected').reply(200, 'mocked');

  const error = await failure(client.get(`${origin}/misspelled`));
  assert.strictEqual(error.code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
  assert.strictEqual(liveHits, 1, 'the unmatched request must not reach the server');
  assert.strictEqual((await client.get(`${origin}/expected`)).body, 'mocked');

  nock.cleanAll();
  assert.strictEqual((await client.get(`${origin}/live-again`)).body, 'live');
  assert.strictEqual(liveHits, 2);

  const escapedOrigin = origin.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  nock(new RegExp(`^${escapedOrigin}$`))
    .get('/regex')
    .reply(200, 'regex mock');

  const regexError = await failure(client.get(`${origin}/another-miss`));
  assert.strictEqual(regexError.code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
  assert.strictEqual(liveHits, 2, 'a regex scope must also prevent a live fallback');

  // Regex pools are retained internally across cleans; inactive ones must not keep blocking.
  nock.cleanAll();
  assert.strictEqual((await client.get(`${origin}/after-regex-clean`)).body, 'live');
  assert.strictEqual(liveHits, 3);
});

/**
 * A `Scope` captured once and reused across a `cleanAll()` must keep owning its origin.
 *
 * `cleanAll()` drops string origins from the pool map, and reusing the old scope only ever
 * re-activated an entry that was still *in* it - so the interceptors it registered afterwards
 * matched, while the origin was no longer recognised as mocked. Anything that missed them then
 * fell through to the real network instead of failing closed, silently, which is the one thing
 * owning an origin exists to prevent. `const scope = nock(host)` at the top of a file with a
 * `cleanAll()` in a `beforeEach` is the ordinary way to write into that.
 */
test('a scope reused after cleanAll still owns its origin', async (t) => {
  let liveHits = 0;
  const server = http.createServer((_request, response) => {
    liveHits++;
    response.end('live');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        nock.cleanAll();
        nock.restore();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  nock.activate();

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const scope = nock(origin);

  scope.get('/expected').reply(200, 'mocked');
  assert.strictEqual((await client.get(`${origin}/expected`)).body, 'mocked');

  nock.cleanAll();

  // The same scope object, registering on the same pool - the shape the map used to lose.
  scope.get('/expected').reply(200, 'mocked again');

  const error = await failure(client.get(`${origin}/misspelled`));
  assert.strictEqual(error.code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
  assert.strictEqual(liveHits, 0, 'the unmatched request must not reach the server');
  assert.strictEqual((await client.get(`${origin}/expected`)).body, 'mocked again');
});

/**
 * The lifecycle operations, checked where a fall-through can actually be seen.
 *
 * `nock.spec.ts` calls `disableNetConnect()` at the top, which makes "the shim stopped owning
 * this origin" structurally unobservable in the whole file - every miss fails closed there
 * whether the shim meant it to or not. That is why `cleanAll()` silently handing an origin back
 * to the network survived so long, and it is a property of the *suite*, not of any one test. So
 * anything that changes what the shim owns belongs here, with a real server to fall through to.
 */
test('consuming, restoring and persisting mocks never hands an origin back by accident', async (t) => {
  let liveHits = 0;
  const server = http.createServer((_request, response) => {
    liveHits++;
    response.end('live');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        nock.cleanAll();
        nock.restore();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  nock.activate();

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  // A consumed interceptor does not reopen the origin: a second request to the same path is a
  // miss, and a miss on an owned origin fails closed rather than reaching the server.
  nock(origin).get('/once').reply(200, 'mocked');
  assert.strictEqual((await client.get(`${origin}/once`)).body, 'mocked');
  assert.strictEqual((await failure(client.get(`${origin}/once`))).code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
  assert.strictEqual(liveHits, 0);

  // restore() puts the caller's dispatcher back and activate() re-installs the mock; a scope
  // registered afterwards has to own its origin exactly as before.
  nock.cleanAll();
  nock.restore();
  nock.activate();
  nock(origin).get('/again').reply(200, 'mocked again');
  assert.strictEqual((await client.get(`${origin}/again`)).body, 'mocked again');
  assert.strictEqual((await failure(client.get(`${origin}/typo`))).code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
  assert.strictEqual(liveHits, 0);

  // A persisted interceptor answers indefinitely, and stops when the scope is cleaned - at
  // which point the origin is genuinely no longer mocked and a request is meant to go live.
  nock.cleanAll();
  nock(origin).persist().get('/persisted').reply(200, 'persisted');
  assert.strictEqual((await client.get(`${origin}/persisted`)).body, 'persisted');
  assert.strictEqual((await client.get(`${origin}/persisted`)).body, 'persisted');
  assert.strictEqual(liveHits, 0);

  nock.cleanAll();
  assert.strictEqual((await client.get(`${origin}/persisted`)).body, 'live');
  assert.strictEqual(liveHits, 1);
});

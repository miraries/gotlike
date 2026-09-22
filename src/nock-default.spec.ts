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

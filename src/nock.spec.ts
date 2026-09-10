import test from 'node:test';
import assert from 'node:assert';
import nock from './nock';
import client from './index';

const json = client.extend({responseType: 'json', throwHttpErrors: false});

test.afterEach(() => {
  nock.cleanAll();
});

test('matches a plain path', async () => {
  nock('http://mock.test').get('/a').reply(200, 'body');

  const response = await client.get('http://mock.test/a');

  assert.strictEqual(response.body, 'body');
});

test('replies with a json object', async () => {
  nock('http://mock.test').get('/a').reply(200, {ok: true});

  const response = await json.get<{ok: boolean}>('http://mock.test/a');

  assert.deepStrictEqual(response.body, {ok: true});
});

test('replies with headers and a status code', async () => {
  nock('http://mock.test').get('/a').reply(201, 'created', {'x-custom': 'yes'});

  const response = await client.get('http://mock.test/a');

  assert.strictEqual(response.statusCode, 201);
  assert.strictEqual(response.headers['x-custom'], 'yes');
});

/**
 * `nock('https://host/base/path')` - the aggregator's pragmatic mocks do this, and undici's
 * MockAgent only accepts an origin, so the path has to be folded into every interceptor.
 */
test('honours a base path on the scope', async () => {
  nock('http://mock.test/IntegrationService/v3')
    .post('/CasinoGameAPI/game/url')
    .reply(200, {gameURL: 'https://example.test/game/1'});

  const response = await json.post<{gameURL: string}>(
    'http://mock.test/IntegrationService/v3/CasinoGameAPI/game/url',
  );

  assert.strictEqual(response.body.gameURL, 'https://example.test/game/1');
});

test('a base path does not match a different prefix', async () => {
  nock('http://mock.test/base').get('/thing').reply(200, 'matched');

  const response = await client.get('http://mock.test/other/thing').catch(err => err);

  assert.ok(response instanceof Error, 'expected the request not to match');
});

test('trailing slashes on the base path are ignored', async () => {
  nock('http://mock.test/base/').get('/thing').reply(200, 'matched');

  const response = await client.get('http://mock.test/base/thing');

  assert.strictEqual(response.body, 'matched');
});

test('matches a regex path, including under a base path', async () => {
  nock('http://mock.test/IntegrationService/v3')
    .post(/\/CasinoGameAPI\/game\/url.*/)
    .reply(200, {error: '0'});

  const response = await json.post<{error: string}>(
    'http://mock.test/IntegrationService/v3/CasinoGameAPI/game/url?extra=1',
  );

  assert.strictEqual(response.body.error, '0');
});

test('matches a function path', async () => {
  nock('http://mock.test').get((path) => path.startsWith('/dynamic')).reply(200, 'fn');

  const response = await client.get('http://mock.test/dynamic/thing');

  assert.strictEqual(response.body, 'fn');
});

test('query(true) matches any query string', async () => {
  nock('http://mock.test').post('/create').query(true).reply(200, {error: 0});

  const response = await json.post<{error: number}>('http://mock.test/create', {
    searchParams: {anything: 'goes', more: '1'},
  });

  assert.strictEqual(response.body.error, 0);
});

test('query(true) also matches a request with no query at all', async () => {
  nock('http://mock.test').get('/maybe').query(true).reply(200, 'ok');

  const response = await client.get('http://mock.test/maybe');

  assert.strictEqual(response.body, 'ok');
});

test('query(object) matches only those params', async () => {
  nock('http://mock.test').get('/exact').query({a: '1'}).reply(200, 'matched');

  const matched = await client.get('http://mock.test/exact', {searchParams: {a: '1'}});

  assert.strictEqual(matched.body, 'matched');

  nock('http://mock.test').get('/exact').query({a: '1'}).reply(200, 'matched');

  const missed = await client.get('http://mock.test/exact', {searchParams: {a: '2'}}).catch(err => err);

  assert.ok(missed instanceof Error, 'expected a different query not to match');
});

test('a plain path does not match a request carrying a query', async () => {
  nock('http://mock.test').get('/strict').reply(200, 'matched');

  const missed = await client.get('http://mock.test/strict', {searchParams: {a: '1'}}).catch(err => err);

  assert.ok(missed instanceof Error, 'nock semantics: no query matcher means no query');
});

/** The shape spribe.spec.ts uses to capture what was actually sent. */
test('reply(function) receives uri, parsed body and this.req.headers', async () => {
  let capturedUri: string | undefined;
  let capturedBody: unknown;
  let capturedHeaders: Record<string, string> | undefined;

  nock('http://mock.test')
    .post('/freebets/create')
    .reply(function (uri, requestBody) {
      capturedUri = uri;
      capturedBody = requestBody;
      capturedHeaders = this.req.headers;

      return [200, {code: 200, message: 'Success'}, {'x-from': 'callback'}];
    });

  const response = await json.post<{code: number}>('http://mock.test/freebets/create', {
    json: {amount: 5},
    headers: {'x-signature': 'abc'},
  });

  assert.strictEqual(capturedUri, '/freebets/create');
  assert.deepStrictEqual(capturedBody, {amount: 5});
  assert.strictEqual(capturedHeaders?.['x-signature'], 'abc');
  assert.strictEqual(response.body.code, 200);
  assert.strictEqual(response.headers['x-from'], 'callback');
});

test('reply(function) uri is relative to the base path and keeps the query', async () => {
  let capturedUri: string | undefined;

  nock('http://mock.test/api/v2')
    .get('/thing')
    .query(true)
    .reply(function (uri) {
      capturedUri = uri;

      return [200, 'ok'];
    });

  await client.get('http://mock.test/api/v2/thing', {searchParams: {a: '1'}});

  assert.strictEqual(capturedUri, '/thing?a=1');
});

test('reply(status, function) computes just the body', async () => {
  nock('http://mock.test')
    .post('/compute')
    .reply(200, (_uri, requestBody) => ({echoed: requestBody}));

  const response = await json.post<{echoed: {a: number}}>('http://mock.test/compute', {json: {a: 1}});

  assert.deepStrictEqual(response.body.echoed, {a: 1});
});

test('reply callbacks may be async', async () => {
  nock('http://mock.test').get('/async').reply(async () => {
    await new Promise(resolve => setTimeout(resolve, 1));

    return [200, {done: true}];
  });

  const response = await json.get<{done: boolean}>('http://mock.test/async');

  assert.deepStrictEqual(response.body, {done: true});
});

test('a non-json request body reaches the callback as a string', async () => {
  let captured: unknown;

  nock('http://mock.test').post('/form').reply(200, (_uri, body) => {
    captured = body;

    return 'ok';
  });

  await client.post('http://mock.test/form', {form: {a: '1', b: '2'}});

  assert.strictEqual(captured, 'a=1&b=2');
});

test('times(n) replays the interceptor n times', async () => {
  nock('http://mock.test').get('/repeat').times(2).reply(200, 'twice');

  assert.strictEqual((await client.get('http://mock.test/repeat')).body, 'twice');
  assert.strictEqual((await client.get('http://mock.test/repeat')).body, 'twice');

  const third = await client.get('http://mock.test/repeat').catch(err => err);

  assert.ok(third instanceof Error, 'expected the third call to be unmatched');
});

test('persist() replays indefinitely', async () => {
  nock('http://mock.test').get('/forever').persist().reply(200, 'always');

  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await client.get('http://mock.test/forever')).body, 'always');
  }
});

test('replyWithError rejects the request', async () => {
  nock('http://mock.test').get('/broken').replyWithError(new Error('boom'));

  const err = await client.get('http://mock.test/broken').catch(e => e as Error);

  assert.strictEqual(err.name, 'RequestError');
  assert.strictEqual((err.cause as Error).message, 'boom');
});

test('matchHeader and reqheaders both constrain matching', async () => {
  nock('http://mock.test').get('/guarded').matchHeader('x-key', 'secret').reply(200, 'ok');

  const matched = await client.get('http://mock.test/guarded', {headers: {'x-key': 'secret'}});

  assert.strictEqual(matched.body, 'ok');

  nock('http://mock.test').get('/guarded2', undefined, {reqheaders: {'x-key': 'secret'}}).reply(200, 'ok');

  const missed = await client.get('http://mock.test/guarded2', {headers: {'x-key': 'wrong'}}).catch(err => err);

  assert.ok(missed instanceof Error, 'expected a wrong header not to match');
});

test('body matcher constrains matching', async () => {
  nock('http://mock.test').post('/exact-body', '{"a":1}').reply(200, 'matched');

  const response = await client.post('http://mock.test/exact-body', {json: {a: 1}});

  assert.strictEqual(response.body, 'matched');
});

test('cleanAll removes pending interceptors across origins', async () => {
  nock('http://mock.test').get('/pending').reply(200, 'never used');
  nock('http://other.test').get('/pending').reply(200, 'never used');

  assert.ok(nock.pendingMocks().length >= 2);

  nock.cleanAll();

  assert.strictEqual(nock.pendingMocks().length, 0);
});

test('scopes chain across multiple interceptors', async () => {
  nock('http://mock.test')
    .get('/one').reply(200, 'first')
    .get('/two').reply(200, 'second');

  assert.strictEqual((await client.get('http://mock.test/one')).body, 'first');
  assert.strictEqual((await client.get('http://mock.test/two')).body, 'second');
});

test('interceptors are consumed once by default', async () => {
  nock('http://mock.test').get('/once').reply(200, 'first');

  assert.strictEqual((await client.get('http://mock.test/once')).body, 'first');

  const second = await client.get('http://mock.test/once').catch(err => err);

  assert.ok(second instanceof Error, 'expected the interceptor to be consumed');
});

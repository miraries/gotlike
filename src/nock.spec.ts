import test from 'node:test';
import assert from 'node:assert';
import {getGlobalDispatcher} from 'undici';
import {parse as parseUrl} from 'node:url';
import nock, {type ReplyFunctionResult} from './nock.ts';
import client, {type RequestError} from './index.ts';

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

// Without this an unmatched interceptor falls through to a real DNS lookup, which is both
// slow and a different failure than "no mock matched".
nock.disableNetConnect();

const json = client.extend({responseType: 'json', throwHttpErrors: false});

/**
 * An unmatched interceptor surfaces as a normal request failure carrying undici's
 * "Mock dispatch not matched" text - on the `RequestError`'s own message as well as on the
 * cause, since a transport failure reports the underlying message rather than a generic
 * label, and the underlying `code` along with it (undici's own for a mock miss, a
 * `MockNotMatchedError`; `ERR_REQUEST_ERROR` only when the failure carries no code).
 */
function assertUnmatched(error: RequestError, why: string) {
  assert.strictEqual(error.code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED', why);
  assert.match(error.message, /Mock dispatch not matched|Net connect/, why);
  assert.match((error.cause as Error).message, /Mock dispatch not matched|Net connect/, why);
}

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

  const response = await json.post<{gameURL: string}>('http://mock.test/IntegrationService/v3/CasinoGameAPI/game/url');

  assert.strictEqual(response.body.gameURL, 'https://example.test/game/1');
});

test('a base path does not match a different prefix', async () => {
  nock('http://mock.test/base').get('/thing').reply(200, 'matched');

  const response = await failure(client.get('http://mock.test/other/thing'));

  assertUnmatched(response, 'a different base path should not match');
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
  nock('http://mock.test')
    .get((path) => path.startsWith('/dynamic'))
    .reply(200, 'fn');

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

  const missed = await failure(client.get('http://mock.test/exact', {searchParams: {a: '2'}}));

  assertUnmatched(missed, 'a different query should not match');
});

/**
 * A non-string path has to be matched by a function, and undici only folds `query` into the
 * stored path when that path is a string - so the constraint was dropped and the interceptor
 * matched every query. Same class of bug as the string-path case above.
 */
test('query(object) constrains a regex path too', async () => {
  nock('http://mock.test')
    .get(/^\/items/)
    .query({page: '1'})
    .reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/items', {searchParams: {page: '99'}}));

  assertUnmatched(missed, 'a different query should not match');

  const matched = await client.get('http://mock.test/items', {searchParams: {page: '1'}});

  assert.strictEqual(matched.body, 'matched');
});

test('query(object) on a regex path requires every param to line up', async () => {
  nock('http://mock.test')
    .get(/^\/items/)
    .query({page: '1'})
    .reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/items', {searchParams: {page: '1', extra: 'x'}}));

  assertUnmatched(missed, 'an extra param should not match');
});

/*
 * nock allows a RegExp or a predicate as a query *value*, and an array for a repeated key.
 * Those were run through `String(value)`, which turned a RegExp into the literal `"/bar/"`
 * and an array into `"1,2"` - neither of which any real query string can equal, so such an
 * interceptor silently never matched. A RegExp or predicate value also can't be handed to
 * undici, which serialises the query into its stored path.
 */
test('query accepts a regex value', async () => {
  nock('http://mock.test').get('/re').query({token: /^abc/}).reply(200, 'matched');

  const response = await client.get('http://mock.test/re', {searchParams: {token: 'abcdef'}});

  assert.strictEqual(response.body, 'matched');
});

test('a regex query value still has to match', async () => {
  nock('http://mock.test').get('/re').query({token: /^abc/}).reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/re', {searchParams: {token: 'zzz'}}));

  assertUnmatched(missed, 'a value the regex rejects should not match');
});

test('query accepts a predicate value', async () => {
  nock('http://mock.test')
    .get('/fn')
    .query({page: (value: string) => Number(value) > 10})
    .reply(200, 'matched');

  const response = await client.get('http://mock.test/fn', {searchParams: {page: '42'}});

  assert.strictEqual(response.body, 'matched');

  nock('http://mock.test')
    .get('/fn')
    .query({page: (value: string) => Number(value) > 10})
    .reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/fn', {searchParams: {page: '2'}}));

  assertUnmatched(missed, 'a value the predicate rejects should not match');
});

test('query accepts an array value for a repeated key', async () => {
  nock('http://mock.test')
    .get('/arr')
    .query({id: ['1', '2']})
    .reply(200, 'matched');

  const response = await client.get('http://mock.test/arr', {searchParams: {id: ['1', '2']}});

  assert.strictEqual(response.body, 'matched');
});

test('an array query value is not satisfied by a single occurrence', async () => {
  nock('http://mock.test')
    .get(/^\/arr/)
    .query({id: ['1', '2']})
    .reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/arr', {searchParams: {id: '1'}}));

  assertUnmatched(missed, 'one value should not satisfy a two-element expectation');
});

/*
 * A RegExp or a predicate is legal inside a repeated key too, not just as a bare value.
 * `String(/news/)` is the literal `"/news/"`, which no query string can equal - and because
 * only top-level values were checked for one, the expectation was also handed to undici to
 * fold into its stored path, where it stringified the same way.
 */
test('an array query value accepts a regex and a predicate', async () => {
  nock('http://mock.test')
    .get('/arr-re')
    .query({tags: [/^new/, (value: string) => value.endsWith('ates')]})
    .reply(200, 'matched');

  const response = await client.get('http://mock.test/arr-re', {searchParams: {tags: ['news', 'updates']}});

  assert.strictEqual(response.body, 'matched');
});

test('a regex inside an array query value still has to match', async () => {
  nock('http://mock.test')
    .get('/arr-re')
    .query({tags: [/^new/, 'updates']})
    .reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/arr-re', {searchParams: {tags: ['olds', 'updates']}}));

  assertUnmatched(missed, 'a value the regex rejects should not match');
});

/*
 * nock's `.query(fn)` form: one predicate over the whole parsed query rather than a value at
 * a time, exactness included. It was accepted and then never consulted - the expectation went
 * to undici, which serialised a function into its stored path, so nothing ever matched and the
 * request fell through to the real network.
 */
test('query accepts a predicate over the whole query', async () => {
  const seen: Array<Record<string, string | string[]>> = [];

  nock('http://mock.test')
    .get('/whole')
    .query((query) => {
      seen.push(query);

      return query.page === '1';
    })
    .reply(200, 'matched');

  const response = await client.get('http://mock.test/whole', {searchParams: {page: '1', extra: 'ignored'}});

  assert.strictEqual(response.body, 'matched');
  // Handed the whole query, so it can be as strict or as loose as it likes - unlike the
  // object form, an unnamed `extra` is the predicate's business rather than a mismatch.
  // undici consults a path matcher more than once per dispatch, so only the first call is
  // asserted; a nock predicate is expected to be a pure question either way.
  assert.deepStrictEqual(seen[0], {page: '1', extra: 'ignored'});
});

test('a query predicate that says no does not match', async () => {
  nock('http://mock.test')
    .get('/whole')
    .query((query) => query.page === '1')
    .reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/whole', {searchParams: {page: '2'}}));

  assertUnmatched(missed, 'a query the predicate rejects should not match');
});

test('a query predicate sees a repeated key as an array', async () => {
  nock('http://mock.test')
    .get('/whole-arr')
    .query((query) => Array.isArray(query.id) && query.id.length === 2)
    .reply(200, 'matched');

  const response = await client.get('http://mock.test/whole-arr', {searchParams: {id: ['1', '2']}});

  assert.strictEqual(response.body, 'matched');
});

test('a plain path does not match a request carrying a query', async () => {
  nock('http://mock.test').get('/strict').reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/strict', {searchParams: {a: '1'}}));

  assertUnmatched(missed, 'a different query should not match');
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

/**
 * nock stringifies the request body before the callback ever sees it, so a `Buffer` body that
 * is json parses just as a string one does. Here it reached the callback as a raw `Buffer`, so
 * a callback reading `requestBody.amount` got `undefined` against the mock and the right answer
 * against the real server - which is the one thing a mocking shim must not do.
 */
test('reply(function) parses a Buffer request body like nock does', async () => {
  let capturedBody: unknown;

  nock('http://mock.test')
    .post('/buffered')
    .reply(function (_uri, requestBody) {
      capturedBody = requestBody;

      return [200, 'ok'];
    });

  await client.post('http://mock.test/buffered', {
    body: Buffer.from(JSON.stringify({amount: 5})),
    headers: {'content-type': 'application/json'},
  });

  assert.deepStrictEqual(capturedBody, {amount: 5});
});

test('reply(function) hands back a non-json Buffer body as text', async () => {
  let capturedBody: unknown;

  nock('http://mock.test')
    .post('/buffered-text')
    .reply(function (_uri, requestBody) {
      capturedBody = requestBody;

      return [200, 'ok'];
    });

  await client.post('http://mock.test/buffered-text', {
    body: Buffer.from('plain words'),
    headers: {'content-type': 'text/plain'},
  });

  assert.strictEqual(capturedBody, 'plain words');
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
  nock('http://mock.test')
    .get('/async')
    .reply(async (): Promise<ReplyFunctionResult> => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return [200, {done: true}];
    });

  const response = await json.get<{done: boolean}>('http://mock.test/async');

  assert.deepStrictEqual(response.body, {done: true});
});

test('a non-json request body reaches the callback as a string', async () => {
  let captured: unknown;

  nock('http://mock.test')
    .post('/form')
    .reply(200, (_uri, body) => {
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

  const third = await failure(client.get('http://mock.test/repeat'));

  assertUnmatched(third, 'the third call should be unmatched');
});

test('persist() replays indefinitely', async () => {
  nock('http://mock.test').get('/forever').persist().reply(200, 'always');

  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await client.get('http://mock.test/forever')).body, 'always');
  }
});

test('replyWithError rejects the request', async () => {
  nock('http://mock.test').get('/broken').replyWithError(new Error('boom'));

  const err = await failure<Error>(client.get('http://mock.test/broken'));

  assert.strictEqual(err.name, 'RequestError');
  assert.strictEqual((err.cause as Error).message, 'boom');
});

test('matchHeader and reqheaders both constrain matching', async () => {
  nock('http://mock.test').get('/guarded').matchHeader('x-key', 'secret').reply(200, 'ok');

  const matched = await client.get('http://mock.test/guarded', {headers: {'x-key': 'secret'}});

  assert.strictEqual(matched.body, 'ok');

  nock('http://mock.test')
    .get('/guarded2', undefined, {reqheaders: {'x-key': 'secret'}})
    .reply(200, 'ok');

  const missed = await failure(client.get('http://mock.test/guarded2', {headers: {'x-key': 'wrong'}}));

  assertUnmatched(missed, 'a different query should not match');
});

test('body matcher constrains matching', async () => {
  nock('http://mock.test').post('/exact-body', '{"a":1}').reply(200, 'matched');

  const response = await client.post('http://mock.test/exact-body', {json: {a: 1}});

  assert.strictEqual(response.body, 'matched');
});

/*
 * Exact means the field has to be *there*, not merely read back the same. `{a: undefined}`
 * matched a body of `{b: 'foo'}`: the key counts agreed, and `actual.a` was `undefined` for
 * the same reason any absent property is. An unmatched interceptor falls through to the real
 * network, so a false positive here is the less dangerous half of the bug - the danger is the
 * matcher agreeing to something it was never shown.
 */
test('an undefined expected field is not satisfied by an absent one', async () => {
  nock('http://mock.test').post('/undef', {a: undefined}).reply(200, 'matched');

  const missed = await failure(client.post('http://mock.test/undef', {json: {b: 'foo'}}));

  assertUnmatched(missed, 'a body naming none of the expected fields should not match');
});

test('a Buffer body matcher matches a request sending the same bytes', async () => {
  nock('http://mock.test').post('/upload', Buffer.from('binary-data')).reply(200, 'matched');

  const response = await client.post('http://mock.test/upload', {body: Buffer.from('binary-data')});

  assert.strictEqual(response.body, 'matched');
});

test('a Buffer body matcher does not match different bytes', async () => {
  nock('http://mock.test').post('/upload-diff', Buffer.from('binary-data')).reply(200, 'matched');

  const missed = await failure(client.post('http://mock.test/upload-diff', {body: Buffer.from('other-bytes')}));

  assertUnmatched(missed, 'different bytes should not match a Buffer body matcher');
});

test('a Buffer body matcher does not match a bodyless request', async () => {
  nock('http://mock.test').post('/upload-nobody', Buffer.from('binary-data')).reply(200, 'matched');

  const missed = await failure(client.post('http://mock.test/upload-nobody'));

  assertUnmatched(missed, 'a request with no body should not match a Buffer body matcher');
});

test('registering a query-carrying path alongside .query() does not throw', () => {
  assert.doesNotThrow(() => {
    nock('http://mock.test').get('/search?type=user').query({q: 'test'}).reply(200, 'matched');
  });
});

test('a query-carrying path combined with .query() requires both to be satisfied', async () => {
  nock('http://mock.test').get('/search?type=user').query({q: 'test'}).reply(200, 'matched');

  const response = await client.get('http://mock.test/search', {searchParams: {type: 'user', q: 'test'}});

  assert.strictEqual(response.body, 'matched');
});

test('a query-carrying path combined with .query() rejects a request missing either part', async () => {
  nock('http://mock.test').get('/search-partial?type=user').query({q: 'test'}).reply(200, 'matched');

  const missed = await failure(client.get('http://mock.test/search-partial', {searchParams: {type: 'user'}}));

  assertUnmatched(missed, "the path's own query param is required alongside .query()'s");
});

test('a repeated key in a query-carrying path still matches under a chained .query(fn)', async () => {
  nock('http://mock.test')
    .get('/search-tags?tag=a&tag=b')
    .query(() => true)
    .reply(200, 'matched');

  const response = await client.get('http://mock.test/search-tags', {searchParams: {tag: ['a', 'b']}});

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
  nock('http://mock.test').get('/one').reply(200, 'first').get('/two').reply(200, 'second');

  assert.strictEqual((await client.get('http://mock.test/one')).body, 'first');
  assert.strictEqual((await client.get('http://mock.test/two')).body, 'second');
});

test('interceptors are consumed once by default', async () => {
  nock('http://mock.test').get('/once').reply(200, 'first');

  assert.strictEqual((await client.get('http://mock.test/once')).body, 'first');

  const second = await failure(client.get('http://mock.test/once'));

  assertUnmatched(second, 'the interceptor should be consumed');
});

/** nock's `isDone()` answers for its own scope; ours used to answer for every origin at once. */
test('isDone reports on the scope it was called on', async () => {
  const mine = nock('http://mine.test');
  const theirs = nock('http://theirs.test');

  mine.get('/done').reply(200, 'ok');
  theirs.get('/pending').reply(200, 'never used');

  assert.strictEqual(mine.isDone(), false, 'nothing has been consumed yet');

  await client.get('http://mine.test/done');

  assert.strictEqual(mine.isDone(), true, 'this scope is done');
  assert.strictEqual(theirs.isDone(), false, 'the other scope is not, and must not say so');
});

/** `nock(host).persist()` and `scope.done()` are the spellings nock's own docs use. */
test('persist on the scope applies to every interceptor registered after it', async () => {
  const scope = nock('http://mock.test').persist();

  scope.get('/always').reply(200, 'always');

  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await client.get('http://mock.test/always')).body, 'always');
  }
});

test('done throws while the scope has interceptors left', async () => {
  const scope = nock('http://mock.test');

  scope.get('/expected').reply(200, 'ok');

  assert.throws(() => scope.done(), /not all/i);

  await client.get('http://mock.test/expected');

  scope.done();
});

test('nock supports the QUERY method with body matching', async () => {
  nock('http://mock.test')
    .query('/search', '{"query":"test"}')
    .reply(200, {results: [1, 2]});

  const response = await json.query<{results: number[]}>('http://mock.test/search', {
    json: {query: 'test'},
  });

  assert.deepStrictEqual(response.body, {results: [1, 2]});
});

test('nock scope.query allows chaining interceptor.query for URL query params', async () => {
  nock('http://mock.test')
    .query('/items')
    .query({filter: 'active'})
    .reply(200, {items: ['a']});

  const response = await json.query<{items: string[]}>('http://mock.test/items', {
    searchParams: {filter: 'active'},
  });

  assert.deepStrictEqual(response.body, {items: ['a']});
});

/*
 * nock labels an object reply `application/json`; undici's MockAgent serialises the body but
 * sets no content-type at all. Anything under test that branches on the response content-type
 * therefore behaved differently against the mock than against the real server, which is the
 * one thing a mocking shim must not do.
 */
test('an object reply body is labelled application/json', async () => {
  nock('http://mock.test').get('/j').reply(200, {a: 1});

  const response = await client.get('http://mock.test/j');

  assert.strictEqual(response.headers['content-type'], 'application/json');
});

test('an array reply body is labelled too', async () => {
  nock('http://mock.test').get('/arr').reply(200, [1, 2]);

  const response = await client.get('http://mock.test/arr');

  assert.strictEqual(response.headers['content-type'], 'application/json');
});

test('an explicit content-type on an object reply is left alone', async () => {
  nock('http://mock.test').get('/custom').reply(200, {a: 1}, {'Content-Type': 'application/problem+json'});

  const response = await client.get('http://mock.test/custom');

  assert.strictEqual(response.headers['content-type'], 'application/problem+json');
});

test('a string reply body is not labelled json', async () => {
  nock('http://mock.test').get('/s').reply(200, 'plain');

  const response = await client.get('http://mock.test/s');

  assert.strictEqual(response.headers['content-type'], undefined);
});

test('a reply callback returning an object is labelled json as well', async () => {
  nock('http://mock.test')
    .get('/cb')
    .reply((): ReplyFunctionResult => [200, {a: 1}]);

  const response = await client.get('http://mock.test/cb');

  assert.strictEqual(response.headers['content-type'], 'application/json');
});

/*
 * undici compares a non-RegExp, non-function body matcher with `===`, so nock's object form -
 * `nock(host).post('/p', {a: 1})`, its most common shape - never matched anything at all.
 */
test('an object body matcher matches the parsed request body', async () => {
  nock('http://mock.test').post('/p', {a: 1, b: 'two'}).reply(200, 'matched');

  const response = await client.post('http://mock.test/p', {json: {a: 1, b: 'two'}});

  assert.strictEqual(response.body, 'matched');
});

test('an object body matcher does not match a different body', async () => {
  nock('http://mock.test').post('/p', {a: 1}).reply(200, 'matched');

  const error = await failure(client.post('http://mock.test/p', {json: {a: 2}}));

  assertUnmatched(error, 'a body with a different value must not match');
});

test('an object body matcher requires every field and no extras', async () => {
  nock('http://mock.test').post('/exact', {a: 1}).reply(200, 'matched');

  const error = await failure(client.post('http://mock.test/exact', {json: {a: 1, extra: true}}));

  assertUnmatched(error, 'an extra field must not match');
});

test('an object body matcher accepts a regex and a predicate leaf', async () => {
  nock('http://mock.test')
    .post('/leaves', {id: /^ord-\d+$/, amount: (value: unknown) => typeof value === 'number' && value > 10})
    .reply(200, 'matched');

  const response = await client.post('http://mock.test/leaves', {json: {id: 'ord-42', amount: 99}});

  assert.strictEqual(response.body, 'matched');
});

test('a nested object body matcher compares nested fields', async () => {
  nock('http://mock.test')
    .post('/nested', {outer: {inner: [1, 2]}})
    .reply(200, 'matched');

  const response = await client.post('http://mock.test/nested', {json: {outer: {inner: [1, 2]}}});

  assert.strictEqual(response.body, 'matched');
});

test('a body that is not json at all does not match an object matcher', async () => {
  nock('http://mock.test').post('/notjson', {a: 1}).reply(200, 'matched');

  const error = await failure(client.post('http://mock.test/notjson', {body: 'plain text'}));

  assertUnmatched(error, 'an unparseable body must not match');
});

// `Object.fromEntries` keeps only the last of a repeated key, so this silently became
// `{a: '2'}` and matched requests it should not have.
test('query(URLSearchParams) keeps repeated keys', async () => {
  nock('http://mock.test').get('/rep').query(new URLSearchParams('a=1&a=2')).reply(200, 'matched');

  const response = await client.get('http://mock.test/rep?a=1&a=2');

  assert.strictEqual(response.body, 'matched');
});

test('query(URLSearchParams) with repeated keys rejects a single occurrence', async () => {
  nock('http://mock.test').get('/rep').query(new URLSearchParams('a=1&a=2')).reply(200, 'matched');

  const error = await failure(client.get('http://mock.test/rep?a=1'));

  assertUnmatched(error, 'one value must not satisfy a two-value expectation');
});

// nock accepts a bare host; `new URL` does not, so this threw ERR_INVALID_URL.
test('accepts an origin without a scheme and defaults to http', async () => {
  nock('mock.test').get('/bare').reply(200, 'matched');

  const response = await client.get('http://mock.test/bare');

  assert.strictEqual(response.body, 'matched');
});

test('a scheme-less origin keeps its base path', async () => {
  nock('mock.test/base').get('/under').reply(200, 'matched');

  const response = await client.get('http://mock.test/base/under');

  assert.strictEqual(response.body, 'matched');
});

// `body ?? ''` turned an explicit null reply into an empty body, which then failed to parse.
test('replies with a json null', async () => {
  nock('http://mock.test').get('/null').reply(200, null);

  const response = await json.get('http://mock.test/null');

  assert.strictEqual(response.body, null);
});

/**
 * `deactivate()` alone makes the mock pass requests through, which looks like a restore until
 * the caller had set a dispatcher of their own - a proxy agent, or a pool tuned for their
 * workload. That one stayed replaced for the lifetime of the process, with nothing to put it
 * back, because the dispatcher that was global before the import was never kept.
 */
test('restore() puts the previous global dispatcher back, and activate() re-installs the mock', () => {
  const mocked = getGlobalDispatcher();

  nock.restore();

  try {
    assert.notStrictEqual(getGlobalDispatcher(), mocked, 'restore() should hand the global dispatcher back');
    assert.strictEqual(nock.isActive(), false);
  } finally {
    nock.activate();
  }

  assert.strictEqual(getGlobalDispatcher(), mocked);
  assert.strictEqual(nock.isActive(), true);
});

/*
 * A regex origin, which nock allows and undici keys by object identity. The pool map was keyed
 * on the origin itself, so a second `nock(/host/)` - a different RegExp object with the same
 * pattern - missed the map and registered a *second* mock pool. undici resolves a request's
 * origin against the first regex pool it finds and caches the dispatch list that pool was
 * holding, so everything registered on the second scope was invisible: with `disableNetConnect`
 * off, those requests went out to the real network. Real nock matches both; measured against
 * nock 14.
 */
test('two scopes with the same regex origin both match', async () => {
  nock(/two-scopes\.test/)
    .get('/one')
    .reply(200, {n: 1});
  nock(/two-scopes\.test/)
    .get('/two')
    .reply(200, {n: 2});

  assert.deepStrictEqual((await json.get<{n: number}>('http://two-scopes.test/one')).body, {n: 1});
  assert.deepStrictEqual((await json.get<{n: number}>('http://two-scopes.test/two')).body, {n: 2});
});

test('a regex origin matches every host it covers', async () => {
  nock(/covered\.test$/)
    .persist()
    .get('/ping')
    .reply(200, {ok: true});

  assert.deepStrictEqual((await json.get<{ok: boolean}>('http://a.covered.test/ping')).body, {ok: true});
  assert.deepStrictEqual((await json.get<{ok: boolean}>('http://b.covered.test/ping')).body, {ok: true});
});

/*
 * `cleanAll()` used to leave a regex origin working exactly once per host per process: the
 * concrete-origin pool undici derives from a regex one holds the dispatch array it had at
 * derivation time, and `cleanMocks()` hands the regex pool a *new* array rather than emptying
 * the shared one - so everything registered afterwards landed somewhere nothing was reading,
 * and the request fell through to the network. Measured: the second test to mock the same host
 * by pattern matched nothing at all.
 */
test('a regex origin still matches after a cleanAll', async () => {
  nock(/recycled\.test/)
    .get('/first')
    .reply(200, 'first');

  assert.strictEqual((await client.get('http://recycled.test/first')).body, 'first');

  nock.cleanAll();

  nock(/recycled\.test/)
    .get('/second')
    .reply(200, 'second');

  assert.strictEqual((await client.get('http://recycled.test/second')).body, 'second');
});

test('cleanAll clears a regex origin too', async () => {
  nock(/cleaned\.test/)
    .get('/warm')
    .reply(200, 'warm');

  // Consumed first, so undici has derived its concrete-origin pool from the regex one before
  // anything is cleaned - which is the arrangement that used to leak.
  assert.strictEqual((await client.get('http://cleaned.test/warm')).body, 'warm');

  nock(/cleaned\.test/)
    .get('/gone')
    .reply(200, 'gone');

  nock.cleanAll();

  assertUnmatched(await failure(client.get('http://cleaned.test/gone')), 'the interceptor was cleaned');
});

/*
 * Scopes on one regex origin share an answer, exactly as two scopes on one string origin do:
 * a pending interceptor reports the origin it was registered under and nothing finer, so
 * `isDone()` can only answer for the origin. nock answers per scope. Documented rather than
 * fixed - the alternative is tracking every interceptor we hand to undici.
 */
test('isDone on a regex origin answers for the origin, not the scope', async () => {
  const mine = nock(/answered\.test/)
    .get('/mine')
    .reply(200, 'mine');
  const theirs = nock(/answered\.test/)
    .get('/theirs')
    .reply(200, 'theirs');

  assert.strictEqual(mine.isDone(), false, 'nothing has been consumed yet');

  await client.get('http://answered.test/mine');

  assert.strictEqual(mine.isDone(), false, 'the other scope on this origin is still pending');

  await client.get('http://answered.test/theirs');

  assert.strictEqual(mine.isDone(), true);
  assert.strictEqual(theirs.isDone(), true);
});

// An unrelated origin's pending mocks must not be counted, regex or not.
test('isDone on a regex origin ignores another origin', async () => {
  const mine = nock(/isolated\.test/)
    .get('/mine')
    .reply(200, 'mine');

  nock('http://elsewhere.test').get('/theirs').reply(200, 'theirs');

  await client.get('http://isolated.test/mine');

  assert.strictEqual(mine.isDone(), true, 'another origin must not hold this scope open');
});

/*
 * Coverage-driven tests.
 *
 * Most of what follows is public shim API that had no test at all - the repeat counts, the
 * delay, and five of the eight verbs. A consumer migrating from nock reaches for these by
 * name, and nothing here checked they worked.
 */

test('once, twice and thrice set the repeat count', async () => {
  nock('http://repeats.test').get('/once').once().reply(200, 'a');
  nock('http://repeats.test').get('/twice').twice().reply(200, 'b');
  nock('http://repeats.test').get('/thrice').thrice().reply(200, 'c');

  assert.strictEqual((await client.get('http://repeats.test/once')).body, 'a');
  assertUnmatched(
    await failure(client.get('http://repeats.test/once')),
    'a `once` interceptor must be consumed after one request',
  );

  for (let i = 0; i < 2; i++) {
    assert.strictEqual((await client.get('http://repeats.test/twice')).body, 'b');
  }

  assertUnmatched(await failure(client.get('http://repeats.test/twice')), 'twice means twice');

  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await client.get('http://repeats.test/thrice')).body, 'c');
  }

  assertUnmatched(await failure(client.get('http://repeats.test/thrice')), 'thrice means thrice');
});

test('delay holds the reply back', async () => {
  nock('http://delayed.test').get('/slow').delay(60).reply(200, 'late');

  const started = Date.now();
  const response = await client.get('http://delayed.test/slow');

  assert.strictEqual(response.body, 'late');
  assert.ok(Date.now() - started >= 50, `expected the reply to be held back, took ${Date.now() - started}ms`);
});

// Five of the eight verbs had no test. `#verb` is shared, but nothing checked each passes the
// method it names - a copy-paste slip there is invisible until a consumer hits it.
test('every verb registers under its own method', async () => {
  const scope = nock('http://verbs.test');

  scope.put('/p').reply(200, 'put');
  scope.patch('/p').reply(200, 'patch');
  scope.delete('/p').reply(200, 'delete');
  scope.head('/p').reply(200);
  scope.options('/p').reply(200, 'options');
  scope.query('/p').reply(200, 'query');

  assert.strictEqual((await client.put('http://verbs.test/p')).body, 'put');
  assert.strictEqual((await client.patch('http://verbs.test/p')).body, 'patch');
  assert.strictEqual((await client.delete('http://verbs.test/p')).body, 'delete');
  assert.strictEqual((await client('http://verbs.test/p', {method: 'HEAD'})).statusCode, 200);
  assert.strictEqual((await client('http://verbs.test/p', {method: 'OPTIONS'})).body, 'options');
  assert.strictEqual((await client.query('http://verbs.test/p')).body, 'query');
});

/* ----------------------------------------------------------------------- matcher branches */

// A body announcing json that isn't json is handed to the callback as text, not thrown over.
test('a reply callback gets an unparseable json body as text', async () => {
  let seen: unknown;

  nock('http://badjson.test')
    .post('/p')
    .reply(function (_uri, requestBody): ReplyFunctionResult {
      seen = requestBody;

      return [200, 'ok'];
    });

  await client.post('http://badjson.test/p', {
    body: 'not json at all',
    headers: {'content-type': 'application/json'},
  });

  assert.strictEqual(seen, 'not json at all');
});

// An object body matcher against a body that parsed to something else entirely.
test('an object body matcher does not match a non-object body', async () => {
  nock('http://bodyshape.test').post('/p', {a: 1}).reply(200, 'matched');

  const error = await failure(client.post('http://bodyshape.test/p', {json: [1, 2, 3]}));

  assertUnmatched(error, 'an array body must not satisfy an object matcher');
});

// A base path constrains the path: anything outside it is simply not this scope's.
test('a base path does not match a request outside it', async () => {
  nock('http://based.test/base').get('/inside').reply(200, 'in');

  assert.strictEqual((await client.get('http://based.test/base/inside')).body, 'in');

  nock('http://based.test/base').get('/inside').reply(200, 'in');

  assertUnmatched(
    await failure(client.get('http://based.test/elsewhere/inside')),
    'a path outside the base path must not match',
  );
});

// A literal query on the path with no `.query()` chained after it.
test('a literal query on the path is matched on its own', async () => {
  nock('http://literal.test').get('/p?a=1').reply(200, 'matched');

  assert.strictEqual((await client.get('http://literal.test/p?a=1')).body, 'matched');

  nock('http://literal.test').get('/p?a=1').reply(200, 'matched');

  assertUnmatched(await failure(client.get('http://literal.test/p?a=2')), 'a different query must not match');
});

// Three occurrences of one key: the second appends to the array the first two produced.
test('a query key repeated three times is collected as one array', async () => {
  nock('http://thrice-query.test')
    .get('/p')
    .query({a: ['1', '2', '3']})
    .reply(200, 'matched');

  assert.strictEqual((await client.get('http://thrice-query.test/p?a=1&a=2&a=3')).body, 'matched');
});

/* --------------------------------------------------------------------------- entry points */

test('a URL instance is accepted as an origin', async () => {
  nock(new URL('http://urlobject.test/base')).get('/p').reply(200, 'matched');

  assert.strictEqual((await client.get('http://urlobject.test/base/p')).body, 'matched');
});

test('enableNetConnect with no argument allows everything again', () => {
  // Re-disabled immediately: the rest of the suite depends on net connect being off, and the
  // assertion here is only that neither overload throws.
  assert.doesNotThrow(() => nock.enableNetConnect());
  assert.doesNotThrow(() => nock.enableNetConnect('allowed.test'));

  nock.disableNetConnect();
});

/*
 * A literal query on the path *and* a chained `.query()`. An object query is folded into
 * undici's stored path, so the two are merged there; a predicate cannot be, and the literal's
 * own values are compared one by one in the shim instead. Both forms are checked, since only
 * the second reaches that comparison.
 */
test('a literal path query and a chained object query are both applied', async () => {
  nock('http://folded.test').get('/p?a=1').query({b: '2'}).reply(200, 'matched');

  assert.strictEqual((await client.get('http://folded.test/p?a=1&b=2')).body, 'matched');

  nock('http://folded.test').get('/p?a=1').query({b: '2'}).reply(200, 'matched');

  assertUnmatched(
    await failure(client.get('http://folded.test/p?a=9&b=2')),
    'the path’s own literal query must still have to match',
  );
});

test('a literal path query is still applied alongside a query predicate', async () => {
  const predicate = (query: Record<string, string | string[]>) => query['b'] === '2';

  nock('http://foldedfn.test').get('/p?a=1').query(predicate).reply(200, 'matched');

  assert.strictEqual((await client.get('http://foldedfn.test/p?a=1&b=2')).body, 'matched');

  nock('http://foldedfn.test').get('/p?a=1').query(predicate).reply(200, 'matched');

  assertUnmatched(
    await failure(client.get('http://foldedfn.test/p?a=9&b=2')),
    'the predicate passing must not excuse the path’s own literal query',
  );
});

// `Object.fromEntries` would keep only the last; three occurrences exercise the append that
// two do not, since the second is what creates the array.
test('a URLSearchParams query keeps a key repeated three times', async () => {
  nock('http://triple.test').get('/p').query(new URLSearchParams('a=1&a=2&a=3')).reply(200, 'matched');

  assert.strictEqual((await client.get('http://triple.test/p?a=1&a=2&a=3')).body, 'matched');
});

// A base path with a query-ignoring matcher over it: the matcher is a function here, so the
// base path is checked in the shim rather than folded into undici's stored path.
test('a base path with query(true) still rejects a path outside it', async () => {
  nock('http://basedq.test/base').get('/inside').query(true).reply(200, 'in');

  assert.strictEqual((await client.get('http://basedq.test/base/inside?anything=1')).body, 'in');

  nock('http://basedq.test/base').get('/inside').query(true).reply(200, 'in');

  assertUnmatched(
    await failure(client.get('http://basedq.test/outside/inside?anything=1')),
    'a path outside the base path must not match even with query(true)',
  );
});

// nock takes node's legacy `Url` object as well as a string or a `URL`.
test('a legacy Url object is accepted as an origin', async () => {
  // `url.parse` is deprecated, which is precisely why this is worth a test: nock's signature
  // accepts the legacy `Url` object and consumers still pass one.
  // oxlint-disable-next-line typescript/no-deprecated
  nock(parseUrl('http://legacyurl.test/base')).get('/p').reply(200, 'matched');

  assert.strictEqual((await client.get('http://legacyurl.test/base/p')).body, 'matched');
});

test('abortPendingRequests drops every registered interceptor', async () => {
  nock('http://aborted.test').get('/p').reply(200, 'never');

  nock.abortPendingRequests();

  assertUnmatched(
    await failure(client.get('http://aborted.test/p')),
    'abortPendingRequests must leave nothing registered',
  );
});

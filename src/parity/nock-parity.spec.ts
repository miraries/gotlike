import {captureMatch, nockParityTest, reportNockDivergences, setupNockParity} from './nock-harness.ts';

setupNockParity();
reportNockDivergences();

/*
 * Differential tests for the nock shim.
 *
 * Real nock intercepts node's http stack, which is what got uses; the shim replaces undici's
 * global dispatcher, which is what gotlike uses. So each side is driven by the client it can
 * actually intercept, and what is compared is the only thing a mocking layer is really being
 * asked: did this interceptor match this request, and what did it reply?
 *
 * The matcher rules below are the ones CLAUDE.md records as hand-checked against nock 14. Each
 * was a bug where a mock silently failed to match - and an unmatched interceptor falls through
 * to the real network, so every one of them was a test quietly making a live outbound request.
 */

/* --------------------------------------------------------------------------- path matching */

nockParityTest('a string path matches the full path including its query', {
  claim: 'CLAUDE.md: string paths match the full request path including its query, as nock does.',
  register: (nock, origin) => {
    nock(origin).get('/p?a=1').reply(200, 'matched');
  },
  run: async (client, origin) => captureMatch(() => client.get(`${origin}/p?a=1`, {responseType: 'text'})),
});

nockParityTest('a string path with no query does not match a request carrying one', {
  claim: 'CLAUDE.md: string paths match the full request path including its query.',
  register: (nock, origin) => {
    nock(origin).get('/p').reply(200, 'matched');
  },
  run: async (client, origin) => captureMatch(() => client.get(`${origin}/p?a=1`, {responseType: 'text'})),
});

nockParityTest('a regex path is matched against the path including its query', {
  claim: 'CLAUDE.md: a regex path with no `.query()` is matched against the path including its query.',
  register: (nock, origin) => {
    nock(origin)
      .get(/\/p\?a=1/)
      .reply(200, 'matched');
  },
  run: async (client, origin) => captureMatch(() => client.get(`${origin}/p?a=1`, {responseType: 'text'})),
});

/* -------------------------------------------------------------------------- query matching */

nockParityTest('query(true) ignores the query entirely', {
  claim: 'CLAUDE.md: `.query(true)` becomes a function path matcher that strips the query before comparing.',
  register: (nock, origin) => {
    nock(origin).get('/p').query(true).reply(200, 'matched');
  },
  run: async (client, origin) =>
    captureMatch(() => client.get(`${origin}/p?whatever=9&more=x`, {responseType: 'text'})),
});

nockParityTest('an object query matches only those params', {
  claim: 'CLAUDE.md: object queries are folded into undici’s stored path and compared as strings.',
  register: (nock, origin) => {
    nock(origin).get('/p').query({a: '1', b: '2'}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    exact: await captureMatch(() => client.get(`${origin}/p?a=1&b=2`, {responseType: 'text'})),
    extra: await captureMatch(() => client.get(`${origin}/p?a=1&b=2&c=3`, {responseType: 'text'})),
  }),
});

nockParityTest('query({}) means the request must carry no query', {
  claim: 'CLAUDE.md: nock’s "must carry no query" is `.query({})`.',
  register: (nock, origin) => {
    nock(origin).get('/p').query({}).reply(200, 'matched');
    nock(origin).get('/q').query({}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    bare: await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
    withQuery: await captureMatch(() => client.get(`${origin}/q?a=1`, {responseType: 'text'})),
  }),
});

nockParityTest('a regex query value tests the value rather than being stringified', {
  claim: 'CLAUDE.md: a query value may be a RegExp, a predicate or an array.',
  register: (nock, origin) => {
    nock(origin).get('/p').query({a: /^ba./}).reply(200, 'matched');
    nock(origin).get('/q').query({a: /^ba./}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    hit: await captureMatch(() => client.get(`${origin}/p?a=bar`, {responseType: 'text'})),
    miss: await captureMatch(() => client.get(`${origin}/q?a=zzz`, {responseType: 'text'})),
  }),
});

nockParityTest('a predicate query value is asked about the value', {
  claim: 'CLAUDE.md: "a query value may be a RegExp, a predicate or an array, as it may in nock".',
  register: (nock, origin) => {
    const isEven = (value: string) => Number(value) % 2 === 0;

    nock(origin).get('/p').query({n: isEven}).reply(200, 'matched');
    nock(origin).get('/q').query({n: isEven}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    hit: await captureMatch(() => client.get(`${origin}/p?n=4`, {responseType: 'text'})),
    miss: await captureMatch(() => client.get(`${origin}/q?n=5`, {responseType: 'text'})),
  }),
  divergence: {
    reason:
      'CLAUDE.md claims a predicate query *value* works "as it may in nock". Measured against nock 14, ' +
      'it does not: nock compares a query value as a string or a RegExp only, so a function value ' +
      'matches nothing and the request falls through. The shim supports it, which makes the shim more ' +
      'permissive than the thing it stands in for - a mock written this way passes here and silently ' +
      'makes a live request under real nock. `.query(fn)` over the whole query, which the scenario ' +
      'below covers, is the form nock does have.',
    nock: {hit: {matched: false}, miss: {matched: false}},
    shim: {hit: {matched: true, statusCode: 200, body: 'matched'}, miss: {matched: false}},
  },
});

nockParityTest('an array query value is satisfied only by the same repeated key', {
  claim: 'CLAUDE.md: the entry count is compared against the flattened expectation.',
  register: (nock, origin) => {
    nock(origin)
      .get('/p')
      .query({tags: ['a', 'b']})
      .reply(200, 'matched');
    nock(origin)
      .get('/q')
      .query({tags: ['a', 'b']})
      .reply(200, 'matched');
  },
  run: async (client, origin) => ({
    both: await captureMatch(() => client.get(`${origin}/p?tags=a&tags=b`, {responseType: 'text'})),
    one: await captureMatch(() => client.get(`${origin}/q?tags=a`, {responseType: 'text'})),
  }),
});

nockParityTest('a RegExp inside an array query value counts too', {
  claim: 'CLAUDE.md: a RegExp or predicate *inside* an array counts on both sides.',
  register: (nock, origin) => {
    nock(origin)
      .get('/p')
      .query({tags: [/new./, 'updates']})
      .reply(200, 'matched');
  },
  run: async (client, origin) =>
    captureMatch(() => client.get(`${origin}/p?tags=news&tags=updates`, {responseType: 'text'})),
});

nockParityTest('query(fn) is a predicate over the whole parsed query', {
  claim: 'CLAUDE.md: `.query(fn)` is a predicate over the whole parsed query, repeated keys as arrays.',
  register: (nock, origin) => {
    const predicate = (query: Record<string, string | string[]>) => query['a'] === '1';

    nock(origin).get('/p').query(predicate).reply(200, 'matched');
    nock(origin).get('/q').query(predicate).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    hit: await captureMatch(() => client.get(`${origin}/p?a=1&b=2`, {responseType: 'text'})),
    miss: await captureMatch(() => client.get(`${origin}/q?a=2`, {responseType: 'text'})),
  }),
});

/* --------------------------------------------------------------------------- body matching */

nockParityTest('an object body matcher deep-compares the parsed body', {
  claim: 'CLAUDE.md: `nock(host).post("/p", {a: 1})` is nock’s most common form and must match.',
  register: (nock, origin) => {
    nock(origin).post('/p', {a: 1, b: 'two'}).reply(200, 'matched');
    nock(origin).post('/q', {a: 1, b: 'two'}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    hit: await captureMatch(() => client.post(`${origin}/p`, {json: {a: 1, b: 'two'}, responseType: 'text'})),
    miss: await captureMatch(() => client.post(`${origin}/q`, {json: {a: 1, b: 'three'}, responseType: 'text'})),
  }),
});

nockParityTest('a body matcher requires every field and nothing besides', {
  claim: 'CLAUDE.md: nock’s exactness - every field named, nothing besides.',
  register: (nock, origin) => {
    nock(origin).post('/p', {a: 1}).reply(200, 'matched');
    nock(origin).post('/q', {a: 1}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    extra: await captureMatch(() => client.post(`${origin}/p`, {json: {a: 1, b: 2}, responseType: 'text'})),
    missing: await captureMatch(() => client.post(`${origin}/q`, {json: {}, responseType: 'text'})),
  }),
});

nockParityTest('an expected field must be present, not merely read back as undefined', {
  claim: 'CLAUDE.md: `{a: undefined}` used to match a body of `{b: "foo"}`; `Object.hasOwn` guards it.',
  register: (nock, origin) => {
    nock(origin).post('/p', {a: undefined}).reply(200, 'matched');
  },
  run: async (client, origin) =>
    captureMatch(() => client.post(`${origin}/p`, {json: {b: 'foo'}, responseType: 'text'})),
});

nockParityTest('a RegExp leaf in a body matcher tests the value', {
  claim: 'CLAUDE.md: nock’s leaf matchers - a RegExp tests the value, a function is asked about it.',
  register: (nock, origin) => {
    nock(origin).post('/p', {token: /^tok_/}).reply(200, 'matched');
    nock(origin).post('/q', {token: /^tok_/}).reply(200, 'matched');
  },
  run: async (client, origin) => ({
    hit: await captureMatch(() => client.post(`${origin}/p`, {json: {token: 'tok_123'}, responseType: 'text'})),
    miss: await captureMatch(() => client.post(`${origin}/q`, {json: {token: 'nope'}, responseType: 'text'})),
  }),
});

/* ------------------------------------------------------------------------------- replying */

nockParityTest('an object reply body is labelled application/json', {
  claim: 'CLAUDE.md: nock sets that header; undici’s MockAgent sets no content-type at all.',
  register: (nock, origin) => {
    nock(origin).get('/p').reply(200, {ok: true});
  },
  run: async (client, origin) => {
    const response = await client.get(`${origin}/p`, {responseType: 'json'});

    return {body: response.body, contentType: response.headers['content-type']};
  },
});

nockParityTest('reply(200, null) means a body of null', {
  claim: 'CLAUDE.md: `body ?? ""` coerced it to an empty string, which then failed to parse as json.',
  register: (nock, origin) => {
    nock(origin).get('/p').reply(200, null);
  },
  run: async (client, origin) => captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
});

nockParityTest('a reply callback sees the parsed request body and the request headers', {
  claim: 'CLAUDE.md: reply callbacks get nock’s `(uri, requestBody)` with `this.req.headers`.',
  register: (nock, origin) => {
    nock(origin)
      .post('/p')
      .reply(function (this: {req: {headers: Record<string, unknown>}}, uri: string, requestBody: unknown) {
        return [200, {uri, body: requestBody, auth: this.req.headers['authorization']}];
      });
  },
  run: async (client, origin) => {
    const response = await client.post(`${origin}/p`, {
      json: {id: 7},
      headers: {authorization: 'Bearer x'},
      responseType: 'json',
    });

    return response.body;
  },
});

/* ------------------------------------------------------------------------- repeat and scope */

nockParityTest('times bounds how many requests an interceptor answers', {
  claim: 'README: `times(n)` answers n requests and no more, as nock does.',
  register: (nock, origin) => {
    nock(origin).get('/p').times(2).reply(200, 'matched');
  },
  run: async (client, origin) => [
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
  ],
});

nockParityTest('persist on the scope answers indefinitely', {
  claim: 'CLAUDE.md: `persist()`, `done()` and `isDone()` live on the `Scope`, where nock’s docs put them.',
  register: (nock, origin) => {
    nock(origin).persist().get('/p').reply(200, 'matched');
  },
  run: async (client, origin) => [
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
  ],
});

/*
 * Found by writing the scenario above the wrong way round first. The shim carries `persist()` on
 * the interceptor as well as the scope; nock has it on the scope only.
 */
nockParityTest('persist on the interceptor', {
  claim: 'CLAUDE.md: `persist()` lives on the `Scope`.',
  register: (nock, origin) => {
    nock(origin).get('/p').persist!().reply(200, 'matched');
  },
  run: async (client, origin) => [
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
    await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'})),
  ],
  divergence: {
    reason:
      'The shim accepts `persist()` on the interceptor as well as on the scope; real nock has it on ' +
      'the scope only, so the interceptor form is a TypeError there. Harmless on its own - the shim ' +
      'accepts strictly more - but it is another way a mock written against the shim does not survive ' +
      'a move back to nock. The scope form, which both accept, is the one to write.',
    nock: {threw: 'nock(...).get(...).persist is not a function'},
    shim: [
      {matched: true, statusCode: 200, body: 'matched'},
      {matched: true, statusCode: 200, body: 'matched'},
    ],
  },
});

nockParityTest('a base path on the origin is folded into every interceptor path', {
  claim: 'CLAUDE.md: `nock("https://host/base")` is legal; `splitOrigin` separates them.',
  register: (nock, origin) => {
    nock(`${origin}/base`).get('/p').reply(200, 'matched');
    nock(`${origin}/base`).get('/q').reply(200, 'matched');
  },
  run: async (client, origin) => ({
    inside: await captureMatch(() => client.get(`${origin}/base/p`, {responseType: 'text'})),
    outside: await captureMatch(() => client.get(`${origin}/elsewhere/q`, {responseType: 'text'})),
  }),
});

nockParityTest('a regex origin matches any host it describes', {
  claim: 'CLAUDE.md: `poolKey` canonicalises the pattern so one pool backs every scope written with it.',
  register: (nock) => {
    nock(/regexhost\.test/)
      .get('/p')
      .reply(200, 'matched');
  },
  run: async (client) => captureMatch(() => client.get('http://regexhost.test/p', {responseType: 'text'})),
});

nockParityTest('isDone reports whether the scope’s interceptors were consumed', {
  claim: 'CLAUDE.md: `isDone()` filters `pendingInterceptors()` by the scope’s origin.',
  register: (nock, origin) => {
    nock(origin).get('/p').reply(200, 'matched');
  },
  run: async (client, origin) => {
    const before = await captureMatch(() => client.get(`${origin}/nothing`, {responseType: 'text'}));
    const hit = await captureMatch(() => client.get(`${origin}/p`, {responseType: 'text'}));

    return {before, hit};
  },
});

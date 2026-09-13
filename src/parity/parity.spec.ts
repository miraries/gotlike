import {capture, parityTest, reportDivergences, setupParityServer, summarise, type ParityClient} from './harness.ts';

setupParityServer();
reportDivergences();

/* ------------------------------------------------------------------ searchParams merging */

parityTest('a per-request searchParams merges with the client’s rather than replacing it', {
  claim:
    'CLAUDE.md: an `extend({searchParams: {apiKey, v}})` plus `get("items", {searchParams: {page: 2}})` ' +
    'goes out as `?apiKey=secret&v=1&page=2`.',
  run: async (client, base) => {
    const scoped = client.extend({prefixUrl: base, responseType: 'json', searchParams: {apiKey: 'secret', v: '1'}});

    const inherited = await scoped.get('echo');
    const merged = await scoped.get('echo', {searchParams: {page: 2}});

    return [(inherited.body as {path: string}).path, (merged.body as {path: string}).path];
  },
});

parityTest('a per-request searchParams key replaces the client’s, exactly once and at the end', {
  claim: 'CLAUDE.md: got deletes every occurrence of a key the override names before appending it.',
  run: async (client, base) => {
    const scoped = client.extend({prefixUrl: base, responseType: 'json', searchParams: {apiKey: 'secret', v: '1'}});
    const response = await scoped.get('echo', {searchParams: {apiKey: 'override'}});

    return (response.body as {path: string}).path;
  },
});

/* ------------------------------------------------------------------------ header folding */

parityTest('a per-call header replaces an instance header of different case', {
  claim: 'CLAUDE.md: a per-call `Authorization` replaces an instance `authorization` rather than joining it.',
  run: async (client, base) => {
    const scoped = client.extend({prefixUrl: base, responseType: 'json', headers: {authorization: 'Bearer stale'}});
    const response = await scoped.get('echo', {headers: {Authorization: 'Bearer fresh'}});

    return (response.body as {headers: Record<string, string>}).headers['authorization'];
  },
});

/* ---------------------------------------------------------------------------- basic auth */

parityTest('credentials in the url become Basic auth', {
  claim: 'CLAUDE.md: `http://user:pass@host/` must go out with an Authorization header, as got’s does.',
  run: async (client, base) => {
    const withCreds = base.replace('http://', 'http://user:pa%40ss@');
    const response = await client.get(`${withCreds}/echo`, {responseType: 'json'});

    return (response.body as {headers: Record<string, string>}).headers['authorization'];
  },
});

/* -------------------------------------------------------------------------- error codes */

parityTest('a refused connection reports ECONNREFUSED with the underlying message', {
  claim: 'CLAUDE.md: `err.code === "ECONNREFUSED"` works, and `messageOf` keeps the underlying message.',
  run: async (client) => capture(() => client.get('http://127.0.0.1:1/nothing')),
});

parityTest('an unresolvable host reports ENOTFOUND', {
  claim: 'CLAUDE.md: measured against got 14 - ECONNREFUSED and ENOTFOUND on both.',
  run: async (client) => capture(() => client.get('http://does-not-exist.invalid/nothing')),
});

/* ------------------------------------------------------- error statuses and parse failures */

parityTest('an unparseable body on an error status runs afterResponse and throws HTTPError', {
  claim:
    'CLAUDE.md: measured against got 14 - the hooks run, the body stays as the text that arrived, ' +
    'and the HTTP error is what is thrown.',
  run: async (client, base) => {
    const seen: number[] = [];
    const scoped = client.extend({
      responseType: 'json',
      hooks: {
        afterResponse: [
          (response: {statusCode: number}) => {
            seen.push(response.statusCode);

            return response;
          },
        ],
      },
    });

    const outcome = await capture(() => scoped.get(`${base}/html-error?code=500`), base);

    return {seen, outcome};
  },
  divergence: {
    reason:
      'The claim itself holds - the hook sees the 500, the body stays as the text that arrived, and an ' +
      'HTTPError is thrown. What differs is the error’s `code` and `message`: got says ' +
      '`ERR_NON_2XX_3XX_RESPONSE`, gotlike says `ERR_HTTP_ERROR`. A got caller matching on `code` has to ' +
      'change; one matching on `name` or `response.statusCode` does not.',
    got: {
      seen: [500],
      outcome: {
        outcome: 'rejected',
        name: 'HTTPError',
        code: 'ERR_NON_2XX_3XX_RESPONSE',
        message: 'Request failed with status code 500 (Internal Server Error): GET <base>/html-error?code=500',
        responseStatus: 500,
        responseBody: '<html><body>Gateway problem</body></html>',
      },
    },
    gotlike: {
      seen: [500],
      outcome: {
        outcome: 'rejected',
        name: 'HTTPError',
        code: 'ERR_HTTP_ERROR',
        message: 'Response code 500',
        responseStatus: 500,
        responseBody: '<html><body>Gateway problem</body></html>',
      },
    },
  },
});

parityTest('an unparseable body on an error status resolves when throwHttpErrors is off', {
  claim: 'CLAUDE.md: with throwHttpErrors off it resolves with the raw body - got never raises a parse error there.',
  run: async (client, base) => {
    const response = await client.get(`${base}/html-error?code=500`, {responseType: 'json', throwHttpErrors: false});

    return summarise(response);
  },
});

/* ------------------------------------------------------------------------ afterResponse */

parityTest('a retry re-runs only the afterResponse hooks before the one that retried', {
  claim: 'CLAUDE.md: measured against got-cjs - `[h1, h2]` with `h2` retrying gives `h1, h2, h1`.',
  run: async (client, base) => {
    const order: string[] = [];
    let retried = false;

    const scoped = client.extend({
      hooks: {
        afterResponse: [
          (response: {statusCode: number}) => {
            order.push(`h1:${response.statusCode}`);

            return response;
          },
          (response: {statusCode: number}, retry: (options: Record<string, unknown>) => unknown) => {
            order.push(`h2:${response.statusCode}`);

            if (!retried) {
              retried = true;

              return retry({headers: {authorization: 'Bearer refreshed'}});
            }

            return response;
          },
        ],
      },
    });

    await scoped.get(`${base}/echo`);

    return order;
  },
});

parityTest('an afterResponse retry with credentials in a new url replaces the stale Basic auth header', {
  claim: 'CLAUDE.md: measured against got 14, which sends the new url’s credentials.',
  run: async (client, base) => {
    const first = base.replace('http://', 'http://user1:pass1@');
    const second = base.replace('http://', 'http://user2:pass2@');
    let retried = false;

    const scoped = client.extend({
      responseType: 'json',
      hooks: {
        afterResponse: [
          (response: unknown, retry: (options: Record<string, unknown>) => unknown) => {
            if (retried) {
              return response;
            }

            retried = true;

            return retry({url: `${second}/echo`});
          },
        ],
      },
    });

    const response = await scoped.get(`${first}/echo`);

    return (response.body as {headers: Record<string, string>}).headers['authorization'];
  },
});

/* ------------------------------------------------------------------------ beforeRequest */

parityTest('a retry re-runs the beforeRequest hooks over the url the first attempt used', {
  claim: 'CLAUDE.md: got 14 sends `/echo?sig=x` then `/echo?sig=x&sig=x`.',
  run: async (client, base) => {
    const urls: string[] = [];
    let retried = false;

    const scoped = client.extend({
      prefixUrl: base,
      responseType: 'json',
      throwHttpErrors: false,
      hooks: {
        beforeRequest: [
          (options: {url: string | URL}) => {
            const url = String(options.url);

            options.url = url + (url.includes('?') ? '&' : '?') + 'sig=x';
            urls.push(String(options.url));
          },
        ],
        afterResponse: [
          (response: unknown, retry: (options: Record<string, unknown>) => unknown) => {
            if (retried) {
              return response;
            }

            retried = true;

            return retry({headers: {'x-retried': 'yes'}});
          },
        ],
      },
    });

    await scoped.get('echo', {searchParams: {page: '1'}});

    return urls.map((url) => url.replace(base, '<base>'));
  },
  divergence: {
    reason:
      'Conditional on `searchParams`, which is what makes it worth pinning. With no searchParams the two ' +
      'agree and the append accumulates (see the scenario above). With a searchParams set, gotlike ' +
      're-resolves the url from it on the retry and wipes the hook’s append, while got carries the first ' +
      'attempt’s url forward and accumulates (`?page=1&sig=x` then `?page=1&sig=x&sig=x`). gotlike’s is ' +
      'arguably the better behaviour - an accumulating signature is corruption - but CLAUDE.md’s blanket ' +
      '"both exactly what got does" is true only of the no-searchParams case.',
    got: ['<base>/echo?page=1&sig=x', '<base>/echo?page=1&sig=x&sig=x'],
    gotlike: ['<base>/echo?page=1&sig=x', '<base>/echo?page=1&sig=x'],
  },
});

/*
 * The same hook with no `searchParams` in play. This is the case CLAUDE.md's prose describes,
 * and here gotlike does match got: the append accumulates across the retry. Keeping both
 * scenarios is what shows the divergence above is specific to `searchParams` being set, rather
 * than a blanket difference in how the hook is re-run.
 */
parityTest('a beforeRequest url append accumulates across a retry when no searchParams is set', {
  claim: 'CLAUDE.md: got 14 sends `/items?sig=x` then `/items?sig=x&sig=x`.',
  run: async (client, base) => {
    const urls: string[] = [];
    let retried = false;

    const scoped = client.extend({
      prefixUrl: base,
      responseType: 'json',
      throwHttpErrors: false,
      hooks: {
        beforeRequest: [
          (options: {url: string | URL}) => {
            const url = String(options.url);

            options.url = url + (url.includes('?') ? '&' : '?') + 'sig=x';
            urls.push(String(options.url));
          },
        ],
        afterResponse: [
          (response: unknown, retry: (options: Record<string, unknown>) => unknown) => {
            if (retried) {
              return response;
            }

            retried = true;

            return retry({headers: {'x-retried': 'yes'}});
          },
        ],
      },
    });

    await scoped.get('echo');

    return urls.map((url) => url.replace(base, '<base>'));
  },
});

/* ----------------------------------------------------------------------------- redirects */

parityTest('a followed redirect reports the final url and reaches the destination', {
  claim: 'CLAUDE.md: got documents `response.url` as the final url; gotlike tracks `lastUrl` to match.',
  run: async (client, base) => {
    const scoped = client.extend({followRedirect: true});
    const response = await scoped.get(`${base}/redirect?to=/echo`, {responseType: 'json'});

    return {url: String(response.url), path: (response.body as {path: string}).path};
  },
});

/* ------------------------------------------------------------------------------- bodies */

parityTest('a json body is serialised and labelled application/json', {
  claim: 'CLAUDE.md: `json` sets a Content-Type unless one is already present.',
  run: async (client, base) => {
    const response = await client.post(`${base}/echo`, {json: {a: 1, b: 'two'}, responseType: 'json'});
    const echoed = response.body as {body: string; headers: Record<string, string>};

    return {body: echoed.body, contentType: echoed.headers['content-type']};
  },
});

parityTest('a form body is urlencoded and labelled', {
  claim: 'CLAUDE.md: `form` sets a Content-Type unless one is already present.',
  run: async (client, base) => {
    const response = await client.post(`${base}/echo`, {form: {a: '1', b: 'two'}, responseType: 'json'});
    const echoed = response.body as {body: string; headers: Record<string, string>};

    return {body: echoed.body, contentType: echoed.headers['content-type']};
  },
});

/* --------------------------------------------------------------------------------- retry */

parityTest('a retried status is retried the configured number of times', {
  claim: 'README: retry support follows got’s option names; `limit` bounds the attempts.',
  run: async (client: ParityClient, base) => {
    const scoped = client.extend({retry: {limit: 2, backoffLimit: 10, statusCodes: [503], methods: ['GET']}});

    const response = await scoped.get(`${base}/flaky?fail=1&code=503`, {responseType: 'json'});

    return {
      statusCode: response.statusCode,
      retryCount: response.retryCount,
      path: (response.body as {path: string}).path,
    };
  },
});

/* ------------------------------------------------------------------- bodyless responses */

parityTest('a 204 read as json resolves rather than failing to parse', {
  claim: 'CLAUDE.md: `hasNoBody()` short-circuits parsing for 204/205/304 and HEAD.',
  run: async (client, base) => {
    const response = await client.get(`${base}/status?code=204`, {responseType: 'json'});

    return {statusCode: response.statusCode, body: response.body, type: typeof response.body};
  },
  divergence: {
    reason:
      'Both resolve rather than failing to parse, which is the claim. The empty body differs: got hands ' +
      'back `""` for `responseType: json`, gotlike hands back `undefined`. gotlike’s is the more honest ' +
      'value - `""` is not json - but a got caller testing `body === ""` sees a change.',
    got: {statusCode: 204, body: '', type: 'string'},
    gotlike: {statusCode: 204, body: undefined, type: 'undefined'},
  },
});

parityTest('a HEAD request has no body to parse', {
  claim: 'CLAUDE.md: HEAD is bodyless - the body is undefined for json, empty for text.',
  run: async (client, base) => {
    const response = await client.head(`${base}/echo`);

    return {statusCode: response.statusCode, body: response.body};
  },
  divergence: {
    reason:
      'GAP, not a design choice: gotlike ships no `head()` verb at all. HEAD is a supported method and ' +
      '`hasNoBody()` handles it, but it is only reachable as `client(url, {method: "HEAD"})`. got has ' +
      '`got.head()`, so a drop-in consumer calling it gets a TypeError. Adding the verb would close this ' +
      'and let the scenario compare properly.',
    got: {statusCode: 200, body: ''},
    gotlike: {threw: 'client.head is not a function'},
  },
});

/* ----------------------------------------------------------------------- parse failures */

parityTest('an unparseable body on an ok status is a parse failure', {
  claim: 'CLAUDE.md: only a parse failure on an otherwise-ok status is a ParseError.',
  run: async (client, base) => capture(() => client.get(`${base}/not-json`, {responseType: 'json'}), base),
  divergence: {
    reason:
      'Name, code, status and raw body all match. got appends ` in "<url>"` to the parse message; gotlike ' +
      'reports V8’s message unchanged. Cosmetic, but it is what a log line greps on.',
    got: {
      outcome: 'rejected',
      name: 'ParseError',
      code: 'ERR_BODY_PARSE_FAILURE',
      message: `Unexpected token 'h', "this is not json" is not valid JSON in "<base>/not-json"`,
      responseStatus: 200,
      responseBody: 'this is not json',
    },
    gotlike: {
      outcome: 'rejected',
      name: 'ParseError',
      code: 'ERR_BODY_PARSE_FAILURE',
      message: `Unexpected token 'h', "this is not json" is not valid JSON`,
      responseStatus: 200,
      responseBody: 'this is not json',
    },
  },
});

/* ---------------------------------------------------------------------------- prefixUrl */

parityTest('prefixUrl joins without doubling the slash', {
  claim: 'CLAUDE.md: `resolveUrl` joins `prefixUrl` without doubling slashes.',
  run: async (client, base) => {
    const scoped = client.extend({prefixUrl: `${base}/`, responseType: 'json'});
    const response = await scoped.get('echo');

    return (response.body as {path: string}).path;
  },
});

/*
 * Found by the property tests, which generated a leading slash on a relative path and got two
 * different answers. Worth pinning rather than folding away: it is the one place found so far
 * where gotlike accepts what got refuses, and being *more* permissive than the thing you are
 * standing in for is its own hazard - a consumer's accidental `/path` under a `prefixUrl` is a
 * loud error in got and a silent one here.
 */
parityTest('a leading slash on a path under prefixUrl', {
  claim: 'CLAUDE.md: every leading slash is stripped from `url`, not just the first.',
  run: async (client, base) => {
    const scoped = client.extend({prefixUrl: base, responseType: 'json'});

    return capture(async () => {
      const response = await scoped.get('/echo');

      return (response.body as {path: string}).path;
    }, base);
  },
  divergence: {
    reason:
      'got refuses the combination outright ("`url` must not start with a slash"). gotlike strips every ' +
      'leading slash and dispatches - which is what keeps `//x` from joining as `prefix//x`, but ' +
      'also means a caller who meant an absolute path gets a silently different request where got ' +
      'would have stopped them. Nothing in CLAUDE.md said got rejects it; the note there only ' +
      'covers the doubled-slash half.',
    got: {
      outcome: 'rejected',
      name: 'RequestError',
      code: 'ERR_GOT_REQUEST_ERROR',
      message: '`url` must not start with a slash',
      responseStatus: undefined,
      responseBody: undefined,
    },
    gotlike: {outcome: 'resolved', value: '/echo'},
  },
});

/* ----------------------------------------------------------------------- resolveBodyOnly */

parityTest('resolveBodyOnly hands back the body rather than the response', {
  claim: 'README: `resolveBodyOnly` returns the parsed body directly, as got does.',
  run: async (client, base) => {
    const body = await client.get(`${base}/echo`, {responseType: 'json', resolveBodyOnly: true});

    return (body as unknown as {path: string}).path;
  },
});

/* -------------------------------------------------------------------------- throwHttpErrors */

parityTest('throwHttpErrors off resolves an error status', {
  claim: 'README: with `throwHttpErrors: false` a 4xx/5xx resolves rather than throwing.',
  run: async (client, base) => {
    const response = await client.get(`${base}/status?code=404`, {throwHttpErrors: false});

    return {statusCode: response.statusCode, body: response.body};
  },
});

/* ------------------------------------------------------------------------- decompression */

parityTest('a gzipped response is decompressed', {
  claim: 'CLAUDE.md: `decompress` composes the interceptor and sends an accept-encoding header.',
  run: async (client, base) => {
    const response = await client.get(`${base}/gzip`, {responseType: 'json'});

    return response.body;
  },
});

/* ------------------------------------------------------------------------ multi-valued headers */

parityTest('a multi-valued request header goes out as two headers', {
  claim: 'CLAUDE.md: a header whose value is an array must survive as an array.',
  run: async (client, base) => {
    const response = await client.get(`${base}/echo`, {responseType: 'json', headers: {'x-a': ['one', 'two']}});

    return (response.body as {headers: Record<string, unknown>}).headers['x-a'];
  },
});

/* -------------------------------------------------------------------------- beforeError */

parityTest('beforeError may replace the error that is thrown', {
  claim: 'README: `beforeError` hooks may return a replacement error.',
  run: async (client, base) => {
    const scoped = client.extend({
      hooks: {
        beforeError: [
          (error: Error) => {
            const replacement = new Error(`wrapped: ${error.name}`);

            return replacement;
          },
        ],
      },
    });

    return capture(() => scoped.get(`${base}/status?code=500`), base);
  },
});

/* ----------------------------------------------------------------------------- timeouts */

parityTest('timeout.request bounds each attempt rather than the whole retry sequence', {
  claim: 'CLAUDE.md: measured against got 14, which runs all of the attempts.',
  run: async (client, base) => {
    const scoped = client.extend({retry: {limit: 3, backoffLimit: 10, statusCodes: [503], methods: ['GET']}});

    const response = await scoped.get(`${base}/flaky?fail=2&delay=100&code=503`, {
      responseType: 'json',
      timeout: {request: 400},
    });

    return {statusCode: response.statusCode, retryCount: response.retryCount};
  },
});

/* ------------------------------------------------------------- url as argument and option */

parityTest('a url given both as an argument and as an option is rejected', {
  claim: 'CLAUDE.md: got refuses the combination outright rather than picking a winner.',
  run: async (client, base) => capture(() => client.get(`${base}/echo`, {url: `${base}/status?code=404`}), base),
  divergence: {
    reason:
      'The claim holds - both refuse, and neither sends a request. The error differs: got throws a ' +
      '`RequestError` with code `ERR_GOT_REQUEST_ERROR`, gotlike a `ValidationError` with **no code at ' +
      'all**. The missing code is worth noting on its own: every other gotlike error carries one, so ' +
      '`err.code` is undefined exactly here.',
    got: {
      outcome: 'rejected',
      name: 'RequestError',
      code: 'ERR_GOT_REQUEST_ERROR',
      message: 'The `url` option is mutually exclusive with the `input` argument',
      responseStatus: undefined,
      responseBody: undefined,
    },
    gotlike: {
      outcome: 'rejected',
      name: 'ValidationError',
      code: undefined,
      message: '`url` cannot be given both as an argument and as an option',
      responseStatus: undefined,
      responseBody: undefined,
    },
  },
});

import {text} from 'node:stream/consumers';
import {
  capture,
  parityTest,
  reportDivergences,
  setupParityServer,
  summarise,
  type AnyResponse,
  type ParityClient,
} from './harness.ts';

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

/*
 * Empty is not the same as absent. got keeps credentials on a `URL`, and node's
 * `urlToHttpOptions` derives `auth` only when `url.username || url.password` - so every row here
 * goes out anonymous there. Testing `!== undefined` instead sent `Authorization: Basic Og==` for
 * all of them, an anonymous credential an upstream is free to reject or log, off the back of a
 * `{username: config.user ?? ''}` that meant "no credentials at all".
 */
parityTest('empty credentials send no authorization header', {
  claim: 'CLAUDE.md: explicit `username`/`password` options win, and derive a header the way got derives one.',
  run: async (client, base) => {
    const sent: (string | undefined)[] = [];

    for (const options of [{username: ''}, {username: '', password: ''}, {password: ''}]) {
      const response = await client.get(`${base}/echo`, {...options, responseType: 'json'});

      sent.push((response.body as {headers: Record<string, string>}).headers['authorization']);
    }

    // A password on its own is still a credential, so the rule must not swallow that too.
    const withPassword = await client.get(`${base}/echo`, {password: 'secret', responseType: 'json'});

    sent.push((withPassword.body as {headers: Record<string, string>}).headers['authorization']);

    return sent;
  },
});

/*
 * `\` is a path separator for the special schemes, so `http://host\@other/p` is host `host` with
 * the path `/@other/p` - to `new URL`, to got and to undici alike. gotlike's own authority scan
 * stopped only at `/?#`, read `host\` as userinfo, and rewrote the url to `http://other/p`: the
 * request, and an `Authorization` minted out of the fake userinfo, went to a host no parser had
 * ever named. An application that allowlists `new URL(input).hostname` and passes the string on -
 * which is how an SSRF filter is written - saw the allowed host and reached the other one.
 *
 * What carries the weight here is the wire log the harness compares on every scenario: it says
 * which server was addressed and with what path, which is the whole question. `response.url` is
 * only re-parsed for the host, because gotlike leaves it the string it was given where got hands
 * back a normalised `URL` - a divergence of its own, already recorded in the README.
 */
parityTest('a backslash in a url is a path separator, not the end of an authority', {
  claim: 'CLAUDE.md: the authority is located by index, and has to stop where WHATWG URL stops.',
  run: async (client, base) => {
    const response = await client.get(`${base}\\@evil.test/echo`, {responseType: 'text', throwHttpErrors: false});

    return {
      statusCode: response.statusCode,
      host: new URL(String(response.url)).host.replace(new URL(base).host, '<base>'),
    };
  },
});

/* -------------------------------------------------------------------------- error codes */

parityTest('a refused connection reports ECONNREFUSED with the underlying message', {
  claim: 'CLAUDE.md: `err.code === "ECONNREFUSED"` works, and `messageOf` keeps the underlying message.',
  run: async (client) => capture(() => client.get('http://127.0.0.1:1/nothing')),
});

parityTest('an unresolvable host reports ENOTFOUND', {
  claim: 'CLAUDE.md: measured against got 16 - ECONNREFUSED and ENOTFOUND on both.',
  run: async (client) => capture(() => client.get('http://does-not-exist.invalid/nothing')),
});

/* ------------------------------------------------------- error statuses and parse failures */

parityTest('an unparseable body on an error status runs afterResponse and throws HTTPError', {
  claim:
    'CLAUDE.md: measured against got 16 - the hooks run, the body stays as the text that arrived, ' +
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
      'Down to the query string alone now. `code`, `name`, `response.statusCode`, the raw body and the ' +
      'message’s whole phrasing all match got; the url in it is truncated at the `?`. That is the one ' +
      'deliberate difference: got names the full url, which is how an api key, a signature or a session ' +
      'token in a query string ends up in every log line and APM group that prints the error. The path ' +
      'identifies the request, the query is what leaks, so the path stays and the query goes.',
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
        code: 'ERR_NON_2XX_3XX_RESPONSE',
        message: 'Request failed with status code 500 (Internal Server Error): GET <base>/html-error',
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
  claim: 'CLAUDE.md: measured against got 16, which sends the new url’s credentials.',
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
  claim: 'CLAUDE.md: got 16 sends `/echo?sig=x` then `/echo?sig=x&sig=x`.',
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
  claim: 'CLAUDE.md: got 16 sends `/items?sig=x` then `/items?sig=x&sig=x`.',
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

/*
 * `null` and `undefined` are not the same value here, and treating them as one lost a parameter
 * off the wire: `{a: null}` went out as no `a` at all where got sends `a=`. Silent, and a
 * genuine semantic change for an upstream that tells "absent" from "present and empty" - a
 * filter being cleared, a tri-state flag, anything signing over the canonical query.
 *
 * Pinned against got rather than described, because the prose had it wrong in exactly the way
 * prose does: CLAUDE.md said "null or undefined are dropped - got does the same", which is true
 * of `undefined` and false of `null`, and nothing ran to contradict it.
 */
parityTest('a null searchParams value is sent as an empty one and undefined is dropped', {
  claim: 'README: a `null` entry is sent with an empty value and an `undefined` one is dropped, as got does.',
  run: async (client, base) => {
    const response = await client.get(`${base}/echo`, {
      responseType: 'json',
      searchParams: {keep: 'yes', blank: null, drop: undefined, zero: 0, empty: ''},
    });

    return (response.body as {path: string}).path;
  },
});

/*
 * `form` shares the serialiser, so it gets the same rule - and here that is a deliberate
 * divergence rather than parity. got builds the body with `new URLSearchParams(form)`, which
 * stringifies both into the literal text `blank=null` and `drop=undefined`. That is a
 * serialisation artefact rather than an intent: got's own `searchParams` does neither of those
 * things with the same two values, and no server wants the four characters `null` in a form
 * field. Keeping the key with an empty value preserves what the old behaviour actually lost,
 * which was the key.
 *
 * Recorded rather than skipped, so a got release that tidies this up fails the suite too.
 */
parityTest('a null form value', {
  claim: 'CLAUDE.md: `form` is serialised like `searchParams`.',
  run: async (client, base) => {
    const response = await client.post(`${base}/echo`, {
      responseType: 'json',
      form: {keep: 'yes', blank: null, drop: undefined},
    });

    return (response.body as {body: string}).body;
  },
  divergence: {
    reason:
      'got stringifies both into the body (`blank=null&drop=undefined`), because it serialises `form` ' +
      'with `new URLSearchParams(form)` - which is not what got itself does with the same values in ' +
      '`searchParams`. gotlike applies one rule to both: `null` is an empty value, `undefined` is absent. ' +
      'The key survives either way, which is what the old drop-everything behaviour lost.',
    got: 'keep=yes&blank=null&drop=undefined',
    gotlike: 'keep=yes&blank=',
  },
});

/*
 * The other shape of value the shared serialiser takes, and the other place the two disagree.
 *
 * An array repeats the key here (`a=1&a=2`), which is how a query or a form carries a repeated
 * field and what `URLSearchParams.append` is for. got's `searchParams` refuses an array outright
 * - its `searchParams` is typed `Record<string, string | number | boolean | null | undefined>`
 * and the value is validated - while its `form` accepts one and lets
 * `new URLSearchParams(form)` stringify it to the single value `1,2`. So got is stricter than
 * this on one option and looser on the other, for the same input.
 *
 * Both halves are pinned rather than explored by `property.spec.ts`, whose generators build one
 * value per key on purpose: got *rejects* the array form of `searchParams`, so a generated case
 * carrying one could only ever be a divergence, and a suite that generates divergences stops
 * being able to find them.
 */
parityTest('an array searchParams value', {
  claim: 'README: an array value repeats the key (`{a: [1, 2]}` becomes `?a=1&a=2`).',
  run: async (client, base) =>
    capture(async () => {
      const response = await client.get(`${base}/echo`, {
        responseType: 'json',
        searchParams: {tags: ['news', 'sport'], page: 2},
      });

      return (response.body as {path: string}).path;
    }, base),
  divergence: {
    reason:
      'got rejects an array `searchParams` value outright - its own type allows a single string, ' +
      'number, boolean or null per key, and the value is validated. gotlike repeats the key, which ' +
      'is the only way to express a repeated query parameter and is what `URLSearchParams` is for. ' +
      'More permissive than got rather than different on the wire, so code moving *to* gotlike is ' +
      'unaffected; code moving back is not.',
    got: {
      outcome: 'rejected',
      name: 'RequestError',
      code: 'ERR_GOT_REQUEST_ERROR',
      message:
        "Option 'searchParams.tags': Expected values which are `string`, `number`, `boolean`, `null`, " +
        'or `undefined`. Received values of type `Array`.',
      responseStatus: undefined,
      responseBody: undefined,
    },
    gotlike: {outcome: 'resolved', value: '/echo?tags=news&tags=sport&page=2'},
  },
});

parityTest('an array form value', {
  claim: 'CLAUDE.md: `form` is serialised like `searchParams`, so an array value repeats the key.',
  run: async (client, base) => {
    const response = await client.post(`${base}/echo`, {
      responseType: 'json',
      form: {tags: ['news', 'sport'], page: 2},
    });

    return (response.body as {body: string}).body;
  },
  divergence: {
    reason:
      'got serialises `form` with `new URLSearchParams(form)`, which stringifies the array into the ' +
      'single value `news,sport` - the same artefact as the null/undefined row above, and not what ' +
      'got does with an array in `searchParams` (it refuses one). gotlike repeats the key, which is ' +
      'what a server decoding a multi-valued form field expects. A silent wire difference for an ' +
      'identical call, so it is recorded here and in the README rather than left to be discovered.',
    got: 'tags=news%2Csport&page=2',
    gotlike: 'tags=news&tags=sport&page=2',
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

/*
 * The other half of that, and the half that was a bug rather than a divergence: a status that
 * *can* carry a body and did not. `hasNoBody` covers 204/205/304 and HEAD, so every other empty
 * body fell into `JSON.parse('')` and came back out as a `ParseError` - a `201 Created` with
 * nothing in it, a `200` with `content-length: 0`, a `3xx` read with `followRedirect` off. got
 * resolves all of them with `""`, because its `parseBody` tests `rawBody.length === 0` before it
 * reaches the JSON codec.
 *
 * A table rather than one status, because what was wrong was a *range*: the bodyless statuses
 * were handled and every other one was not, so a scenario naming a single code could pass while
 * the neighbouring ones failed.
 */
parityTest('an empty body on a status that can carry one resolves rather than failing to parse', {
  claim: 'README: a parse failure is a `ParseError` - an empty body is not a parse failure.',
  run: async (client, base) => {
    const scoped = client.extend({responseType: 'json', throwHttpErrors: false, followRedirect: false});
    const outcomes: Record<string, unknown> = {};

    for (const code of [200, 201, 202, 302, 404, 500]) {
      outcomes[code] = await capture(async () => {
        const response = await scoped.get(`${base}/status?code=${code}`);

        return {statusCode: response.statusCode, body: response.body, type: typeof response.body};
      }, base);
    }

    return outcomes;
  },
});

parityTest('a HEAD request has no body to parse', {
  claim: 'CLAUDE.md: HEAD is bodyless - the body is undefined for json, empty for text.',
  run: async (client, base) => {
    const response = await client.head(`${base}/echo`);

    return {statusCode: response.statusCode, body: response.body};
  },
});

/* ----------------------------------------------------------------------- parse failures */

parityTest('an unparseable body on an ok status is a parse failure', {
  claim: 'CLAUDE.md: only a parse failure on an otherwise-ok status is a ParseError.',
  run: async (client, base) => capture(() => client.get(`${base}/not-json`, {responseType: 'json'}), base),
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
 * An empty `url` under a `prefixUrl` - `client.get('')`, the collection root. got normalises the
 * prefix to end in `/` and resolves `''` against it, so it always requests the directory form.
 * Handing the prefix back verbatim put a different path on the wire (`/echo` against got's
 * `/echo/`), which a server is free to answer with a 301 - not followed by default here, so it
 * surfaces as the redirect itself - or a 404.
 *
 * Both spellings of the prefix, because the difference only ever showed for the one *without* a
 * trailing slash: with one, the two agreed, so a scenario written that way would have passed
 * throughout.
 */
parityTest('an empty url under a prefixUrl resolves to the prefix with its slash', {
  claim: 'CLAUDE.md: `resolveUrl` joins `prefixUrl` and `url`; an empty `url` is the prefix itself.',
  run: async (client, base) => {
    const paths: Record<string, unknown> = {};

    for (const [label, prefixUrl] of [
      ['no trailing slash', `${base}/echo`],
      ['trailing slash', `${base}/echo/`],
    ] as const) {
      const scoped = client.extend({prefixUrl, responseType: 'json'});

      paths[label] = (((await scoped.get('')) as {body: unknown}).body as {path: string}).path;
    }

    return paths;
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
  claim: 'CLAUDE.md: measured against got 16, which runs all of the attempts.',
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
      'The claim holds - both refuse, and neither sends a request. What is left is the error’s class ' +
      'and code: got throws a bare `TypeError` with no code (since got 15 a `url` key in an options ' +
      'object is refused outright, so the message is about the option rather than the combination), gotlike a ' +
      '`ValidationError` with `ERR_INVALID_OPTION`. Keeping a distinct class for "you configured this ' +
      'wrong" rather than folding it into `RequestError` is deliberate, since it is a programming error ' +
      'rather than a request that failed. got 14 threw a `RequestError`/`ERR_GOT_REQUEST_ERROR` here ' +
      'with the message "The `url` option is mutually exclusive with the `input` argument"; the change ' +
      'came with the got 16 bump and is the whole reason this is pinned rather than skipped.',
    got: {
      outcome: 'rejected',
      name: 'TypeError',
      code: undefined,
      message: 'The `url` option is not supported in options objects. Pass it as the first argument instead.',
      responseStatus: undefined,
      responseBody: undefined,
    },
    gotlike: {
      outcome: 'rejected',
      name: 'ValidationError',
      code: 'ERR_INVALID_OPTION',
      message: '`url` cannot be given both as an argument and as an option',
      responseStatus: undefined,
      responseBody: undefined,
    },
  },
});

/* ------------------------------------------------------------- url as an option alone */

/**
 * The callable form's own signature, and a divergence that only exists as of got 16.
 *
 * `client({url, ...})` is documented and is how a caller passes a url alongside everything
 * else in one object. got 12 and 14 took it; got 16 removed the option and answers with a
 * `TypeError` in every position. gotlike keeps it - `igd-aggregator-api` is on `got-cjs@12`,
 * where this is the ordinary spelling - so the two now disagree about a form the README
 * advertises. Pinned on both sides so neither can move without the suite noticing.
 */
parityTest('a url given only as an option', {
  claim: 'README: the callable client takes `gotlike({url, ...})` as well as `gotlike(url, options)`.',
  run: async (client, base) => {
    const callable = client as unknown as (options: Record<string, unknown>) => Promise<AnyResponse>;

    try {
      const response = await callable({url: `${base}/status?code=204`});

      return {outcome: 'resolved', statusCode: response.statusCode};
    } catch (error) {
      const failure = error as Error & {code?: string};

      return {outcome: 'rejected', name: failure.name, code: failure.code, message: failure.message};
    }
  },
  divergence: {
    reason:
      'got refuses a `url` key in an options object as of got 15: it throws a `TypeError` rather than ' +
      'sending anything, here as well as alongside a positional argument. gotlike accepts it and dispatches, ' +
      'because the callable `client({url, ...})` form is built on that option and got-cjs@12 - what ' +
      'the consumer this package exists for actually runs - accepts it too. Dropping it to match got ' +
      '16 would break the documented callable form for no gain.',
    got: {
      outcome: 'rejected',
      name: 'TypeError',
      code: undefined,
      message: 'The `url` option is not supported in options objects. Pass it as the first argument instead.',
    },
    gotlike: {outcome: 'resolved', statusCode: 204},
  },
});

/* ------------------------------------------------------------- cross-origin hook rewrites */

/*
 * `127.0.0.1` and `localhost` are different origins reaching the same server, which is what
 * lets one echo route answer both sides of the boundary without a second listener.
 */
const otherOrigin = (base: string) => base.replace('127.0.0.1', 'localhost');

type EchoBody = {method: string; path: string; headers: Record<string, string>; body: string};

const echoed = (body: unknown) => {
  const echo = body as EchoBody;

  return {
    path: echo.path,
    authorization: echo.headers['authorization'],
    cookie: echo.headers['cookie'],
    contentType: echo.headers['content-type'],
    body: echo.body,
  };
};

parityTest('a beforeRequest hook that changes origin drops the credentials and the body', {
  claim: 'CLAUDE.md: a hook that moves the request to another origin does not take the credentials with it.',
  run: async (client, base) => {
    const hooked = client.extend({
      responseType: 'json',
      // A block body, deliberately: got treats a value returned from `beforeRequest` as a
      // response to answer with, so an arrow returning the assignment fails inside got.
      hooks: {
        beforeRequest: [
          (options: {url: unknown}) => {
            options.url = `${otherOrigin(base)}/echo/moved`;
          },
        ],
      },
    });

    const response = await hooked.post(`${base}/echo`, {
      body: 'PAYLOAD',
      headers: {authorization: 'Bearer secret', cookie: 'sid=1'},
    });

    return echoed(response.body);
  },
});

parityTest('a cross-origin hook keeps the authorization and the body it set itself', {
  claim: 'CLAUDE.md: a header the hook rewrote is the credentials for where it is sending the request.',
  run: async (client, base) => {
    const hooked = client.extend({
      responseType: 'json',
      hooks: {
        beforeRequest: [
          (options: {url: unknown; headers: Record<string, string>; body: unknown}) => {
            options.url = `${otherOrigin(base)}/echo/moved`;
            options.headers['authorization'] = 'Bearer fresh';
            options.body = 'NEWBODY';
          },
        ],
      },
    });

    const response = await hooked.post(`${base}/echo`, {
      body: 'PAYLOAD',
      headers: {authorization: 'Bearer secret'},
    });

    return echoed(response.body);
  },
});

/*
 * The same claim, reached by the other way a hook can write headers: assigning a whole new
 * object instead of mutating the one it was given.
 *
 * Every other cross-origin scenario here, and all eight in `index.spec.ts`, mutate in place -
 * so the write-tracking Proxy was always the thing answering "did the hook touch this", and
 * nothing ever exercised the case where a hook throws that Proxy away. It did: the freshly
 * minted credentials for the new origin were stripped as though the hook had never set them,
 * and the request arrived anonymous at a host it had just authenticated to. The mutation *form*
 * is part of the input space, not an implementation detail.
 */
parityTest('a cross-origin hook that replaces the headers object keeps what it put there', {
  claim: 'CLAUDE.md: a header the hook wrote is the credentials for where it is sending the request.',
  run: async (client, base) => {
    const hooked = client.extend({
      responseType: 'json',
      hooks: {
        beforeRequest: [
          (options: {url: unknown; headers: Record<string, string>}) => {
            options.url = `${otherOrigin(base)}/echo/moved`;
            options.headers = {authorization: 'Bearer fresh', 'x-set-by-hook': '1'};
          },
        ],
      },
    });

    const response = await hooked.get(`${base}/echo`, {
      headers: {authorization: 'Bearer secret', cookie: 'session=secret'},
    });

    return echoed(response.body);
  },
});

parityTest('a same-origin hook rewrite keeps everything', {
  claim: 'CLAUDE.md: the common case - a signing hook rewriting the url it was already going to.',
  run: async (client, base) => {
    const hooked = client.extend({
      responseType: 'json',
      hooks: {
        beforeRequest: [
          (options: {url: unknown}) => {
            options.url = `${base}/echo/signed`;
          },
        ],
      },
    });

    const response = await hooked.post(`${base}/echo`, {
      body: 'PAYLOAD',
      headers: {authorization: 'Bearer secret', cookie: 'sid=1'},
    });

    return echoed(response.body);
  },
});

parityTest('an afterResponse retry to another origin drops the credentials and the body', {
  claim: 'CLAUDE.md: the same boundary by the other route - a refresh hook pointing at a new host.',
  run: async (client, base) => {
    let retried = false;

    const hooked = client.extend({
      responseType: 'json',
      throwHttpErrors: false,
      hooks: {
        afterResponse: [
          (response: {statusCode: number}, retry: (options: unknown) => unknown) => {
            if (!retried && response.statusCode === 401) {
              retried = true;

              return retry({url: `${otherOrigin(base)}/echo/moved`});
            }

            return response;
          },
        ],
      },
    });

    const response = await hooked.post(`${base}/status?code=401`, {
      body: 'PAYLOAD',
      headers: {authorization: 'Bearer secret', cookie: 'sid=1'},
    });

    return echoed(response.body);
  },
});

parityTest('a cross-origin retry keeps the authorization and body it set itself', {
  claim: 'CLAUDE.md: anything the retry sets explicitly is kept, because it set it knowing where it goes.',
  run: async (client, base) => {
    let retried = false;

    const hooked = client.extend({
      responseType: 'json',
      throwHttpErrors: false,
      hooks: {
        afterResponse: [
          (response: {statusCode: number}, retry: (options: unknown) => unknown) => {
            if (!retried && response.statusCode === 401) {
              retried = true;

              return retry({
                url: `${otherOrigin(base)}/echo/moved`,
                headers: {authorization: 'Bearer fresh'},
                body: 'NEWBODY',
              });
            }

            return response;
          },
        ],
      },
    });

    const response = await hooked.post(`${base}/status?code=401`, {
      body: 'PAYLOAD',
      headers: {authorization: 'Bearer secret'},
    });

    return echoed(response.body);
  },
});

parityTest('a cross-origin retry that sets only headers still drops the body', {
  claim: 'CLAUDE.md: the body goes unless the retry supplied one, even when the headers were refreshed.',
  run: async (client, base) => {
    let retried = false;

    const hooked = client.extend({
      responseType: 'json',
      throwHttpErrors: false,
      hooks: {
        afterResponse: [
          (response: {statusCode: number}, retry: (options: unknown) => unknown) => {
            if (!retried && response.statusCode === 401) {
              retried = true;

              return retry({
                url: `${otherOrigin(base)}/echo/moved`,
                headers: {authorization: 'Bearer fresh', 'x-trace': 'keep-me'},
              });
            }

            return response;
          },
        ],
      },
    });

    const response = await hooked.post(`${base}/status?code=401`, {
      body: 'PAYLOAD',
      headers: {authorization: 'Bearer secret', 'content-type': 'text/plain'},
    });

    return echoed(response.body);
  },
});

/* ------------------------------------------------------------- FormData bodies */

/*
 * got 15 made the `FormData` global the documented way to send multipart. The boundary is
 * random per request, so the harness rewrites it on both sides - everything else about the
 * encoding is compared byte for byte, here and on the wire.
 */
parityTest('a FormData body is encoded the way got encodes it', {
  claim: 'README: a `FormData` body is encoded as multipart/form-data with its boundary.',
  run: async (client, base) => {
    const form = new FormData();

    form.set('name', 'value');
    form.set('file', new Blob(['hello'], {type: 'text/plain'}), 'f.txt');

    const response = await client.post(`${base}/echo`, {body: form, responseType: 'json'});
    const echo = response.body as EchoBody;

    return {
      contentType: (echo.headers['content-type'] ?? '').replace(/boundary=[-\w]+/, 'boundary=<b>'),
      body: echo.body.replaceAll(/-{2,}[-\w]+/g, '<b>'),
    };
  },
});

/* ------------------------------------------------------------------------------- streams */

/** The stable half of an `/echo` reply: what the request was, not which headers carried it. */
function streamedEcho(body: string): unknown {
  const echo = JSON.parse(body) as EchoBody;

  return {method: echo.method, path: echo.path, body: echo.body};
}

/*
 * The suite had no stream scenarios at all, which is how the largest and most intricate
 * subsystem here - two dispatch paths, error normalisation, duplex writable semantics,
 * release-on-close - went undefended while got has a stream API that makes every bit of it
 * differentially testable. Its bug history says the same: a piped GET that returned the 302
 * instead of following it, a bodyless method routed onto the pipeline path where the request
 * was never sent at all, a mid-body socket reset surfacing undici's raw error.
 *
 * `await` is what lets one body drive both clients - got hands the stream back synchronously,
 * gotlike resolves to it.
 */

parityTest('a streamed GET delivers the same bytes and sends the same request', {
  claim: 'README: `stream()` for a bodyless request resolves to a Readable carrying the response body.',
  run: async (client, base) => {
    const stream = await client.stream(`${base}/echo/streamed`, {headers: {'x-stream': '1'}});

    // The echoed *headers* are compared through the wire record, which filters the four that
    // are allowed to differ; returning the raw body here would compare them a second time
    // without that filter and fail on got's own user-agent.
    return streamedEcho(await text(stream));
  },
});

/*
 * The upload path: `undici.pipeline` makes the duplex's writable half the request body, which
 * is a different mechanism from got's and has to put the same bytes on the wire.
 */
parityTest('a streamed upload sends the body written into it', {
  claim: 'CLAUDE.md: a `bodyMethods` method streams through `undici.pipeline`, whose writable half is the body.',
  run: async (client, base) => {
    const upload = await client.stream.post(`${base}/echo/uploaded`, {
      headers: {'content-type': 'text/plain'},
    });

    // Written across a real gap, which is the case the writable half exists for - and the one
    // where both clients chunk, so everything on the wire is comparable.
    upload.write('chunk-one-');
    await new Promise((resolve) => setTimeout(resolve, 20));
    upload.write('chunk-two-');
    upload.end('chunk-three');

    return streamedEcho(await text(upload));
  },
});

/*
 * The same upload written and ended in one call, which frames differently - and is the only
 * thing the stream scenarios found that the two clients disagree about.
 *
 * got always chunks a stream body. undici can see that this duplex ended with everything it
 * will ever carry, so it sends a `content-length` instead. Nothing here asks for either:
 * gotlike sets no length header, and forcing one framing would mean writing
 * `transfer-encoding` by hand against undici's own decision. It is not a buffering difference
 * - the scenario above writes across a gap and chunks exactly as got does - and it can only
 * arise where the caller had nothing to stream in the first place.
 */
parityTest('a streamed upload written in one call is framed by length rather than chunked', {
  claim: 'CLAUDE.md: `undici.pipeline` takes the request body from the duplex’s writable side.',
  run: async (client, base) => {
    const upload = await client.stream.post(`${base}/echo/one-shot`, {headers: {'content-type': 'text/plain'}});

    upload.end('STREAMED-PAYLOAD');

    const echo = JSON.parse(await text(upload)) as EchoBody;

    return {
      body: echo.body,
      contentLength: echo.headers['content-length'],
      transferEncoding: echo.headers['transfer-encoding'],
    };
  },
  divergence: {
    reason:
      'undici frames a duplex that has already ended with a `content-length`; got always chunks a stream ' +
      'body. Neither client asks for either - it is undici’s framing decision, and overriding it would mean ' +
      'writing `transfer-encoding` by hand against it. Not a buffering difference: an upload written across ' +
      'a gap chunks on both sides (the scenario above), so this only arises when the caller had nothing to ' +
      'stream. Both sides pinned, so a change in either is a failure rather than a surprise.',
    got: {body: 'STREAMED-PAYLOAD', contentLength: undefined, transferEncoding: 'chunked'},
    gotlike: {body: 'STREAMED-PAYLOAD', contentLength: '16', transferEncoding: undefined},
  },
});

/*
 * A download through a redirecting CDN. This is the case that used to hand back the 302 itself
 * with an empty body - an empty file and no error - because the piped request had a body
 * `RedirectHandler` could not replay.
 */
parityTest('a streamed GET follows a redirect to the body it points at', {
  claim: 'CLAUDE.md: requests with no body to replay go through `undici.request`, where redirects work normally.',
  run: async (client, base) => {
    const following = client.extend({followRedirect: true});
    const stream = await following.stream(`${base}/redirect?to=/echo/after-redirect`);

    return streamedEcho(await text(stream));
  },
});

/*
 * A failing status on a stream. got raises it on the stream; so does gotlike, through
 * `toRequestError`, which is what runs the `beforeError` hooks and attaches the response - a
 * bare `new HTTPError(...)` skipped both. The two disagree on the error's own shape, so only
 * the part a caller acts on is compared: that it failed, and on which status.
 */
parityTest('a streamed request with a failing status raises on the stream', {
  claim: 'CLAUDE.md: `throwHttpErrors` on a stream is raised by the readable at read time, on both stream paths.',
  run: async (client, base) => {
    const stream = await client.stream(`${base}/status?code=503`);

    try {
      await text(stream);

      return {outcome: 'resolved'};
    } catch (error) {
      return {outcome: 'rejected', status: (error as {response?: {statusCode?: number}}).response?.statusCode};
    }
  },
});

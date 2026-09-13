import {propertyTest, setupParityServer, type Rng} from './harness.ts';

setupParityServer();

/*
 * Property-based differential tests.
 *
 * The hand-written scenarios in `parity.spec.ts` pin the claims someone thought to write down.
 * These explore the space around them. The targets are chosen from where this repo's bugs
 * actually lived: url joining, query merging and header folding - each of whose failures was a
 * particular character in a particular position that nobody had tried.
 *
 * Inputs are drawn from a fixed seed, so a red build is reproducible. `PARITY_SEED=<n>` explores
 * further; a seed that finds something is worth writing into a scenario of its own.
 */

/** Characters that have caused trouble here before, plus enough ordinary ones to dilute them. */
const pathChars = 'abcXYZ019-._~';
const spicyPathChars = "abc019 %+&=:@,;'()!$*";
const queryKeyChars = 'abcXYZ019_-';
const queryValueChars = "abc019 %+&=/:@.,~!*'()";

function segment(rng: Rng): string {
  const alphabet = rng.bool() ? pathChars : spicyPathChars;

  return rng.string(alphabet, 1 + rng.int(6));
}

function path(rng: Rng): string {
  return Array.from({length: 1 + rng.int(3)}, () => segment(rng)).join('/');
}

function query(rng: Rng, size: number): Record<string, string> {
  const entries: Record<string, string> = {};

  for (let i = 0; i < size; i++) {
    entries[rng.string(queryKeyChars, 1 + rng.int(5))] = rng.string(queryValueChars, rng.int(7));
  }

  return entries;
}

/*
 * `resolveUrl` joins by string rather than through `URL`, which is what makes it fast and what
 * made it wrong three separate times - a fragment hiding the query, a doubled slash, a prefix
 * carrying a `?`. Whatever it produces has to be the path got produces.
 */
propertyTest('a prefixUrl and a relative path join the way got joins them', {
  claim: 'CLAUDE.md: `resolveUrl` joins `prefixUrl` without doubling slashes.',
  cases: 60,
  generate: (rng) => ({
    // Both spellings of the prefix, so the join has to cope with a trailing slash on one side
    // and with neither side having one. A *leading* slash on the relative path is left out
    // deliberately: got rejects that combination outright, and the divergence is pinned as its
    // own scenario in `parity.spec.ts` rather than explored here.
    prefixSlash: rng.bool(),
    path: path(rng),
  }),
  run: async (client, base, input) => {
    const scoped = client.extend({
      prefixUrl: input.prefixSlash ? `${base}/` : base,
      responseType: 'json',
    });

    const response = await scoped.get(input.path);

    return (response.body as {path: string}).path;
  },
});

/*
 * The merge got does is specific: a key the override names replaces *every* occurrence of that
 * key and moves to the end, one it doesn't name is kept in place. `mergeSearchParams` reproduces
 * that by walking the override rather than round-tripping through a string, so the two can
 * disagree on ordering as easily as on content.
 */
propertyTest('a client searchParams and a per-call one merge the way got merges them', {
  claim: 'CLAUDE.md: measured against got 16, including the ordering - a replaced key moves to the end.',
  cases: 60,
  generate: (rng) => {
    const base = query(rng, 1 + rng.int(3));
    const keys = Object.keys(base);
    const override = query(rng, rng.int(3));

    // Roughly half the cases reuse one of the client's own keys, so the replace-and-move rule is
    // exercised rather than only the append one.
    if (keys.length > 0 && rng.bool()) {
      override[rng.pick(keys)] = rng.string(queryValueChars, rng.int(5));
    }

    return {base, override};
  },
  run: async (client, base, input) => {
    const scoped = client.extend({prefixUrl: base, responseType: 'json', searchParams: input.base});
    const response = await scoped.get('echo', {searchParams: input.override});

    return (response.body as {path: string}).path;
  },
});

/*
 * Header names fold to lower case at every merge point, so a per-call `Authorization` replaces an
 * instance `authorization` rather than joining it. Generated casing is the point: the bug was
 * that merging by exact key kept both, and which one the server saw depended on the spelling.
 */
propertyTest('per-call headers override the client’s regardless of case', {
  claim: 'CLAUDE.md: header names are folded to lower case at every merge point.',
  cases: 50,
  generate: (rng) => {
    const recase = (name: string) =>
      name
        .split('')
        .map((character) => (rng.bool() ? character.toUpperCase() : character.toLowerCase()))
        .join('');

    const name = rng.pick(['authorization', 'x-api-key', 'accept-language', 'x-request-id']);

    return {
      clientName: recase(name),
      callName: recase(name),
      clientValue: rng.string('abc019', 1 + rng.int(6)),
      callValue: rng.string('abc019', 1 + rng.int(6)),
    };
  },
  run: async (client, base, input) => {
    const scoped = client.extend({
      prefixUrl: base,
      responseType: 'json',
      headers: {[input.clientName]: input.clientValue},
    });

    const response = await scoped.get('echo', {headers: {[input.callName]: input.callValue}});
    const headers = (response.body as {headers: Record<string, unknown>}).headers;

    return headers[input.callName.toLowerCase()];
  },
});

/*
 * `json` and `form` are serialised by gotlike rather than by undici, and each sets a content-type
 * only when none is present. Generated values check the encoding itself, not just the labelling:
 * a form value containing `&`, `=` or a space is where a hand-rolled encoder diverges.
 */
propertyTest('a form body is encoded the way got encodes it', {
  claim: 'CLAUDE.md: `form` sets a Content-Type unless one is already present.',
  cases: 40,
  generate: (rng) => query(rng, 1 + rng.int(4)),
  run: async (client, base, input) => {
    const response = await client.post(`${base}/echo`, {form: input, responseType: 'json'});
    const echoed = response.body as {body: string; headers: Record<string, string>};

    return {body: echoed.body, contentType: echoed.headers['content-type']};
  },
});

propertyTest('a json body is serialised the way got serialises it', {
  claim: 'CLAUDE.md: `json` sets a Content-Type unless one is already present.',
  cases: 40,
  generate: (rng) => query(rng, 1 + rng.int(4)),
  run: async (client, base, input) => {
    const response = await client.post(`${base}/echo`, {json: input, responseType: 'json'});
    const echoed = response.body as {body: string; headers: Record<string, string>};

    return {body: echoed.body, contentType: echoed.headers['content-type']};
  },
});

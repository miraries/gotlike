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

/**
 * The same, plus the three characters that decide whether a query survives the trip.
 *
 * `#` ends the query and starts a fragment, which is never sent; `;` and `+` are ordinary
 * characters in a value that several encoders disagree about. None of them were in the alphabet
 * above, which is half of why a string `searchParams` went unencoded onto the url for so long -
 * the generator could name the bug's subsystem but never its input.
 */
const fragileQueryValueChars = "abc019 %+&=/:@.,~!*'()#;?";

function segment(rng: Rng): string {
  const alphabet = rng.bool() ? pathChars : spicyPathChars;

  return rng.string(alphabet, 1 + rng.int(6));
}

function path(rng: Rng): string {
  return Array.from({length: 1 + rng.int(3)}, () => segment(rng)).join('/');
}

/**
 * A single query value, in every *scalar* shape the option accepts.
 *
 * A string was the only one reachable for a long time, and a value's shape is the blind spot
 * that has caught this suite out twice already (see `nullableQuery`). `number` and `boolean` are
 * declared on `QueryValue` and are serialised by `queryValue`'s `String(value)` rather than by
 * anything string-specific, so they are exactly the kind of thing that can diverge quietly.
 *
 * An **array** is deliberately not here, and is pinned as its own scenario in `parity.spec.ts`
 * instead: got rejects an array `searchParams` value outright and stringifies an array `form`
 * value to `a=1%2C2`, so a generated case carrying one could only ever be a divergence - and a
 * generator that produces divergences stops being able to find them.
 */
function scalar(rng: Rng): string | number | boolean {
  const roll = rng.int(6);

  if (roll === 0) {
    return rng.int(1000);
  }

  if (roll === 1) {
    return rng.bool();
  }

  return rng.string(queryValueChars, rng.int(7));
}

function query(rng: Rng, size: number): Record<string, string | number | boolean> {
  const entries: Record<string, string | number | boolean> = {};

  for (let i = 0; i < size; i++) {
    entries[rng.string(queryKeyChars, 1 + rng.int(5))] = scalar(rng);
  }

  return entries;
}

/**
 * The same, but values may also be `null` or `undefined`.
 *
 * Those two are not one value, and treating them as one dropped a parameter off the wire:
 * `{a: null}` went out as no `a` at all where got sends `a=`. The generator above could not
 * reach it - it only ever built a `Record<string, string>` - which is the blind spot CLAUDE.md
 * already describes for the *shape* of `searchParams`, arriving here as the shape of a value.
 * When a bug turns out to be "nobody passed it that way", widen the generator.
 *
 * `searchParams` only. `form` shares the serialiser but diverges from got on exactly these two
 * values by design, and that is pinned as its own scenario rather than explored here.
 */
function nullableQuery(rng: Rng, size: number): Record<string, string | number | boolean | null | undefined> {
  const entries: Record<string, string | number | boolean | null | undefined> = {};

  for (let i = 0; i < size; i++) {
    const key = rng.string(queryKeyChars, 1 + rng.int(5));
    const roll = rng.int(5);

    // Weighted towards ordinary values, so the nullish ones are the exception they are in real
    // call sites rather than most of the sample.
    entries[key] = roll === 0 ? null : roll === 1 ? undefined : scalar(rng);
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
    // Nullable on both sides: a `null` has to survive the merge as an empty value and an
    // `undefined` has to drop the base's key rather than replace it with the text "undefined".
    const base = nullableQuery(rng, 1 + rng.int(3));
    const keys = Object.keys(base);
    const override = nullableQuery(rng, rng.int(3));

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
 * `searchParams` takes three shapes - a string, a `URLSearchParams` and a plain object - and each
 * one reaches the wire by a different route through `stringifyQuery`. The suite explored only the
 * object, so the string branch was never compared against got at all: it was concatenated onto
 * the url exactly as written, and the first `#` in it opened a fragment that took every parameter
 * after it off the wire, silently. `resolveUrl` also has to reconcile a query the *url* already
 * carries, so that is generated too.
 *
 * Whatever shape the caller uses, the same pairs must reach the server the same way.
 */
propertyTest('searchParams reaches the wire the same way whatever shape it is given in', {
  claim: 'CLAUDE.md: `searchParams` replaces the url’s own query; a string is re-encoded, not concatenated.',
  cases: 90,
  generate: (rng) => ({
    shape: rng.pick(['string', 'params', 'object'] as const),
    // Unique keys, so all three shapes can represent the same pairs faithfully - an object
    // cannot hold a repeated key, and the point here is the shape rather than repetition.
    pairs: Array.from({length: 1 + rng.int(3)}, (_, index) => [
      `${rng.string(queryKeyChars, 1 + rng.int(4))}${index}`,
      rng.string(fragileQueryValueChars, rng.int(6)),
    ]),
    // Half the cases put a query on the url as well, which `searchParams` has to replace.
    urlQuery: rng.bool(),
  }),
  run: async (client, base, input) => {
    // Built inside `run`, never in `generate`: a `URLSearchParams` is mutable, and one shared
    // across both clients would let the first run alter what the second is given.
    const asString = input.pairs.map(([key, value]) => `${key}=${value}`).join('&');
    const searchParams =
      input.shape === 'string'
        ? asString
        : input.shape === 'params'
          ? new URLSearchParams(asString)
          : Object.fromEntries(new URLSearchParams(asString));

    const scoped = client.extend({prefixUrl: base, responseType: 'json'});
    const response = await scoped.get(input.urlQuery ? 'echo?carried=1' : 'echo', {searchParams});

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

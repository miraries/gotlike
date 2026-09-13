import test from 'node:test';
import assert from 'node:assert';
import realGot from 'got';
import gotlike from '../index.ts';
import {startParityServer, type ParityServer, type WireRecord} from './server.ts';

/**
 * The slice of the two clients that scenarios are written against. Both `got` and `gotlike`
 * satisfy it structurally; it exists so a scenario is written once and run twice, and so a
 * signature that quietly stops matching got's is a compile error rather than a silent skip.
 */
export type ParityClient = {
  (url: string, options?: Record<string, unknown>): Promise<AnyResponse>;
  get: (url: string, options?: Record<string, unknown>) => Promise<AnyResponse>;
  post: (url: string, options?: Record<string, unknown>) => Promise<AnyResponse>;
  put: (url: string, options?: Record<string, unknown>) => Promise<AnyResponse>;
  delete: (url: string, options?: Record<string, unknown>) => Promise<AnyResponse>;
  head: (url: string, options?: Record<string, unknown>) => Promise<AnyResponse>;
  extend: (options: Record<string, unknown>) => ParityClient;
};

export type AnyResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  url: string | URL;
  retryCount?: number;
};

/**
 * Request headers that are expected to differ, each with the reason it is allowed to.
 *
 * This map is the point of the whole suite: it is the complete, machine-checked inventory of
 * where gotlike diverges from got on the wire. Anything *not* listed here must match exactly.
 * Adding an entry is a deliberate act - if a change starts a new header diverging, the suite
 * fails until someone writes down why that is acceptable.
 */
export const DIVERGENT_REQUEST_HEADERS: Record<string, string> = {
  'user-agent': 'got identifies itself; gotlike sends whatever undici defaults to. Cosmetic.',
  'accept-encoding':
    'gotlike advertises exactly what this runtime’s zlib can decode (see `acceptEncoding`), ' +
    'got hardcodes its own list. Deliberate - a hardcoded header can advertise an encoding node 22.12 cannot decode.',
  connection: 'node:http and undici negotiate keep-alive independently of the client wrapper.',
  host: 'carries the ephemeral port the server bound to; identical in practice, excluded for stability.',
};

/**
 * Response fields that are never comparable between two separate requests.
 */
const VOLATILE_RESPONSE_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']);

/**
 * The options both clients are pinned to before a scenario runs.
 *
 * got and gotlike ship different defaults on purpose (gotlike follows no redirects and retries
 * not at all, both documented), so without a stated baseline every scenario would measure the
 * default gap rather than the behaviour it names. A scenario that is *about* one of these
 * overrides it explicitly on both sides.
 */
const BASELINE = {retry: {limit: 0}, followRedirect: false} as const;

let server: ParityServer | undefined;

/** Registers the shared server's lifecycle. Call once per spec file. */
export function setupParityServer(): () => ParityServer {
  test.before(async () => {
    server = await startParityServer();
  });

  test.after(async () => {
    await server?.close();
    server = undefined;
  });

  return () => {
    assert.ok(server, 'the parity server is not running');

    return server;
  };
}

/**
 * A multipart boundary is random per request by design, so two clients can never put the same
 * bytes on the wire for one `FormData`. Both the `content-type` and the body are rewritten to a
 * fixed marker, which leaves everything else about the encoding - part order, part headers,
 * filenames, the trailing `--` - compared exactly. Only applied to a multipart request, so an
 * ordinary body containing dashes is untouched.
 */
const boundaryInHeader = /boundary=[-\w]+/;
const boundaryInBody = /-{2,}[-\w]+/g;

function normaliseWire(record: WireRecord): unknown {
  const headers: Record<string, unknown> = {};
  const multipart = String(record.headers['content-type'] ?? '').startsWith('multipart/');

  for (const [name, value] of Object.entries(record.headers)) {
    if (name in DIVERGENT_REQUEST_HEADERS) {
      continue;
    }

    headers[name] =
      multipart && name === 'content-type' ? String(value).replace(boundaryInHeader, 'boundary=<b>') : value;
  }

  const body = multipart ? record.body.replace(boundaryInBody, '<b>') : record.body;

  return {method: record.method, path: record.path, headers, body};
}

/**
 * What a scenario compares by default. `body` and `statusCode` are the caller-visible result;
 * volatile response headers are dropped because they describe the connection rather than the
 * client.
 */
export function summarise(response: AnyResponse): unknown {
  const headers: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(response.headers)) {
    if (!VOLATILE_RESPONSE_HEADERS.has(name)) {
      headers[name] = value;
    }
  }

  return {
    statusCode: response.statusCode,
    body: response.body,
    headers,
    url: String(response.url),
    retryCount: response.retryCount ?? 0,
  };
}

/**
 * Run something expected to fail and describe the failure in the terms a caller matches on.
 *
 * `name` and `code` are asserted because the README documents both; `message` is included
 * because `messageOf` exists specifically to make the underlying message survive, and that
 * claim is worth failing on.
 */
export async function capture(run: () => Promise<unknown>, base?: string): Promise<unknown> {
  const redact = (text: string) => (base ? text.split(base).join('<base>') : text);

  try {
    const value = await run();

    return {outcome: 'resolved', value};
  } catch (error) {
    const failure = error as Error & {code?: string; response?: {statusCode?: number; body?: unknown}};

    return {
      outcome: 'rejected',
      name: failure.name,
      code: failure.code,
      message: redact(failure.message),
      responseStatus: failure.response?.statusCode,
      responseBody: failure.response?.body,
    };
  }
}

export type Scenario = {
  /**
   * The claim this pins down, in the words of CLAUDE.md or the README. A scenario with no
   * claim is a scenario nobody can tell is still meaningful.
   */
  claim: string;
  /** Run against one client. Whatever is returned is deep-compared across the two. */
  run: (client: ParityClient, base: string) => Promise<unknown>;
  /**
   * A divergence that is intended.
   *
   * Declaring one does not weaken the test - it strengthens it. Instead of comparing the two
   * clients against each other, each is compared against the value recorded here, so the
   * suite fails if *either* side changes: if gotlike drifts, and equally if a got upgrade
   * changes what it does. A `skip` would have caught neither.
   */
  divergence?: {reason: string; got: unknown; gotlike: unknown};
};

/** Every divergence the suite has pinned, filled in as the scenarios run. */
const inventory: {name: string; reason: string}[] = [];

/**
 * Register a differential test: the scenario is run against real got 16 and against gotlike,
 * and both the value it returns and everything that reached the server must match.
 */
export function parityTest(name: string, scenario: Scenario): void {
  test(name, async () => {
    assert.ok(server, 'the parity server is not running');

    /*
     * Both clients are reached through the same structural type, which is what lets one
     * scenario body run twice. The assertions are at the boundary and nowhere else.
     */
    const clients: [string, ParityClient][] = [
      ['got', (realGot as unknown as ParityClient).extend(BASELINE)],
      ['gotlike', (gotlike as unknown as ParityClient).extend(BASELINE)],
    ];

    const observations: Record<string, unknown> = {};

    for (const [label, client] of clients) {
      server.reset();

      let returned: unknown;

      try {
        returned = await scenario.run(client, server.base);
      } catch (error) {
        returned = {threw: (error as Error).message};
      }

      observations[label] = {returned, wire: server.wire.map(normaliseWire)};
    }

    if (scenario.divergence) {
      const {reason, got, gotlike: mine} = scenario.divergence;

      inventory.push({name, reason});

      assert.deepStrictEqual(
        (observations['got'] as {returned: unknown}).returned,
        got,
        `${name}\n\ngot 16 no longer produces the value this divergence was recorded against. ` +
          'The recorded behaviour is stale - re-measure it before trusting the note.',
      );

      assert.deepStrictEqual(
        (observations['gotlike'] as {returned: unknown}).returned,
        mine,
        `${name}\n\ngotlike no longer produces the value recorded for it.\n\nintended divergence: ${reason}`,
      );

      return;
    }

    assert.deepStrictEqual(
      observations['gotlike'],
      observations['got'],
      `${name}\n\nclaim: ${scenario.claim}\n\n` +
        'gotlike and got 16 disagree. Either the claim is no longer true, or the divergence ' +
        'is intended - in which case record it as `divergence` on the scenario (or, for a ' +
        'header, in DIVERGENT_REQUEST_HEADERS) so both sides stay pinned.',
    );
  });
}

/**
 * Print the inventory once the suite has run.
 *
 * This is the artefact worth keeping: a list of every place gotlike knowingly differs from
 * got, produced by running both rather than by remembering.
 */
export function reportDivergences(): void {
  test.after(() => {
    const headers = Object.entries(DIVERGENT_REQUEST_HEADERS);

    console.log('\n  gotlike vs got 16 - recorded divergences\n');
    console.log(`  request headers (${headers.length}):`);

    for (const [header, reason] of headers) {
      console.log(`    ${header}: ${reason}`);
    }

    console.log(`\n  behaviours (${inventory.length}):`);

    for (const {name, reason} of inventory) {
      console.log(`    ${name}\n      ${reason}`);
    }

    console.log('');
  });
}

/* ------------------------------------------------------------------- property-based cases */

/** A seeded generator, so a failing case can be reproduced exactly rather than described. */
export type Rng = {
  int: (maxExclusive: number) => number;
  bool: () => boolean;
  pick: <T>(values: readonly T[]) => T;
  /** A string of `length` characters drawn from `alphabet`. */
  string: (alphabet: string, length: number) => string;
};

/** mulberry32 - small, fast, and good enough to explore an input space. */
function makeRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number) => Math.floor(next() * maxExclusive);

  return {
    int,
    bool: () => next() < 0.5,
    pick: (values) => values[int(values.length)]!,
    string: (alphabet, length) => Array.from({length}, () => alphabet[int(alphabet.length)]).join(''),
  };
}

/**
 * The seed the generators start from.
 *
 * Fixed by default, so CI runs the same cases every time and a red build is reproducible -
 * a suite that generates fresh inputs per run fails on one machine and passes on the next,
 * which is worse than not running at all. Set `PARITY_SEED` to explore further; a seed that
 * finds something is the thing to write down.
 */
const seed = Number(process.env['PARITY_SEED'] ?? 20260913);

export type PropertySpec<I> = {
  /** The claim this explores, in the words of CLAUDE.md or the README. */
  claim: string;
  /** How many generated cases to run. */
  cases?: number;
  /** Build one input. Must depend only on `rng`, so the seed reproduces it. */
  generate: (rng: Rng) => I;
  /** Run one input against one client. Whatever is returned is compared across the two. */
  run: (client: ParityClient, base: string, input: I) => Promise<unknown>;
};

/**
 * Run a scenario over generated inputs rather than one hand-written case.
 *
 * The hand-written scenarios pin the claims someone thought to write down. These explore the
 * space around them, which is where the url-resolution and query-merging bugs in this repo's
 * history actually lived - each of them a specific character in a specific position that no
 * one had thought to try.
 */
export function propertyTest<I>(name: string, spec: PropertySpec<I>): void {
  test(name, async () => {
    assert.ok(server, 'the parity server is not running');

    const rng = makeRng(seed);
    const cases = spec.cases ?? 40;

    const clients: [string, ParityClient][] = [
      ['got', (realGot as unknown as ParityClient).extend(BASELINE)],
      ['gotlike', (gotlike as unknown as ParityClient).extend(BASELINE)],
    ];

    for (let i = 0; i < cases; i++) {
      const input = spec.generate(rng);
      const observations: Record<string, unknown> = {};

      for (const [label, client] of clients) {
        server.reset();

        let returned: unknown;

        try {
          returned = await spec.run(client, server.base, input);
        } catch (error) {
          returned = {threw: (error as Error).message};
        }

        observations[label] = {returned, wire: server.wire.map(normaliseWire)};
      }

      assert.deepStrictEqual(
        observations['gotlike'],
        observations['got'],
        `${name}\n\nclaim: ${spec.claim}\n\n` +
          `failing input (seed ${seed}, case ${i}):\n${JSON.stringify(input, undefined, 2)}\n\n` +
          'gotlike and got 16 disagree on a generated input. Reproduce with ' +
          `PARITY_SEED=${seed} and look at case ${i}.`,
      );
    }
  });
}

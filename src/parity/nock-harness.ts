import test from 'node:test';
import assert from 'node:assert';
import realNock from 'nock';
import realGot from 'got';
import gotlike from '../index.ts';
import shimNock from '../nock.ts';
import type {ParityClient} from './harness.ts';

/**
 * The slice of nock's surface a scenario registers through. Both real nock and the shim satisfy
 * it structurally, which is what lets one scenario be registered twice.
 */
export type NockLike = (origin: string | RegExp | URL) => NockScopeLike;

export type NockScopeLike = {
  get: (path: unknown, body?: unknown, options?: unknown) => NockInterceptorLike;
  post: (path: unknown, body?: unknown, options?: unknown) => NockInterceptorLike;
  put: (path: unknown, body?: unknown, options?: unknown) => NockInterceptorLike;
  delete: (path: unknown, body?: unknown, options?: unknown) => NockInterceptorLike;
  /** On the scope in both, which is the portable spelling. */
  persist: () => NockScopeLike;
  isDone: () => boolean;
};

/**
 * `reply` takes `unknown[]`: nock's own overloads and the shim's differ in ways a shared type
 * cannot express, and pinning it tighter here would reject the very spellings the suite exists
 * to compare. The scenarios are the thing being type-checked, not this.
 */
export type NockInterceptorLike = {
  reply: (...args: unknown[]) => NockScopeLike;
  query: (matcher: unknown) => NockInterceptorLike;
  times: (n: number) => NockInterceptorLike;
  /** Present on the shim's interceptor and not on nock's - see the pinned divergence. */
  persist?: () => NockInterceptorLike;
};

/**
 * What a mocking shim is actually being asked: did this interceptor match this request, and what
 * did it answer?
 *
 * Deliberately not the error - real nock reports a miss as a `NetConnectNotAllowedError` through
 * node's http stack and the shim reports undici's `MockNotMatchedError`, which says nothing about
 * whether the two agree on *matching*. Collapsing every failure to `matched: false` is what makes
 * the comparison about the thing under test.
 */
export async function captureMatch(run: () => Promise<{statusCode: number; body: unknown}>): Promise<unknown> {
  try {
    const response = await run();

    return {matched: true, statusCode: response.statusCode, body: response.body};
  } catch {
    return {matched: false};
  }
}

export type NockScenario = {
  /** The claim this pins, in the words of CLAUDE.md or the README. */
  claim: string;
  /** Register interceptors. Runs once per implementation, against a clean slate. */
  register: (nock: NockLike, origin: string) => void;
  /** Drive the registered mocks and return whatever should be identical across the two. */
  run: (client: ParityClient, origin: string) => Promise<unknown>;
  /** An intended difference, recorded as the exact value each side produces. */
  divergence?: {reason: string; nock: unknown; shim: unknown};
};

const inventory: {name: string; reason: string}[] = [];

/**
 * Every scenario gets its own origin, because neither implementation fully forgets an origin it
 * has seen: undici keeps a `MockClient` per origin behind a private symbol, and real nock keeps
 * its own interceptor bookkeeping. Sharing one host across scenarios makes them order-dependent.
 */
let originCounter = 0;

export function setupNockParity(): void {
  test.before(() => {
    realNock.disableNetConnect();
    shimNock.disableNetConnect();
  });

  test.after(() => {
    realNock.cleanAll();
    realNock.enableNetConnect();
    shimNock.cleanAll();
    shimNock.enableNetConnect();
  });
}

export function nockParityTest(name: string, scenario: NockScenario): void {
  test(name, async () => {
    const origin = `http://scope-${originCounter++}.test`;

    /*
     * Both nocks go through `unknown`. `NockLike` widens the path/body parameters to `unknown` so
     * one scenario can be written against either, and a parameter type cannot be widened by
     * assignment - so the step is required however unnecessary it looks from one side.
     */
    /* oxlint-disable typescript/no-unnecessary-type-assertion */
    const implementations: [string, NockLike, ParityClient][] = [
      ['nock', realNock as unknown as NockLike, realGot as unknown as ParityClient],
      ['shim', shimNock as unknown as NockLike, gotlike as unknown as ParityClient],
    ];
    /* oxlint-enable typescript/no-unnecessary-type-assertion */

    const observations: Record<string, unknown> = {};

    for (const [label, nock, client] of implementations) {
      let returned: unknown;

      /*
       * Registration is inside the try as well as the dispatch: how a mock is *written* is part
       * of the surface being compared, and the two do not accept exactly the same spellings -
       * `persist()` on an interceptor is a TypeError in nock and fine here. A scenario that
       * differs at registration is a divergence like any other, not a crashed test.
       */
      try {
        scenario.register(nock, origin);

        returned = await scenario.run(client, origin);
      } catch (error) {
        returned = {threw: (error as Error).message};
      }

      observations[label] = returned;
    }

    realNock.cleanAll();
    shimNock.cleanAll();

    if (scenario.divergence) {
      const {reason, nock: theirs, shim: ours} = scenario.divergence;

      inventory.push({name, reason});

      assert.deepStrictEqual(
        observations['nock'],
        theirs,
        `${name}\n\nreal nock no longer produces the value this divergence was recorded against.`,
      );

      assert.deepStrictEqual(
        observations['shim'],
        ours,
        `${name}\n\nthe shim no longer produces the value recorded for it.\n\nintended: ${reason}`,
      );

      return;
    }

    assert.deepStrictEqual(
      observations['shim'],
      observations['nock'],
      `${name}\n\nclaim: ${scenario.claim}\n\n` +
        'the shim and real nock 14 disagree. Either the claim is no longer true, or the ' +
        'divergence is intended - in which case record it as `divergence` on the scenario.',
    );
  });
}

export function reportNockDivergences(): void {
  test.after(() => {
    console.log(`\n  gotlike/nock vs nock 14 - recorded divergences (${inventory.length}):\n`);

    for (const {name, reason} of inventory) {
      console.log(`    ${name}\n      ${reason}`);
    }

    console.log('');
  });
}

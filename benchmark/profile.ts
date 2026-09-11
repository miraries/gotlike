import {Session} from 'node:inspector/promises';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Agent, setGlobalDispatcher} from 'undici';
import {Gotlike} from '../dist/index.js';
import {startServer, profile10Payload} from './server.ts';

/**
 * Captures a V8 CPU profile of gotlike's own hot path, isolated from actual network I/O by
 * running against `server.ts`'s raw-socket loopback server: the sampling profiler only
 * attributes time to frames that are actually on the stack, so time spent blocked on a real
 * socket read/write shows up as idle rather than inflating any function's self time. What's
 * left in the samples is genuinely CPU-bound work - gotlike's own code, undici's, and V8/Node
 * internals (JSON, buffers, GC) - which is what `analyze-profile.ts` breaks down.
 *
 * Two scenarios, since they're the two shapes that matter for the aggregator: a GET whose
 * response is a ~10-property JSON object, and a POST that sends and receives one. Each gets
 * its own .cpuprofile so the breakdown doesn't mix serialisation-only cost into parse-only
 * cost.
 *
 * Usage: `npm run profile` (builds dist/ first). Env knobs: PROFILE_DURATION (ms per
 * scenario, default 4000), PROFILE_WARMUP (ms, unprofiled, default 500), PROFILE_CONCURRENCY
 * (in-flight requests, default 20), PROFILE_INTERVAL (sampling interval in microseconds,
 * default 50 - finer than the CPU profiler's own 1000us default, since most of what's being
 * measured here is sub-microsecond function calls and a coarse interval would just alias them
 * into whatever frame happens to be on top).
 */

const DURATION_MS = Number(process.env.PROFILE_DURATION ?? 4000);
const WARMUP_MS = Number(process.env.PROFILE_WARMUP ?? 500);
const CONCURRENCY = Number(process.env.PROFILE_CONCURRENCY ?? 20);
const SAMPLING_INTERVAL_US = Number(process.env.PROFILE_INTERVAL ?? 50);

const outDir = path.dirname(fileURLToPath(import.meta.url));

type Scenario = {
  name: string;
  run: (base: string) => Promise<unknown>;
};

async function drive(
  run: (base: string) => Promise<unknown>,
  base: string,
  durationMs: number,
  concurrency: number,
): Promise<{count: number; errors: number}> {
  const deadline = Date.now() + durationMs;
  let count = 0;
  let errors = 0;

  const worker = async () => {
    while (Date.now() < deadline) {
      try {
        await run(base);
        count++;
      } catch {
        errors++;
      }
    }
  };

  await Promise.all(Array.from({length: concurrency}, worker));

  return {count, errors};
}

async function profileScenario(session: Session, scenario: Scenario, base: string): Promise<void> {
  // Unprofiled, so JIT warmup (and the first connections opening) doesn't get counted as
  // steady-state per-request cost.
  await drive(scenario.run, base, WARMUP_MS, CONCURRENCY);

  await session.post('Profiler.start');
  const startedAt = Date.now();

  const {count, errors} = await drive(scenario.run, base, DURATION_MS, CONCURRENCY);

  const elapsedMs = Date.now() - startedAt;
  const {profile} = await session.post('Profiler.stop');

  const file = path.join(outDir, `${scenario.name}.cpuprofile`);

  await writeFile(file, JSON.stringify(profile));

  const opsPerSec = (count / elapsedMs) * 1000;

  console.log(
    `${scenario.name.padEnd(10)} ${count.toLocaleString().padStart(9)} calls  ` +
      `${opsPerSec.toFixed(0).padStart(7)} ops/s  ${errors ? `${errors} errors  ` : ''}-> ${file}`,
  );
}

async function main() {
  const agent = new Agent({connections: CONCURRENCY, pipelining: 1});

  setGlobalDispatcher(agent);

  const {url, close} = await startServer();

  const gotlike = new Gotlike({
    responseType: 'json',
    method: 'GET',
    headers: {},
    throwHttpErrors: true,
    followRedirect: false,
    decompress: false,
  });

  const scenarios: Scenario[] = [
    {name: 'get-json', run: (base) => gotlike.get(base + '/profile10')},
    {name: 'post-json', run: (base) => gotlike.post(base + '/profile10', {json: profile10Payload})},
  ];

  const session = new Session();

  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', {interval: SAMPLING_INTERVAL_US});

  console.log(
    `node ${process.version} | ${DURATION_MS}ms/scenario, ${WARMUP_MS}ms warmup, ` +
      `concurrency ${CONCURRENCY}, sampling interval ${SAMPLING_INTERVAL_US}us\n`,
  );

  for (const scenario of scenarios) {
    await profileScenario(session, scenario, url);
  }

  await session.post('Profiler.disable');
  session.disconnect();

  await close();
  await agent.close();

  console.log(`\nAnalyze with: node analyze-profile.ts ${scenarios.map((s) => `${s.name}.cpuprofile`).join(' ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

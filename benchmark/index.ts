import {Agent, request as undiciRequest, setGlobalDispatcher} from 'undici';
import got from 'got';
import {Gotlike} from '../dist/index.js';
import {startServer} from './server.ts';

/**
 * Every client gets the same connection pool settings, so what's being compared is the
 * per-request work each one does rather than how many sockets it happens to open.
 */
const CONNECTIONS = 128;

const agent = new Agent({connections: CONNECTIONS, pipelining: 1});

setGlobalDispatcher(agent);

const DURATION_MS = Number(process.env.BENCH_DURATION ?? 1000);
const WARMUP_MS = Number(process.env.BENCH_WARMUP ?? 300);

/**
 * Whichever client runs first in a round measures noticeably faster - warm sockets, a cold
 * JIT for everyone after it. A single pass showed a ~25% swing purely from position, which
 * is larger than most of the differences worth reporting. So: several rounds, rotating who
 * goes first, and each client scored on its *median* round - best-of just trades position
 * bias for whichever client got the luckiest single round.
 */
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);

type Scenario = {
  name: string;
  /** Skipped for clients that don't implement it. */
  run: Record<string, ((url: string) => Promise<unknown>) | undefined>;
};

type Result = {
  client: string;
  opsPerSec: number;
  p50: number;
  p90: number;
  p99: number;
  errors: number;
};

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) {
    return NaN;
  }

  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return sorted[index];
}

/**
 * Keeps `concurrency` requests in flight for the duration, recording each one's latency.
 * A fixed iteration count would let a slow client dominate the wall clock, so this measures
 * how much each client gets through in the same amount of time instead.
 */
async function measure(
  run: (url: string) => Promise<unknown>,
  url: string,
  concurrency: number,
): Promise<{latencies: Float64Array; elapsedMs: number; errors: number}> {
  const latencies: number[] = [];
  let errors = 0;
  let stop = false;

  const worker = async () => {
    while (!stop) {
      const started = process.hrtime.bigint();

      try {
        await run(url);
        latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
      } catch {
        errors++;
      }
    }
  };

  const startedAt = process.hrtime.bigint();
  const timer = setTimeout(() => {
    stop = true;
  }, DURATION_MS);

  await Promise.all(Array.from({length: concurrency}, worker));

  clearTimeout(timer);

  return {
    latencies: Float64Array.from(latencies).sort(),
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    errors,
  };
}

async function warmup(run: (url: string) => Promise<unknown>, url: string) {
  const deadline = Date.now() + WARMUP_MS;

  while (Date.now() < deadline) {
    await run(url).catch(() => undefined);
  }
}

function formatRow(result: Result, best: number): string {
  const relative = result.opsPerSec / best;

  return [
    result.client.padEnd(16),
    (Math.round(result.opsPerSec).toLocaleString() + ' req/s').padStart(16),
    (relative === 1 ? 'baseline' : `${relative.toFixed(2)}x`).padStart(10),
    result.p50.toFixed(2).padStart(9),
    result.p90.toFixed(2).padStart(9),
    result.p99.toFixed(2).padStart(9),
    result.errors ? String(result.errors).padStart(8) : '       -',
  ].join(' ');
}

async function main() {
  const {url, close} = await startServer();

  // Configured the same way across the board: no retries, no redirects to follow.
  const gotlike = new Gotlike({
    responseType: 'text',
    method: 'GET',
    headers: {},
    throwHttpErrors: true,
    followRedirect: false,
    decompress: false,
  });
  const gotlikeJson = gotlike.extend({responseType: 'json'});

  const gotClient = got.extend({
    retry: {limit: 0},
    followRedirect: false,
    decompress: false,
  });

  const scenarios: Scenario[] = [
    {
      name: 'GET text (5 B)',
      run: {
        gotlike: (base) => gotlike.get(base + '/small'),
        got: (base) => gotClient.get(base + '/small').text(),
        'undici.request': async (base) => {
          const response = await undiciRequest(base + '/small');

          return response.body.text();
        },
        'undici fetch': async (base) => (await fetch(base + '/small')).text(),
      },
    },
    {
      name: 'GET json (83 B)',
      run: {
        gotlike: (base) => gotlikeJson.get(base + '/json'),
        got: (base) => gotClient.get(base + '/json').json(),
        'undici.request': async (base) => {
          const response = await undiciRequest(base + '/json');

          return response.body.json();
        },
        'undici fetch': async (base) => (await fetch(base + '/json')).json(),
      },
    },
    {
      name: 'GET large (100 KB)',
      run: {
        gotlike: (base) => gotlike.get(base + '/large'),
        got: (base) => gotClient.get(base + '/large').text(),
        'undici.request': async (base) => {
          const response = await undiciRequest(base + '/large');

          return response.body.text();
        },
        'undici fetch': async (base) => (await fetch(base + '/large')).text(),
      },
    },
    {
      name: 'POST json',
      run: {
        gotlike: (base) => gotlikeJson.post(base + '/echo', {json: {a: 1, b: 'two'}}),
        got: (base) => gotClient.post(base + '/echo', {json: {a: 1, b: 'two'}}).json(),
        'undici.request': async (base) => {
          const response = await undiciRequest(base + '/echo', {
            method: 'POST',
            body: JSON.stringify({a: 1, b: 'two'}),
            headers: {'content-type': 'application/json'},
          });

          return response.body.json();
        },
        'undici fetch': async (base) =>
          (
            await fetch(base + '/echo', {
              method: 'POST',
              body: JSON.stringify({a: 1, b: 'two'}),
              headers: {'content-type': 'application/json'},
            })
          ).json(),
      },
    },
    {
      name: 'GET stream',
      run: {
        gotlike: async (base) => {
          const stream = await gotlike.stream(base + '/large');

          for await (const _chunk of stream) {
            // drain
          }
        },
        got: async (base) => {
          for await (const _chunk of gotClient.stream(base + '/large')) {
            // drain
          }
        },
        'undici.request': async (base) => {
          const response = await undiciRequest(base + '/large');

          for await (const _chunk of response.body) {
            // drain
          }
        },
        'undici fetch': async (base) => {
          const response = await fetch(base + '/large');

          for await (const _chunk of response.body!) {
            // drain
          }
        },
      },
    },
  ];

  const concurrencies = (process.env.BENCH_CONCURRENCY ?? '1,10,50').split(',').map(Number);

  console.log(`node ${process.version} | server: ${process.env.BENCH_SERVER === 'http' ? 'node:http' : 'raw sockets'}`);
  console.log(
    `${DURATION_MS}ms x ${ROUNDS} rounds per client (median round reported), ` +
      `${WARMUP_MS}ms warmup, ${CONNECTIONS} connections\n`,
  );

  for (const scenario of scenarios) {
    for (const concurrency of concurrencies) {
      console.log(`\x1b[1m${scenario.name} — concurrency ${concurrency}\x1b[0m`);
      console.log(
        'client'.padEnd(16) +
          'throughput'.padStart(16) +
          'vs best'.padStart(11) +
          'p50 ms'.padStart(10) +
          'p90 ms'.padStart(10) +
          'p99 ms'.padStart(10) +
          'errors'.padStart(9),
      );

      const entries = Object.entries(scenario.run).filter(([, run]) => run);
      const rounds: Map<string, Result[]> = new Map();
      const warmed = new Set<string>();

      for (let round = 0; round < ROUNDS; round++) {
        // Rotate who goes first so position bias doesn't land on the same client twice.
        const offset = round % entries.length;
        const ordered = entries.slice(offset).concat(entries.slice(0, offset));

        for (const [client, run] of ordered) {
          if (!warmed.has(client)) {
            await warmup(run!, url);
            warmed.add(client);
          }

          // Let the previous run's sockets and garbage settle.
          global.gc?.();
          await new Promise((resolve) => setTimeout(resolve, 50));

          const {latencies, elapsedMs, errors} = await measure(run!, url, concurrency);

          const result: Result = {
            client,
            opsPerSec: (latencies.length / elapsedMs) * 1000,
            p50: percentile(latencies, 50),
            p90: percentile(latencies, 90),
            p99: percentile(latencies, 99),
            errors,
          };

          const existing = rounds.get(client);

          if (existing) {
            existing.push(result);
          } else {
            rounds.set(client, [result]);
          }
        }
      }

      // Median round per client, so neither a lucky nor an unlucky round decides it.
      const results = [...rounds.values()].map((clientRounds) => {
        const sorted = clientRounds.sort((a, b) => a.opsPerSec - b.opsPerSec);

        return sorted[Math.floor(sorted.length / 2)];
      });

      const fastest = Math.max(...results.map((r) => r.opsPerSec));

      for (const result of [...results].sort((a, b) => b.opsPerSec - a.opsPerSec)) {
        console.log(formatRow(result, fastest));
      }

      console.log();
    }
  }

  await close();
  await agent.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

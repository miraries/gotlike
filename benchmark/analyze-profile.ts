import {readFile} from 'node:fs/promises';

/**
 * Turns a `.cpuprofile` from `profile.ts` into a self-time breakdown, bucketed by who owns the
 * code: gotlike's own `dist/index.js`, undici, Node internals, and V8's own synthetic frames
 * ((garbage collector), (idle), (program)). That last split is the point of this script - it's
 * the answer to "what does gotlike spend time on, apart from the actual undici call".
 *
 * A V8 CPU profile is a call tree (`nodes[]`, each with a `callFrame` and a `hitCount` - the
 * number of samples where that node was on top of the stack, i.e. its *self* time), not a flat
 * sample list. The same function shows up as several different nodes if it's reached through
 * different call paths, so self time is summed by `functionName` + `url` across every node
 * that matches, not read off a single node.
 *
 * Usage: `node analyze-profile.ts get-json.cpuprofile post-json.cpuprofile`
 */

type CallFrame = {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

type CPUProfileNode = {
  id: number;
  callFrame: CallFrame;
  hitCount: number;
  children?: number[];
};

type CPUProfile = {
  nodes: CPUProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
};

type FunctionStat = {
  functionName: string;
  url: string;
  lineNumber: number;
  bucket: string;
  hitCount: number;
};

/**
 * V8's own synthetic frames - `(garbage collector)`, `(idle)`, `(program)`, `(root)` - report
 * as a `functionName` wrapped in parens with an empty `url`; each is its own bucket rather than
 * lumped into "other", since GC and idle time are both meaningful answers on their own.
 */
function bucketOf(frame: CallFrame): string {
  if (/^\(.+\)$/.test(frame.functionName)) {
    return frame.functionName;
  }

  const url = frame.url;

  // Built against `dist/`, not `src/`, since that's what actually runs - see the caveat in
  // the printed report about line numbers not lining up with the TypeScript source.
  if (url.includes('/dist/index.js') || url.endsWith('/src/index.ts')) {
    return 'gotlike';
  }

  if (url.includes('/undici/')) {
    return 'undici';
  }

  if (url.startsWith('node:') || url === '') {
    return 'node internal';
  }

  return 'other';
}

function formatMs(ms: number): string {
  return ms.toFixed(2).padStart(9);
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`.padStart(7);
}

async function analyze(file: string): Promise<void> {
  const profile = JSON.parse(await readFile(file, 'utf8')) as CPUProfile;

  const totalHits = profile.nodes.reduce((sum, node) => sum + node.hitCount, 0);
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  const usPerHit = totalHits > 0 ? (profile.endTime - profile.startTime) / totalHits : 0;

  if (totalHits === 0) {
    console.log(`${file}: no samples recorded (profile too short, or sampling interval coarser than the run)`);

    return;
  }

  const byFunction = new Map<string, FunctionStat>();
  const byBucket = new Map<string, number>();

  for (const node of profile.nodes) {
    if (node.hitCount === 0) {
      continue;
    }

    const bucket = bucketOf(node.callFrame);
    const key = `${node.callFrame.functionName || '(anonymous)'}|${node.callFrame.url}|${node.callFrame.lineNumber}`;

    const existing = byFunction.get(key);

    if (existing) {
      existing.hitCount += node.hitCount;
    } else {
      byFunction.set(key, {
        functionName: node.callFrame.functionName || '(anonymous)',
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber,
        bucket,
        hitCount: node.hitCount,
      });
    }

    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + node.hitCount);
  }

  console.log(`\n\x1b[1m${file}\x1b[0m — ${durationMs.toFixed(0)}ms captured, ${totalHits.toLocaleString()} samples\n`);

  console.log('By owner:');
  const bucketRows = [...byBucket.entries()].sort((a, b) => b[1] - a[1]);

  for (const [bucket, hits] of bucketRows) {
    const ms = hits * usPerHit * 1e-3;

    console.log(`  ${bucket.padEnd(20)} ${formatMs(ms)} ms  ${formatPct(hits / totalHits)}`);
  }

  for (const bucket of ['gotlike', 'undici', 'node internal']) {
    const bucketHits = byBucket.get(bucket);

    if (!bucketHits) {
      continue;
    }

    const functions = [...byFunction.values()]
      .filter((f) => f.bucket === bucket)
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 15);

    console.log(`\nTop "${bucket}" self time:`);
    console.log(`  ${'ms'.padStart(9)}  ${'% of bucket'.padStart(12)}  ${'% of total'.padStart(11)}  function`);

    for (const fn of functions) {
      const ms = fn.hitCount * usPerHit * 1e-3;
      const loc = fn.url ? `  (${fn.url.replace(/^.*\/(dist|node_modules|src)\//, '$1/')}:${fn.lineNumber + 1})` : '';

      console.log(
        `  ${formatMs(ms)}  ${formatPct(fn.hitCount / bucketHits).padStart(12)}  ${formatPct(fn.hitCount / totalHits).padStart(11)}  ${fn.functionName}${loc}`,
      );
    }
  }
}

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node analyze-profile.ts <file.cpuprofile> [more.cpuprofile ...]');
  process.exit(1);
}

for (const file of files) {
  await analyze(file);
}

console.log(
  '\nNote: gotlike line numbers are compiled `dist/index.js` lines, not `src/index.ts` ones - ' +
    'tsc erases type-only lines, so they drift from the source by a small, non-constant offset. ' +
    'Match by function name, or open dist/index.js directly, when a line number matters.',
);

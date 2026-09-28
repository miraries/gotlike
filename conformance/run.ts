/**
 * Runs an upstream test suite - got's or nock's own - against gotlike, and compares the outcome
 * with `<suite>/expectations.json`. See CLAUDE.md for what the expectations mean.
 *
 *   node run.ts got|nock            check against the expectations
 *   node run.ts got|nock --update   rewrite the expectations: drop entries that now pass, add
 *                                   new failures as `untriaged`, keep every existing reason
 *   node run.ts got|nock <file>...  run only these upstream test files (no update, no stale check)
 */
import {spawn, spawnSync} from 'node:child_process';
import {cpus} from 'node:os';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

const here = import.meta.dirname;
const repoRoot = resolve(here, '..');

type Outcome = {pass: boolean; reason: string};
type Results = Map<string, Outcome>;
type Expectations = {
  /** Upstream files not run at all, each with its reason. */
  files: Record<string, string>;
  /** `<file> › <test title>` of every test expected to fail, each with its reason. */
  tests: Record<string, string>;
  /**
   * `<file> › <test title>` of tests not run at all, because they take the runner down with
   * them - a crash or a hang loses every test after it in the file, not just itself.
   */
  skip?: Record<string, string>;
};

type Suite = {
  name: string;
  repo: string;
  /** Pinned: the expectations are only meaningful against one exact upstream. */
  ref: string;
  /** Upstream test files, relative to the clone. */
  listFiles(clone: string): string[];
  /** Applied to a clean checkout on every run. */
  patch(clone: string): void;
  runFile(clone: string, file: string, skip: string[]): Promise<Results>;
};

/* ---------------------------------------------------------------------------------------------- */
/* Upstream checkout                                                                               */
/* ---------------------------------------------------------------------------------------------- */

function sh(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`);
  }

  return result.stdout;
}

/**
 * A clone of `suite.ref`, with its own dependencies installed and gotlike linked into its
 * `node_modules` so the patched tests can `import 'gotlike'`. Cloning and installing happen
 * once; the checkout is reset and re-patched on every run, so a stale patch can never linger.
 */
function checkout(suite: Suite): string {
  const clone = join(here, '.upstream', `${suite.name}@${suite.ref}`);

  if (!existsSync(join(clone, 'node_modules'))) {
    rmSync(clone, {recursive: true, force: true});
    mkdirSync(dirname(clone), {recursive: true});
    console.log(`cloning ${suite.repo}@${suite.ref}`);
    sh('git', ['clone', '--quiet', '--depth', '1', '--branch', suite.ref, suite.repo, clone], here);
    console.log('installing its dependencies');
    sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], clone);
  }

  sh('git', ['checkout', '--quiet', '--', '.'], clone);
  sh('git', ['clean', '--quiet', '-fd', '--exclude=node_modules'], clone);

  const link = join(clone, 'node_modules', 'gotlike');
  rmSync(link, {recursive: true, force: true});
  symlinkSync(repoRoot, link, 'dir');

  suite.patch(clone);

  return clone;
}

/** A string replacement that must hit - a patch that silently stops applying is a lie. */
function replaceIn(path: string, search: string | RegExp, replacement: string): void {
  const before = readFileSync(path, 'utf8');
  const after = before.replace(search, replacement);

  if (after === before) {
    throw new Error(`patch did not apply to ${path}: ${String(search)}`);
  }

  writeFileSync(path, after);
}

function run(command: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv) {
  return new Promise<{stdout: string; stderr: string; timedOut: boolean}>((done) => {
    const child = spawn(command, args, {cwd, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('close', () => {
      clearTimeout(timer);
      done({stdout, stderr, timedOut});
    });
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* got                                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** One line of why a TAP failure failed, out of ava's YAML block. */
function tapReason(block: string): string {
  // The error the test ended on - either its own, or the one an assertion received.
  const errorName = block.match(/^\s+(\w*Error) \{/m)?.[1];
  const errorMessage = block.match(/^\s+message: '((?:[^']|'')*)',?$/m)?.[1];
  const name = block.match(/^\s+name: (\w+)/m)?.[1];
  const message = block.match(/^\s+message: (?!''|>-|\|)(.+)$/m)?.[1];
  const assertion = block.match(/^\s+assertion: (.+)$/m)?.[1];
  // ava's "'Expected message to equal:': 'x'" lines say what the assertion wanted.
  const expected = [...block.matchAll(/^\s+'(Expected [^']*?):?': (.+)$/gm)].map(
    ([, what, value]) => `${what} ${value}`,
  );
  const difference = block.match(/Difference[^\n]*\n((?:\s+[-+] [^\n]*\n){1,4})/)?.[1];
  const parts = [
    name === 'AssertionError' ? assertion : (name ?? assertion),
    errorName && (errorName !== name || !message)
      ? `${errorName}${errorMessage ? ` '${errorMessage}'` : ''}`
      : undefined,
    name === 'AssertionError' ? undefined : message,
    ...expected,
    difference?.trim().replaceAll(/\s*\n\s*/g, ' / '),
  ];

  return parts.filter(Boolean).join(': ').slice(0, 400) || 'failed (no message)';
}

function parseTap(file: string, tap: string): Results {
  const results: Results = new Map();
  let current: {key: string; block: string} | undefined;
  const flush = () => {
    if (current) {
      results.set(current.key, {pass: false, reason: tapReason(current.block)});
      current = undefined;
    }
  };

  for (const line of tap.split('\n')) {
    const match = line.match(/^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/);

    if (match) {
      flush();
      const [, status, title, directive] = match;

      if (directive) {
        continue;
      }

      // ava reports a crashed worker and hook failures as tests of their own. The tests the
      // crash prevented are simply absent, and so fail the "expected to pass" check below.
      const key = `${file} › ${title}`;

      if (status === 'ok') {
        results.set(key, {pass: true, reason: ''});
      } else {
        current = {key, block: ''};
      }
    } else if (current) {
      current.block += line + '\n';
    }
  }

  flush();

  return results;
}

const gotSuite: Suite = {
  name: 'got',
  repo: 'https://github.com/sindresorhus/got.git',
  ref: 'v16.0.0',
  listFiles: (clone) =>
    readdirSync(join(clone, 'test'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.types.ts'))
      .sort(),
  patch(clone) {
    // Every `../source/index.js` import goes through the adapter instead - see got/adapter.ts.
    writeFileSync(join(clone, 'source', 'gotlike-adapter.ts'), readFileSync(join(here, 'got', 'adapter.ts')));

    for (const dir of ['test', 'test/helpers']) {
      for (const file of readdirSync(join(clone, dir)).filter((name) => name.endsWith('.ts'))) {
        const path = join(clone, dir, file);
        const source = readFileSync(path, 'utf8');
        const patched = source.replaceAll(
          /from '((?:\.\.\/)+)source\/index\.js'/g,
          "from '$1source/gotlike-adapter.js'",
        );

        if (patched !== source) {
          writeFileSync(path, patched);
        }
      }
    }

    // got's test servers take a port free on both loopback addresses rather than `listen(0)`'s,
    // which another process on macOS can shadow - see got/free-port.ts.
    const helpers = join(clone, 'test', 'helpers');
    const importFreePort = "import {freeLoopbackPort} from './free-port.js';\n";

    writeFileSync(join(helpers, 'free-port.ts'), readFileSync(join(here, 'got', 'free-port.ts')));
    replaceIn(
      join(helpers, 'create-http-test-server.ts'),
      "\tserver.set('etag', false);\n",
      "\tserver.set('etag', false);\n\tconst port = await freeLoopbackPort();\n",
    );
    replaceIn(join(helpers, 'create-http-test-server.ts'), 'server.http.listen(0, ', 'server.http.listen(port, ');
    replaceIn(join(helpers, 'create-http-test-server.ts'), /^/, importFreePort);
    replaceIn(
      join(helpers, 'create-https-test-server.ts'),
      'await pify(server.https.listen.bind(server.https))();',
      'await pify(server.https.listen.bind(server.https))(await freeLoopbackPort());',
    );
    replaceIn(join(helpers, 'create-https-test-server.ts'), /^/, importFreePort);
    replaceIn(
      join(helpers, 'server-tools.ts'),
      '\tawait listen();',
      '\tawait (listen as unknown as (port: number) => Promise<void>)(await freeLoopbackPort());',
    );
    replaceIn(join(helpers, 'server-tools.ts'), /^/, importFreePort);

    // got's handler `next()` returns its event-emitting promise; gotlike's is a plain one, and
    // this helper wraps every test in a handler that subscribes to it.
    replaceIn(
      join(clone, 'test', 'helpers', 'with-server.ts'),
      /\t+\/\/ @ts-expect-error FIXME: Incompatible union type signatures\n\t+result\.on\('response', \(\) => \{\n\t+clock\.tick\(0\);\n\t+\}\);\n/,
      "\t\t\t\t\tif (typeof (result as any).on === 'function') {\n\t\t\t\t\t\t(result as any).on('response', () => {\n\t\t\t\t\t\t\tclock.tick(0);\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n",
    );
  },
  async runFile(clone, file, skip) {
    // One ava per file: a crash or a hang takes out that file, not the run. ava's `--timeout` is
    // an inactivity timeout for the whole process, which is why the outer kill exists as well.
    const {stdout, timedOut} = await run(
      join(clone, 'node_modules', '.bin', 'ava'),
      [`test/${file}`, '--tap', '--timeout', '30s', ...skip.flatMap((title) => ['--match', `!${title}`])],
      clone,
      180_000,
      {NODE_OPTIONS: '--import=tsx/esm --no-warnings'},
    );
    const results = parseTap(file, stdout);

    if (timedOut) {
      results.set(`${file} › (file timed out)`, {pass: false, reason: 'killed after 180s'});
    }

    return results;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* nock                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

const nockSuite: Suite = {
  name: 'nock',
  repo: 'https://github.com/nock/nock.git',
  ref: 'v14.0.17',
  // Only `tests/got`: the rest of nock's suite drives node's `http` module, which the shim cannot
  // intercept by design (it replaces undici's global dispatcher).
  listFiles: (clone) =>
    readdirSync(join(clone, 'tests', 'got'))
      .filter((file) => file.startsWith('test_') && file.endsWith('.js'))
      .sort(),
  patch(clone) {
    // `require('../..')` is how every test reaches nock: the package root becomes the shim.
    writeFileSync(join(clone, 'index.js'), "'use strict'\n\nmodule.exports = require('gotlike/nock').nock\n");
    writeFileSync(join(clone, 'tests', 'got', 'got_client.js'), readFileSync(join(here, 'nock', 'got_client.cjs')));
    writeFileSync(join(clone, 'tests', 'setup.js'), readFileSync(join(here, 'nock', 'setup.cjs')));
  },
  async runFile(clone, file, skip) {
    const log = join(clone, `.http-${file}.log`);
    rmSync(log, {force: true});
    const {stdout, stderr, timedOut} = await run(
      join(clone, 'node_modules', '.bin', 'mocha'),
      [
        '--reporter',
        'json',
        '--timeout',
        '5000',
        // Some files finish and then wait on a handle a test left open (a keep-alive socket, a
        // timer) until the outer kill at 180s. The report is complete by then either way.
        '--exit',
        ...(skip.length > 0
          ? ['--grep', skip.map((title) => title.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), '--invert']
          : []),
        `tests/got/${file}`,
      ],
      clone,
      180_000,
      {NOCK_CONFORMANCE_HTTP_LOG: log},
    );
    const results: Results = new Map();
    let report: {passes: {fullTitle: string}[]; failures: {fullTitle: string; err: {message?: unknown}}[]};

    try {
      report = JSON.parse(stdout.slice(stdout.indexOf('{')));
    } catch {
      const reason = timedOut ? 'killed after 180s' : ((stderr || stdout).split('\n').find(Boolean) ?? 'no output');
      results.set(`${file} › (file failed to run)`, {pass: false, reason: reason.slice(0, 300)});

      return results;
    }

    // Tests that drove node's `http`/`https` directly, recorded by setup.cjs. They say nothing
    // about the shim either way, so they are reported apart rather than as passes or failures.
    const direct = new Set(existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

    for (const test of report.passes) {
      results.set(`${file} › ${test.fullTitle}`, {pass: true, reason: ''});
    }

    for (const test of report.failures) {
      const key = `${file} › ${test.fullTitle}`;
      const message = String(test.err.message ?? '')
        .split('\n')[0]!
        .slice(0, 300);
      results.set(key, {pass: false, reason: direct.has(test.fullTitle) ? `node-http: ${message}` : message});
    }

    return results;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Comparison                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

async function runAll(suite: Suite, clone: string, files: string[], skip: Record<string, string>): Promise<Results> {
  const all: Results = new Map();
  const queue = [...files];
  const workers = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
  let done = 0;

  await Promise.all(
    Array.from({length: workers}, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const skipped = Object.keys(skip)
          .filter((key) => key.startsWith(`${file} › `))
          .map((key) => key.slice(file.length + 3));
        const results = await suite.runFile(clone, file, skipped);

        for (const [key, outcome] of results) {
          all.set(key, outcome);
        }

        done++;
        const failed = [...results.values()].filter((outcome) => !outcome.pass).length;
        console.log(`[${done}/${files.length}] ${file}: ${results.size - failed} pass, ${failed} fail`);
      }
    }),
  );

  return all;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const suite = {got: gotSuite, nock: nockSuite}[name as string];

  if (!suite) {
    console.error('usage: node run.ts got|nock [--update] [file...]');
    process.exit(2);
  }

  const update = rest.includes('--update');
  const only = rest.filter((arg) => !arg.startsWith('--'));
  const expectationsPath = join(here, suite.name, 'expectations.json');
  const expectations: Expectations = JSON.parse(readFileSync(expectationsPath, 'utf8'));
  const clone = checkout(suite);
  const available = suite.listFiles(clone);
  const files = only.length > 0 ? only : available.filter((file) => !(file in expectations.files));
  const results = await runAll(suite, clone, files, expectations.skip ?? {});

  mkdirSync(join(here, 'results'), {recursive: true});
  writeFileSync(
    join(here, 'results', `${suite.name}.json`),
    JSON.stringify(Object.fromEntries([...results].sort(([a], [b]) => a.localeCompare(b))), null, 1),
  );

  const unexpectedFailures: string[] = [];
  const unexpectedPasses: string[] = [];
  const inScope = (key: string) => files.includes(key.split(' › ')[0]!);

  for (const [key, outcome] of results) {
    if (!outcome.pass && !(key in expectations.tests)) {
      unexpectedFailures.push(`${key}\n      ${outcome.reason}`);
    } else if (outcome.pass && key in expectations.tests) {
      unexpectedPasses.push(key);
    }
  }

  // An expected failure that no longer shows up at all - renamed upstream, or never reached
  // because an earlier test crashed the file.
  const missing = Object.keys(expectations.tests).filter((key) => inScope(key) && !results.has(key));
  const staleFiles = only.length > 0 ? [] : Object.keys(expectations.files).filter((file) => !available.includes(file));
  const untriaged = Object.entries(expectations.tests).filter(([, reason]) => reason.startsWith('untriaged'));

  if (update && only.length === 0) {
    const tests: Record<string, string> = {};

    for (const [key, reason] of Object.entries(expectations.tests)) {
      if (results.get(key)?.pass === false) {
        tests[key] = reason;
      }
    }

    for (const [key, outcome] of results) {
      if (!outcome.pass && !(key in tests)) {
        tests[key] = `untriaged: ${outcome.reason}`;
      }
    }

    writeFileSync(
      expectationsPath,
      JSON.stringify(
        {files: sortKeys(expectations.files), skip: sortKeys(expectations.skip ?? {}), tests: sortKeys(tests)},
        null,
        2,
      ) + '\n',
    );
    console.log(`\nwrote ${expectationsPath}`);
  }

  const passed = [...results.values()].filter((outcome) => outcome.pass).length;
  const counts = new Map<string, number>();

  for (const reason of Object.values(expectations.tests)) {
    const category = reason.split(':')[0]!;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  console.log(
    `\n${suite.name}@${suite.ref}: ${passed} pass, ${results.size - passed} fail, ` +
      `${Object.keys(expectations.files).length} files not run`,
  );
  console.log(`expected failures by category: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}`);

  const report = (title: string, lines: string[]) => {
    if (lines.length > 0) {
      console.log(`\n${title} (${lines.length}):`);

      for (const line of lines) {
        console.log(`  ${line}`);
      }
    }
  };

  if (update) {
    return;
  }

  report('UNEXPECTED FAILURES - a regression, or a new gap that needs triage', unexpectedFailures);
  report('UNEXPECTED PASSES - remove these from expectations.json', unexpectedPasses);
  report('EXPECTED FAILURES THAT DID NOT RUN', missing);
  report('EXCLUDED FILES THAT NO LONGER EXIST', staleFiles);
  report(
    'UNTRIAGED EXPECTATIONS',
    untriaged.map(([key]) => key),
  );

  if (
    unexpectedFailures.length > 0 ||
    unexpectedPasses.length > 0 ||
    missing.length > 0 ||
    staleFiles.length > 0 ||
    untriaged.length > 0
  ) {
    process.exitCode = 1;
  }
}

await main();

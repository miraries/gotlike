# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`gotlike` — a barebones [got](https://github.com/sindresorhus/got)-like HTTP client for Node.js built on
[undici](https://github.com/nodejs/undici), plus a nock-like mocking shim (real nock doesn't intercept undici).
The goal is to be a drop-in replacement for `got` + `nock` in the common cases while being significantly faster;
only the features actually needed are implemented, and it deliberately trades safety/completeness for speed
(no options validation, partial retry/timings support).

Ships ESM (`type: "module"`, `module: "nodenext"`), targets Node >= 22.12, `strict` TS. There is no
`require` condition in `exports` and none is needed: node supports `require()` of ESM from 22.12, which
is what keeps CommonJS consumers like the aggregator working.

The consumer this package exists to serve is `../igd-aggregator-api`, which currently uses
`got-cjs@12` + `nock@14`. Feature decisions are scoped to what that repo actually uses, not to got
parity. Where got's design costs per-request work (deep option merging especially), performance
wins over an exact signature match, as long as the aggregator can still express the same thing.

## Commands

```bash
# single test file / single test
node --test src/index.spec.ts
node --test --test-name-pattern 'extend client with hook' src/index.spec.ts
```

Type stripping erases types without checking them, so **type errors only surface from `npm run typecheck` or
`npm run build`, never from `npm test`**. CI runs both, on node 22, 24 and 26.

Benchmarks live in `benchmark/` as a separate npm project with its own `package.json`/`node_modules`. See the
Benchmark section below before trusting any number out of it.

## Architecture

Three things live here, and the detail for each is loaded on demand rather than kept in this file:

| what | where the code is | where the notes are |
| --- | --- | --- |
| the `Gotlike` client — request pipeline, hooks, dispatcher/interceptors, streams, timeouts, `extend()`, response typing, perf | `src/index.ts` | **`src/CLAUDE.md`** (loads automatically when you work under `src/`) |
| the nock-compatible mocking shim | `src/nock.ts` | the **`nock-shim`** skill |
| the tests and the coverage gate | `src/*.spec.ts` | the **`testing`** skill |
| the got/nock parity suites | `src/parity/` | **`src/parity/CLAUDE.md`** |
| got's and nock's own test suites, run against gotlike | `conformance/` | **`conformance/CLAUDE.md`** |
| the benchmark + profiler | `benchmark/` | **`benchmark/CLAUDE.md`** |
| lint / format / tsconfig setup | `.oxlintrc.json`, `.oxfmtrc.json`, `tsconfig*.json` | the **`lint-config`** skill |

**`src/CLAUDE.md` is not optional reading when changing `src/index.ts`.** Nearly every paragraph in it records
behaviour that was silently wrong once — a merge that aliased the caller's options, a hook ordering that broke
token refresh, a url join that dropped the query off the wire. The code does not explain any of it.

Two invariants are repeated here because they are the ones most easily undone by a change that looks local:

- **Never mutate the caller's options.** `formOptions` allocates a fresh object per request, and every option
  whose value is a mutable object shared with the client gets copied. The formed options are handed to every
  caller as `response.request.options` and `error.options`, so a write through them must not reach the client.
- **`afterResponse` hooks run before `throwHttpErrors`.** got-style token-refresh hooks have to see the 401
  that triggers them. Reordering these breaks every provider auth flow in the aggregator.

### Mocking

`nock.ts` is a nock-compatible façade over undici's `MockAgent` (real nock doesn't intercept undici).
**Read the `nock-shim` skill before changing it.** Almost every translation it gets wrong fails the same
way — the interceptor silently doesn't match, and the request falls through to the *real network* — so the
list of translations and their reasons is not optional background.

### Tests

`index.spec.ts` boots a real `http.createServer` on port 3000 with route-based behaviors; several suites are
invariant *tables* rather than scenarios, which is deliberate. **Read the `testing` skill before adding or
changing a test** — it carries the server's routes, the retry-test pitfalls (`backoffLimit`, per-`test-id`
counters, why `mock.timers` is unusable here) and the coverage gate's five deliberately-uncovered branches.
One rule worth repeating here because it makes a test pass while asserting nothing: `assert.rejects` returns
a promise, so **always `await` it**. `npm run lint` now catches that via `typescript/no-floating-promises`.

## Parity suite

Lives in `src/parity/` — full notes in `src/parity/CLAUDE.md`, which loads when you work in that
directory. Read it before touching a scenario, a generator or a `divergence` pin.

## Conformance

`conformance/` runs **got 16's own test suite** and **nock 14's got-based suite** against gotlike and the shim,
against a committed list of expected failures, each labelled `bug`/`gap`/`unsupported`/`divergence`/... - full
notes in `conformance/CLAUDE.md`. It is what the parity suite cannot be: cases someone else wrote. Its CI job runs
separately from `check`, since it clones and installs both upstreams. **The target is got 16**: a consumer on an
older got moves to 16, rather than gotlike keeping the older behaviour as a divergence.

## Benchmark

Lives in `benchmark/`, a separate npm project — full notes (including the methodology caveats and the
profiling workflow) in `benchmark/CLAUDE.md`, which loads when you work in that directory.

## Lint, format, typecheck

`npm run check` runs typecheck → lint → format check → tests. CI runs it, then `npm run build` — `check`
typechecks with `noEmit`, which can't catch a declaration-emit failure. The full setup and the
rule-by-rule "why it's off" rationale is the **`lint-config` skill**; read it before changing
`.oxlintrc.json`, `.oxfmtrc.json` or either tsconfig.

## Public API surface

`index.ts` exports the class plus pre-built singletons for drop-in replacement: `default`, `gotlike`, `got`
(all one `createClient()` — the defaults come from the constructor now, so passing `defaultOptions` here would be
redundant), and types `Got`, `ExtendOptions`, `RequestOptions`, `Response`,
`HandlerFunction`, `RequestError`, `ClientDefaults`, `DefaultsMergeOptions`. Keep all of these working when changing the entry point — the README documents
requiring/importing any of them.

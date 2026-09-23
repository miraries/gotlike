---
name: lint-config
description: Lint, format and typecheck setup for gotlike — the oxlint/oxfmt/tsconfig layout, and why each type-aware rule is on or off. Read before changing .oxlintrc.json, .oxfmtrc.json, or either tsconfig.
---

# Lint, format, typecheck

`npm run check` runs typecheck → lint → format check → tests. CI runs it, then `npm run build` — `check`
typechecks with `noEmit`, which can't catch a declaration-emit failure.

`benchmark/` is linted by `npm run lint` but is **not** typechecked by `check`, because doing so needs both
`npm install` inside `benchmark/` (for `got`) and a built `dist/` for its `../dist` import. `npm --prefix benchmark
run typecheck` does it on demand and handles the build itself. That is also why `lint` is two commands rather than
one: `oxlint --type-aware src && oxlint benchmark`. Type-aware rules need a resolvable program, which `benchmark/`
only has after that install and build, so it gets the syntactic rules only.

- **oxlint** (`.oxlintrc.json`) with `correctness: error`, `suspicious`/`pedantic` as warnings. Rules turned
  off are listed with a reason where it isn't obvious — `unicorn/no-useless-undefined` in particular, because
  `undefined` carries meaning here (it is how "unset" reaches undici, and `.catch(() => undefined)` is a
  deliberate swallow).
- **`.oxlintrc.json` is strict JSON, not JSONC.** oxlint parses comments in it happily, but every editor
  treats a `.json` extension as JSON and flags them, so the reasons for the `off` entries live here instead.
- **Type-aware rules run too**, via `oxlint-tsgolint` (the Go port of typescript-eslint's type-aware rules)
  behind oxlint's `--type-aware`. It is a separate binary from the `typescript` package this repo compiles
  with, so it needs no `tsc` of its own and adds ~100ms to a lint run over `src`. The rules that pay for
  themselves report nothing here and are left on: `await-thenable`, `no-misused-promises`, `restrict-*-operands`,
  `no-deprecated`, `use-unknown-in-catch-callback-variable`, `return-await`, `no-base-to-string`,
  `unbound-method`. The one that earns its keep loudest is **`no-floating-promises`**, which is what catches an
  un-awaited `assert.rejects` — the failure mode documented under Tests, where the test passes unconditionally.
  It needs `allowForKnownSafeCalls` for `node:test`'s `test`/`describe`/`before`/… or all ~330 test cases report
  as floating promises and the real one is lost in them.

The type-aware rules turned `off` are turned off against *this* codebase, not on principle, and mostly for one
reason: the rule reads a deliberate design as a defect. Check what a rule actually reports here before turning
it back on.

| rule | why it's off |
| --- | --- |
| `prefer-readonly-parameter-types` | 453 reports, and typescript-eslint ships it in no preset. Handlers and `beforeRequest` hooks write to the formed options by design — that is what `formOptions` allocates for. |
| `no-unsafe-type-assertion`, `no-unsafe-{assignment,member-access,call,argument,return}` | They report the `Promise<any>` implementation signatures that the overload set exists to resolve — see "Response body typing". |
| `strict-boolean-expressions` | Truthiness is the hot path's idiom (`if (options.searchParams)`); spelling each out costs a read per request for no behaviour change. |
| `no-unnecessary-type-conversion` | `String(opts.path ?? '')` and friends guard values whose *types* say string but whose source is undici or a caller — the same reason option validation exists at all. The rule reads them as redundant because it trusts the type. |
| `no-confusing-void-expression`, `strict-void-return` | Style: both want braces around `() => stream.emit(...)` and `setImmediate(() => release())`. A promise passed where void is expected is caught by `no-misused-promises`, which is on. |
| `prefer-nullish-coalescing` | `\|\|` is chosen where `0`/`''` should be falsy, and `??=` over an `if` block loses the comment explaining the branch. |
| `prefer-promise-reject-errors` | The one site rejects a value caught as `unknown`, which the rule cannot see is an Error. |
| `no-unnecessary-type-arguments` | An explicit `failure<RequestError>(...)` in the specs documents what is being asserted, even where it matches the default. |
| `no-unnecessary-type-parameters` | `typeAssertions` in `index.spec.ts` is built out of single-use type parameters on purpose. |
| `typescript/require-await` | Same reason the eslint rule above it is off: a hook or a test callback is `async` to satisfy a signature, not because it has something to await. |
- **oxfmt** (`.oxfmtrc.json`) with `bracketSpacing: false`, to match the brace style already in the repo
  rather than reformatting every line to a new one.
  **Markdown is in `ignorePatterns`** (`**/*.md`). The only markdown under `src`/`benchmark` is the hand-wrapped
  `CLAUDE.md` notes, which oxfmt would re-pad (every table row to the widest cell) and rewrite (`*x*` to `_x_`),
  turning a one-row edit into a whole-table diff. The README is outside the formatted paths for the same reason.
- **Two tsconfigs.** `tsconfig.json` is the *checking* config: `noEmit`, includes the spec files, and allows
  `.ts` import specifiers (which the specs use). `tsconfig.build.json` extends it to emit `dist/` and excludes
  the specs. **The specs were previously not type-checked at all** — the build config's `exclude` kept them
  out of `tsc`, and type stripping doesn't check — so 2000 lines of test code had no checking. Keep
  `npm run typecheck` pointed at the config that includes them.
- `erasableSyntaxOnly` is on, which enforces the type-stripping constraint at compile time rather than in
  prose. `noUncheckedIndexedAccess` is on. **`exactOptionalPropertyTypes` is deliberately off**: passing
  `undefined` through to undici is the idiom throughout, and satisfying the flag would mean building option
  objects conditionally — per-request work, against the whole point.

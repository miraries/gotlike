# Conformance: got's and nock's own test suites

`conformance/` runs **got 16's own test suite** against gotlike and **nock 14's `tests/got` suite** against the
nock shim, and compares the outcome with a committed list of expected failures. It is a separate npm project,
like `benchmark/`; the upstream repos are cloned into `.upstream/` (gitignored) at a pinned tag, with their own
dependencies installed there.

```bash
cd conformance
npm run got       # build gotlike, run got@v16.0.0's suite, compare with got/expectations.json
npm run nock      # the same for nock@v14.0.17's tests/got
node run.ts got headers.ts hooks.ts   # only these upstream files
node run.ts got --update              # rewrite expectations: drop what passes now, add new failures as `untriaged`
```

The first run clones and installs (a minute or two); after that a got run takes ~3 minutes and a nock run ~30s.
`results/<suite>.json` holds every test's outcome and reason from the last run.

## Why it exists

The parity suite (`src/parity/`) compares gotlike with got on scenarios *we* wrote, so it can only find
differences in behaviour someone already thought of. Every bug found by switching `igd-aggregator-api` over was
outside that: an option never implemented (`mutableDefaults`), a call form never tried (`client.post({json})`,
a function body matcher). got's and nock's own suites are ~2,000 cases written by someone else, which is the
point. This is the answer to "will another project switching from got hit something new".

## How a run is judged

Everything not listed in `expectations.json` must pass. A run fails on:

- **an unexpected failure** - a regression, or something new to triage;
- **an unexpected pass** - an entry to remove (the list must not rot into "known noise");
- **an expected failure that did not run** - renamed upstream, or never reached because the file crashed;
- **an `untriaged` entry** - `--update` adds those, and they have to be given a real reason.

`files` lists upstream files not run at all, `skip` lists individual tests not run because they take the
runner down with them (ava loses every test after a crash in the same file), and `tests` is every expected
failure. Each entry's reason starts with a category:

| category | meaning | what to do |
| --- | --- | --- |
| `bug` | gotlike or the shim is wrong | fix it; the entry goes when the test passes |
| `gap` | missing or different, **and not documented** | implement it, or document it and re-label it `unsupported`/`divergence` |
| `unsupported` | a feature deliberately not implemented, documented in the README | nothing |
| `divergence` | a deliberate behavioural difference, documented (README or a parity pin) | nothing |
| `internals` | the test exercises got's own modules or internals, not the client | nothing |
| `node-http` | a nock test driving node's `http` module, which the shim never intercepts by design | nothing |
| `harness` / `unverified` | the adapter, not gotlike, may be the cause | look before trusting it |

The reasons were assigned in bulk, by rules over the failure message and the test's source, and then by hand
for what the rules did not reach. A test that trips over two missing features is labelled with the first rule
that matched, so treat a reason as "why it fails first", not "the only thing wrong".

## The got adapter (`got/adapter.ts`)

got's tests import `got` from `source/index.js` (and most receive it through the `withServer` helper); the
runner rewrites those imports to `source/gotlike-adapter.ts`, which re-exports got's source and shadows
everything gotlike provides. **The adapter applies the README's own migration advice, and nothing else**, so a
test reaches what it is actually testing instead of dying on the first documented difference:

- create/extend-only options given per request (`hooks`, `retry`, `agent`, ...) go through `extend()`;
- the root client is `extend({retry: {}, followRedirect: true})`, got's defaults;
- `stream()` returns a stand-in `Duplex` synchronously and forwards the real stream once it resolves.

got's `.json()`/`.text()`/`.buffer()` promise shortcuts used to be shimmed here too; gotlike has them now, so
the suite tests the real ones.

Anything the adapter translates is invisible to the suite, so keep it to that list. Three things in it are
there only to keep a file running, not to translate behaviour: a handler's `next()` result gets inert
`on`/`once` (got's is an event emitter, and a subscriber would crash the file), the promise a call returns is
marked handled (got throws a bad call synchronously where gotlike rejects, and a test expecting the throw never
awaits the rejection), and a stream error nobody listens for ends the stand-in quietly instead of crashing the
file. `with-server.ts` gets the same `next()` guard, as a string patch that fails loudly if it stops applying.

## The nock runner

`index.js` of the nock clone becomes `require('gotlike/nock').nock`, `got_client.js` becomes gotlike's default
client (theirs is `got.extend({retry: 0})`, which gotlike's default already is), and `tests/setup.js` is replaced
by `nock/setup.cjs`, which resets through whichever of nock's teardown calls the shim has. It also wraps
`http.request`/`get` so a test that drives node's http client directly is reported as `node-http` rather than
as a finding: the shim replaces undici's global dispatcher and never sees those requests.

## Bumping upstream

Change `ref` in `run.ts`, run with `--update`, and triage every `untriaged` entry. A newly failing test after a
bump is an upstream behaviour change - exactly what this exists to surface. The target is **got 16** (and nock
14); don't add a divergence to accommodate a consumer still on an older got. Move the consumer instead.

# Parity suite

`src/parity/` runs the same scenario through **real got 16** and through gotlike, against one local
server, and asserts that both what the caller sees and what reached the server are identical. `npm run
parity` runs it alone; `npm test` (and so `npm run check` and CI) picks it up with everything else.

It exists because the "measured against got 16" claims throughout the root `CLAUDE.md` and the specs were
hand-verified once, in a session, and then never re-run. They were the most valuable thing documented
here and the easiest to silently invalidate — a fix that changes behaviour has no way of knowing it
broke a parity claim recorded in prose. Now it does.

Three pieces:

- **`server.ts`** — the shared server. Deliberately separate from `index.spec.ts`'s: parity is mostly a
  question of what the client put on the wire, so nearly every route funnels into an `/echo` that
  reflects method, path, headers and body back. Listens on port 0, because the spec files run in
  parallel processes and a fixed port makes the suite fail on what else is running. `reset()` clears
  the attempt counters as well as the wire log — a scenario runs once per client, and both runs have to
  see the same server.
- **`harness.ts`** — `parityTest(name, scenario)`, plus the two allowlists.
- **`parity.spec.ts`** — the hand-written scenarios, each carrying the `claim` it pins.
- **`property.spec.ts`** — the same comparison over *generated* inputs. The hand-written scenarios pin the
  claims someone thought to write down; these explore the space around them, aimed at url joining, query
  merging, header folding and body encoding — which is where this repo's bugs actually lived, each one a
  particular character in a particular position nobody had tried. The seed is fixed (`PARITY_SEED` overrides),
  so a red build is reproducible: a suite that generates fresh inputs per run fails on one machine and passes
  on the next, which is worse than not running. ~2,000 cases across eight seeds currently agree with got; the
  one disagreement it found is pinned in `parity.spec.ts` (a leading slash under `prefixUrl`).

  **A generator has to reach every input *shape*, not just every subsystem.** Two of these targeted query
  serialisation for a long time while `searchParams` went unencoded onto the url for the string form — because
  `query()` only ever built a `Record<string,string>`, so `stringifyQuery`'s string branch was never compared
  against got at all, and the alphabet carried no `#`. Coverage stayed green throughout: it measures execution,
  not which shape executed it. It happened a second time one level down, at the shape of a *value*: `query()`
  built string values only, so `searchParams: {a: null}` — which got sends as `a=` and this dropped entirely —
  was never generated either. `nullableQuery()` is the widening, and it is deliberately not used for `form`,
  which diverges from got on those two values by design. It happened a *third* time at the same level:
  `query()` built strings only, so a `number` or `boolean` value — both declared on `QueryValue`, both serialised
  by `queryValue`'s bare `String(value)` — was never compared either. `scalar()` is that widening. An **array**
  value is deliberately still out of reach, and that is the limit of this technique: got rejects an array
  `searchParams` and stringifies an array `form` to `a=1%2C2`, so a generated case carrying one could only ever be
  a divergence, and a generator that manufactures divergences stops being able to find them. Those two are pinned
  as scenarios instead. The same applies to a call *form* — eight cross-origin hook tests all mutated
  `options.headers` in place, so the case where a hook assigns a new object went unexercised and lost the hook's
  own credentials. When a bug turns out to be "nobody passed it that way", widen the generator rather than
  adding one more example.
- **`nock-harness.ts` / `nock-parity.spec.ts`** — the same idea for the mocking shim, against **real nock 14**.
  nock intercepts node's http stack and the shim replaces undici's global dispatcher, so each side is driven by
  the client it can actually intercept — nock with got, the shim with gotlike — and what is compared is the only
  question a mocking layer is being asked: did this interceptor match, and what did it reply? Every failure
  collapses to `matched: false`, deliberately: the two report a miss through completely different machinery, and
  comparing error shapes would say nothing about matching. Registration is inside the try as well as the
  dispatch, because how a mock is *written* is part of the surface too.

**Everything not explicitly recorded as divergent must match exactly.** That is what makes the suite
converge instead of drifting: there is no "close enough". Two escape hatches, and both are stricter
than they look:

- **`DIVERGENT_REQUEST_HEADERS`** — request headers allowed to differ, each with its reason. The map
  *is* the wire-level divergence inventory.
- **`scenario.divergence`** — an intended behavioural difference, recorded as the exact value **each**
  client produces. This is stronger than skipping, and stronger than asserting "these differ": both
  sides stay pinned, so the test fails if gotlike drifts *and* if a got upgrade changes got. A `skip`
  would catch neither.

The suite prints the full inventory when it finishes: **four request headers and eleven behaviours**
against got 16, and three against nock. It started at five and seven; what closed the gap was fixing what
the suite found rather than recording it (the seventh behaviour is the stream-upload framing below,
which arrived with the stream scenarios rather than from anything changing here, the eighth is the
`form` nullish rule above, which arrived the way the rule says one should — as the recorded half of a fix,
not as a way of making a red test green — and the ninth and tenth are the array-value rows for `form` and
`searchParams`, which had been diverging *unrecorded*, which is the one state this inventory exists to
rule out):

- **an `accept` derived from `responseType`**, which got sends and this did not — the one that changed
  what comes *back*, since a content-negotiating upstream could answer gotlike with HTML where it
  answered got with JSON;
- **a `head()` verb**, which got has and this did not, so `client.head(url)` was a `TypeError`;
- **`HTTPError.code`**, now got's `ERR_NON_2XX_3XX_RESPONSE` rather than `ERR_HTTP_ERROR`. Nothing in
  `igd-aggregator-api` branches on it, but `BTi.ts` hand-writes got's spelling for its own synthetic
  errors in four places, so the two codes would have split one condition across the error reporting;
- **a `code` on `ValidationError`** (`ERR_INVALID_OPTION`) — every other error carried one;
- **the `ParseError` message**, which now carries got's ` in "<url>"` suffix.

What is left is left on purpose, and the reason travels with each pin. Three are cases where gotlike is
the better of the two and the note says so (a 204 read as json giving `undefined` rather than `""`; a
`beforeRequest` url append not accumulating a signature across a retry; a `ValidationError` class kept
distinct from `RequestError`). One is a narrowed refusal to copy got: `HTTPError`'s message is now got's
phrasing in full — `Request failed with status code 403 (Forbidden): GET http://host/path` — **minus the
query string**, because got's embeds the whole url and puts whatever the query carries (tokens,
signatures) into every log line and APM group that prints the error. The path is what identifies the
request; the query is what leaks. `withoutQuery` does the cut and is shared with `resolveUrl`, where it
measured *faster* than the inline code it replaced — see the note on it before changing it, and read the
note about how to measure it before believing any number you get. The last is the one place
gotlike is *more* permissive than got (a leading slash under `prefixUrl`), which is now in the README's
divergence table rather than only in a test.

The sixth arrived with the bump rather than from anything changing here: **got rejects a `url` key in an
options object**, so `got({url, ...})` and `got(url, {url})` both throw a `TypeError` where got 12 and 14
took the first and rejected only the second. The change landed in **got 15**, not 16 — the suite was simply
still pinned to 14 and had never seen it. This is what the bump was for: an upstream behaviour change surfaced
by a failing test naming the exact value that moved, rather than by a caller finding it.

gotlike first *kept* the option, because its first consumer was on `got-cjs@12`, where it is ordinary. That
was the wrong call and has been undone: **the target is got 16**, and a consumer on an older got updates to
it rather than gotlike carrying the older behaviour. Keeping it made a call that works here and throws under
got, which is the one direction a drop-in must never differ in. Both now refuse with got's message; the class
and code differ as they do for every validation failure. **Don't add a divergence to accommodate an older got.**

**Adding a divergence is a deliberate act.** If a change makes something new diverge, the suite fails
until someone writes down why that is acceptable. Reaching for `divergence` to make a red test green is
how this stops being worth anything.

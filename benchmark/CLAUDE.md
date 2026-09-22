# Benchmark

`benchmark/` is a separate npm project (ESM, its own `node_modules`). `npm run bench` from there builds the
parent and runs it; it imports `../dist`, so it measures the shipped artifact. Node's native type stripping
runs the `.ts` files directly — no ts-node.

`server.ts` serves pre-built response buffers over raw sockets, parsing only enough of each request to pick
one. A `node:http` server is measurable at these rates; `BENCH_SERVER=http` switches to one to check that the
raw server isn't distorting things.

**Methodology matters more than it looks here.** A single pass showed a ~25% swing purely from client
*order* — whoever runs first gets warm sockets and leaves a cold JIT for everyone else — which is larger than
most differences worth reporting. The runner therefore does several rounds, rotates who goes first, and scores
each client on its **median** round. Best-of was tried first and just traded position bias for whichever
client got the luckiest round.

Between-process variance is still ~15%, so **gotlike and raw `undici.request` should be read as at parity** —
gotlike is a thin wrapper and cannot genuinely be faster. If a change makes gotlike look like it beats raw
undici, that is a measurement artefact, not a result. Env knobs: `BENCH_DURATION`, `BENCH_ROUNDS`,
`BENCH_WARMUP`, `BENCH_CONCURRENCY`, `BENCH_SERVER`.

### Profiling

`npm run profile` (from `benchmark/`) answers a different question than `bench` does: not "how does gotlike
compare to got/undici/fetch", but "what does gotlike's *own* code spend time on". `profile.ts` drives the two
shapes that matter most - a GET whose response is a ~10-property JSON object, and a POST that sends and
receives one - against `server.ts`'s raw-socket loopback server, and captures a V8 CPU profile per scenario via
`node:inspector`'s `Session`. Loopback rather than a null dispatcher: the sampling profiler only attributes
time to frames actually on the stack, so a real (if local) socket wait shows up as idle rather than inflating
some function's self time, and the samples that remain are genuinely CPU-bound.

`analyze-profile.ts` turns a `.cpuprofile` into a self-time report, bucketed by owner - `gotlike`, `undici`,
`node internal`, and V8's own `(garbage collector)`/`(idle)`/`(program)` frames - which is the actual point:
telling gotlike's own overhead apart from undici's and Node's. Self time is summed by function across every
node in the call tree that matches, since the same function appears as several different tree nodes when it's
reached through different call paths.

Measured this way (concurrency 20, 4s/scenario): gotlike's own code is ~7-9% of wall time, with `call()`
itself accounting for ~77-80% of that (it's where the actual work - body read, JSON codec, response
construction - happens, not fat to trim) and `splitUserinfo` a distant second at ~9-13% (~300-400ns/request,
see `parseUserinfo` above). Node's socket write/parse internals (~42-44%) and undici's own request machinery
(~18%) dwarf both, and are outside gotlike's own code. Line numbers in the report are compiled `dist/index.js`
lines, not `src/index.ts` ones - no source-map consumption - so match by function name.

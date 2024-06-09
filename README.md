# Gotlike

Barebones [got](https://github.com/sindresorhus/got)-like [undici](https://github.com/nodejs/undici)-based not-as-safe
commonjs-compatible http client for node.js.

Includes a nock-like mocking system (since nock doesn't work with undici).

The idea is to be able to replace got and nock with gotlike in most cases, while being faster.
At the moment only the features I use are implemented.

Supports:
- [x] Extendable client
- [x] Handlers
- [x] Hooks (single function per hook)
- [ ] DNS Cache
- [ ] Retries
- [x] Streams *(no progress or timings)*
- [x] Timings *(only total request)*
- [ ] Response body in error
- [ ] Options validation
- [ ] Nock-like mocking

## Benchmark

```
got - promise x 9,576 ops/sec ±1.27% (82 runs sampled)
got - stream x 10,456 ops/sec ±3.78% (82 runs sampled)
request - callback x 11,671 ops/sec ±0.86% (84 runs sampled)
node-fetch - promise x 10,472 ops/sec ±2.86% (81 runs sampled)
axios - promise x 10,443 ops/sec ±2.70% (81 runs sampled)
native fetch - promise x 16,702 ops/sec ±2.53% (81 runs sampled)
gotlike - promise x 23,230 ops/sec ±0.66% (85 runs sampled)

Fastest is gotlike - promise
```

// Copied into got's `test/helpers` by the runner; its http and https test servers listen on the
// port this picks instead of `listen(0)`. See "Test servers" in conformance/CLAUDE.md.
import net from 'node:net';

type Bound = {server?: net.Server; code?: string};

function bind(port: number, host: string): Promise<Bound> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (error: NodeJS.ErrnoException) => resolve({code: error.code}));
    server.listen({port, host, exclusive: true}, () => resolve({server}));
  });
}

function close(bound: Bound): Promise<void> {
  return new Promise((resolve) => (bound.server ? bound.server.close(() => resolve()) : resolve()));
}

/**
 * A port nothing holds on either loopback address.
 *
 * got's servers `listen(0)` on the dual-stack wildcard and are reached as `localhost`. macOS lets
 * another process hold `127.0.0.1:P` or `[::1]:P` alongside a wildcard `[::]:P`, and prefers the
 * specific address - so a request meant for the test server could reach a VS Code helper or a
 * `kubectl port-forward` instead, and fail as a test nobody could reproduce (measured: a test
 * server bound `[::]:P` beside a port-forward on `[::1]:P` never saw a request - every one, to
 * `localhost` too, got the forwarded service's 200). Linux refuses that overlap, so there
 * `listen(0)` is safe and is what this returns. Picking a port there would only add a race: an
 * outgoing connection can take it between the probe closing and the server listening, which
 * failed a random test or so per CI run with `EADDRINUSE`.
 */
export async function freeLoopbackPort(): Promise<number> {
  if (process.platform !== 'darwin') {
    return 0;
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    // Below the ephemeral range and picked at random, not `bind(0)`: macOS hands those out in
    // sequence, so a file running beside this one could be given the port between this probe
    // closing and the server listening, and fail with `EADDRINUSE`.
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const v4 = await bind(port, '127.0.0.1');

    if (v4.server === undefined) {
      continue;
    }

    const v6 = await bind(port, '::1');

    await close(v4);
    await close(v6);

    // No IPv6 loopback at all is fine: nothing can hold it either.
    if (v6.code !== 'EADDRINUSE') {
      return port;
    }
  }

  return 0;
}

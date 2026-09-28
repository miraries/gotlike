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
 * `listen(0)` was already safe, and this costs two probe binds per server.
 */
export async function freeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const v4 = await bind(0, '127.0.0.1');

    if (v4.server === undefined) {
      continue;
    }

    const port = (v4.server.address() as net.AddressInfo).port;
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

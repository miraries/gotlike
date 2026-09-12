import http from 'node:http';
import zlib from 'node:zlib';
import type {AddressInfo} from 'node:net';

/** What a request actually looked like on the wire, as the server saw it. */
export type WireRecord = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type ParityServer = {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  base: string;
  /** Every request this server has seen since the last `reset()`, in arrival order. */
  wire: WireRecord[];
  reset: () => void;
  close: () => Promise<void>;
};

/**
 * The server both clients are pointed at.
 *
 * Deliberately separate from `index.spec.ts`'s server: parity is mostly a question of what
 * the client put on the wire, so almost every route here funnels into `/echo`, and the few
 * that don't exist to provoke a specific divergence (an error status with a non-json body, a
 * status that gets retried, a redirect chain).
 *
 * Listens on port 0 rather than a fixed port - the spec files run in parallel processes, and
 * a hardcoded port makes the suite fail depending on what else is running.
 */
export async function startParityServer(): Promise<ParityServer> {
  const wire: WireRecord[] = [];
  const attempts: Record<string, number> = {};

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const query = new URL(path, 'http://x').searchParams;

      wire.push({
        method: req.method ?? '',
        path,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });

      if (path.startsWith('/status')) {
        res.statusCode = Number(query.get('code') ?? 200);
        res.end();

        return;
      }

      // An error status whose body is not the json that was asked for: a proxy's HTML error
      // page in front of an API, which is where the parse-failure ordering shows up.
      if (path.startsWith('/html-error')) {
        res.statusCode = Number(query.get('code') ?? 500);
        res.setHeader('content-type', 'text/html');
        res.end('<html><body>Gateway problem</body></html>');

        return;
      }

      if (path.startsWith('/redirect')) {
        res.statusCode = Number(query.get('status') ?? 302);
        res.setHeader('location', query.get('to') ?? '/echo');
        res.end();

        return;
      }

      /*
       * Fails with `code` until it has been hit `fail` times, then echoes. `delay` spends real
       * time on every attempt, which is what separates a per-attempt deadline from a cumulative
       * one: several delayed attempts cost more than `timeout.request` allows for a single one.
       */
      if (path.startsWith('/flaky')) {
        const id = query.get('id') ?? 'default';
        const fail = Number(query.get('fail') ?? 1);
        const delay = Number(query.get('delay') ?? 0);

        attempts[id] = (attempts[id] ?? 0) + 1;

        const failing = attempts[id] <= fail;

        const answer = () => {
          if (failing) {
            res.statusCode = Number(query.get('code') ?? 503);
            res.end();

            return;
          }

          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({method: req.method, path, attempt: attempts[id]}));
        };

        if (delay > 0) {
          setTimeout(answer, delay).unref();
        } else {
          answer();
        }

        return;
      }

      // A body that is not the json a caller asked for, on an otherwise fine status.
      if (path.startsWith('/not-json')) {
        res.setHeader('content-type', 'application/json');
        res.end('this is not json');

        return;
      }

      if (path.startsWith('/gzip')) {
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-type', 'application/json');
        res.end(zlib.gzipSync(JSON.stringify({compressed: true})));

        return;
      }

      if (path.startsWith('/slow')) {
        setTimeout(() => res.end('slow'), Number(query.get('ms') ?? 3000)).unref();

        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          method: req.method,
          path,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const {port} = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    wire,
    /*
     * Clears the attempt counters as well as the wire log: a scenario is run once per client
     * and both runs must see the same server, so `/flaky` has to fail for the second client
     * exactly as it did for the first.
     */
    reset: () => {
      wire.length = 0;

      for (const key of Object.keys(attempts)) {
        delete attempts[key];
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

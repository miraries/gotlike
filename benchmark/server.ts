import net from 'node:net';
import http from 'node:http';
import type {AddressInfo} from 'node:net';

/**
 * Canned-response HTTP server.
 *
 * A `node:http` server is fast, but not so fast that it disappears from the measurement -
 * at these rates the server's own parsing and response building show up in the client
 * numbers. This writes pre-built response buffers straight to the socket and parses only
 * enough of the request to know which one to send, so what's left to measure is the client.
 *
 * `BENCH_SERVER=http` swaps in a plain `node:http` server to sanity-check that the raw one
 * isn't distorting the comparison.
 */

const bodies: Record<string, {body: Buffer, contentType: string}> = {
  '/small': {body: Buffer.from('hello'), contentType: 'text/plain'},
  '/json': {
    body: Buffer.from(JSON.stringify({
      id: 12345,
      name: 'benchmark',
      tags: ['a', 'b', 'c'],
      nested: {ok: true, count: 42},
    })),
    contentType: 'application/json',
  },
  '/large': {body: Buffer.from('x'.repeat(100 * 1024)), contentType: 'text/plain'},
  '/echo': {body: Buffer.from('{"ok":true}'), contentType: 'application/json'},
};

/** Pre-built, so the hot path is a single socket write. */
const responses = new Map<string, Buffer>(
  Object.entries(bodies).map(([path, {body, contentType}]) => [
    path,
    Buffer.concat([
      Buffer.from(
        'HTTP/1.1 200 OK\r\n' +
        `content-type: ${contentType}\r\n` +
        `content-length: ${body.length}\r\n` +
        'connection: keep-alive\r\n' +
        '\r\n',
      ),
      body,
    ]),
  ]),
);

const notFound = Buffer.from('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: keep-alive\r\n\r\n');

/**
 * Minimal HTTP/1.1 request reader: enough to find the path and skip past any body, so that
 * keep-alive and pipelined requests on one socket stay in step.
 */
function createRawServer() {
  return net.createServer({noDelay: true}, (socket) => {
    socket.setNoDelay(true);

    let buffered = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

      // One pass per complete request currently in the buffer.
      for (;;) {
        const headerEnd = buffered.indexOf('\r\n\r\n');

        if (headerEnd === -1) {
          return;
        }

        const head = buffered.toString('latin1', 0, headerEnd);
        const contentLength = /\r\ncontent-length:\s*(\d+)/i.exec(head);
        const bodyLength = contentLength ? Number(contentLength[1]) : 0;
        const total = headerEnd + 4 + bodyLength;

        if (buffered.length < total) {
          return;
        }

        const path = head.slice(head.indexOf(' ') + 1, head.indexOf(' ', head.indexOf(' ') + 1));
        const queryStart = path.indexOf('?');

        socket.write(responses.get(queryStart === -1 ? path : path.slice(0, queryStart)) ?? notFound);

        buffered = buffered.subarray(total);
      }
    });

    socket.on('error', () => socket.destroy());
  });
}

function createHttpServer() {
  return http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const entry = bodies[path];

    req.resume();

    if (!entry) {
      res.statusCode = 404;
      res.end();

      return;
    }

    res.setHeader('content-type', entry.contentType);
    res.setHeader('content-length', entry.body.length);
    res.end(entry.body);
  });
}

export function startServer(port = 0): Promise<{url: string, close: () => Promise<void>}> {
  const server = process.env.BENCH_SERVER === 'http' ? createHttpServer() : createRawServer();

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const {port: boundPort} = server.address() as AddressInfo;

      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.unref();
        }),
      });
    });
  });
}

// Allow running it standalone for manual poking.
if (process.argv[1]?.endsWith('server.ts')) {
  startServer(8080).then(({url}) => console.log(`Listening at ${url} (${process.env.BENCH_SERVER === 'http' ? 'node:http' : 'raw'})`));
}

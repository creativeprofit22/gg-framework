import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createBroker } from './budget.mjs';

const MAX_BYTES = 3 * 1024 * 1024;

/** Loopback supervisor transport. Never accepts an upstream URL or credentials from workers. */
export async function startTransport({ enabled = false, records, transport, persist, reserveTokens, runId } = {}) {
  const broker = createBroker({ enabled, records, transport, persist });
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    request.setTimeout(20000, () => request.destroy());
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
        request.method !== 'POST' || request.url !== '/request') {
      response.writeHead(403).end();
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new Error('Payload limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await broker.request({ runId, reserveTokens, body });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      // Never expose provider errors (which may contain credentials) to workers.
      response.writeHead(503).end('Transport unavailable or budget exhausted');
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    broker,
    url: `http://127.0.0.1:${server.address().port}/request`,
    token,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}

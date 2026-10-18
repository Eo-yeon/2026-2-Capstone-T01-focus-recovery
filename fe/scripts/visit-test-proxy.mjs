import { createServer } from 'node:http';

// Test transport only: successful requests always reach the actual BE and its DB.
export async function visitTestProxy(apiOrigin) {
  let arm;
  const held = new Set();
  const proxy = { requests: [], sessionRequests: 0, failVisits: false, onVisit: async () => undefined };
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const path = new URL(req.url, apiOrigin).pathname;
      if (path === '/api/sessions' && req.method === 'POST') proxy.sessionRequests++;
      const visitPath = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/visits$/i);
      const isVisit = visitPath && req.method === 'POST';
      const record = isVisit ? { sessionId: visitPath[1], body: JSON.parse(body.toString()), status: undefined, delivered: false } : undefined;
      if (record) { proxy.requests.push(record); await proxy.onVisit(record); }
      if (record && proxy.failVisits) {
        // An explicit injected transport failure, never reported as a real BE result.
        record.status = 503; record.injected = true;
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key'];
      const upstream = await fetch(new URL(req.url, apiOrigin), {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'error',
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (record) record.status = upstream.status;
      const deliver = () => {
        if (!res.destroyed) {
          res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
          res.end(payload);
        }
        if (record) record.delivered = true;
        held.delete(deliver);
      };
      if (record && arm?.sequence === record.body.sequence) {
        const ready = arm.resolve; arm = undefined;
        held.add(deliver); ready({ record, release: deliver });
      } else deliver();
    } catch {
      // Never print request bodies, upstream error text or collected data.
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(proxy, {
    origin: `http://localhost:${server.address().port}`,
    holdNext(sequence) {
      if (arm) throw new Error('A response hold is already armed');
      return new Promise(resolve => { arm = { sequence, resolve }; });
    },
    async close() {
      for (const deliver of held) deliver();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  });
}

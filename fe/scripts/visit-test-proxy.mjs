import { createServer } from 'node:http';

// Test transport only: successful requests always reach the actual BE and its DB.
export async function visitTestProxy(apiOrigin) {
  let arm, behaviorArm, endArm;
  const held = new Set();
  const proxy = { requests: [], behaviorRequests: [], endRequests: [], sessionRequests: 0, failVisits: false, failBehaviors: 0, onVisit: async () => undefined };
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const path = new URL(req.url, apiOrigin).pathname;
      if (path === '/api/sessions' && req.method === 'POST') proxy.sessionRequests++;
      const endPath = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/end$/i);
      const end = endPath && req.method === 'POST' ? { sessionId: endPath[1], body: JSON.parse(body.toString()), delivered: false } : undefined;
      if (end) proxy.endRequests.push(end);
      const visitPath = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/visits$/i);
      const isVisit = visitPath && req.method === 'POST';
      const behaviorPath = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/visits\/([a-f0-9-]{36})\/behavior$/i);
      const behavior = behaviorPath && req.method === 'PATCH' ? { sessionId: behaviorPath[1], visitId: behaviorPath[2], body: JSON.parse(body.toString()), delivered: false } : undefined;
      if (behavior) proxy.behaviorRequests.push(behavior);
      const record = isVisit ? { sessionId: visitPath[1], body: JSON.parse(body.toString()), status: undefined, delivered: false } : undefined;
      if (record) { proxy.requests.push(record); await proxy.onVisit(record); }
      if (record && proxy.failVisits) {
        // An explicit injected transport failure, never reported as a real BE result.
        record.status = 503; record.injected = true;
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      if (behavior && proxy.failBehaviors > 0) {
        proxy.failBehaviors--; behavior.status = 503; behavior.injected = true; behavior.delivered = true;
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key'];
      const upstream = await fetch(new URL(req.url, apiOrigin), {
        // onVisit can explicitly inject invalid test input for real BE validation.
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : record ? JSON.stringify(record.body) : body, redirect: 'error',
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (end) { end.status = upstream.status; end.response = JSON.parse(payload.toString()); }
      if (record) { record.status = upstream.status; record.response = JSON.parse(payload.toString()); }
      if (behavior) { behavior.status = upstream.status; behavior.response = JSON.parse(payload.toString()); }
      const deliver = () => {
        if (!res.destroyed) {
          res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
          res.end(payload);
        }
        if (end) end.delivered = true;
        if (record) record.delivered = true;
        if (behavior) behavior.delivered = true;
        held.delete(deliver);
      };
      if (end && endArm) {
        const ready = endArm; endArm = undefined; held.add(deliver); ready({ record: end, release: deliver });
      } else if (record && arm?.sequence === record.body.sequence) {
        const ready = arm.resolve; arm = undefined;
        held.add(deliver); ready({ record, release: deliver });
      } else if (behavior && behaviorArm && (!behaviorArm.visitId || behaviorArm.visitId === behavior.visitId)) {
        const ready = behaviorArm.resolve; behaviorArm = undefined;
        held.add(deliver); ready({ record: behavior, release: deliver });
      } else deliver();
    } catch {
      // Never print request bodies, upstream error text or collected data.
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(proxy, {
    origin: `http://localhost:${server.address().port}`,
    holdNextEnd() {
      if (endArm) throw new Error('An end response hold is already armed');
      return new Promise(resolve => { endArm = resolve; });
    },
    holdNext(sequence) {
      if (arm) throw new Error('A response hold is already armed');
      return new Promise(resolve => { arm = { sequence, resolve }; });
    },
    holdNextBehavior(visitId) {
      if (behaviorArm) throw new Error('A behavior response hold is already armed');
      return new Promise(resolve => { behaviorArm = { visitId, resolve }; });
    },
    async close() {
      for (const deliver of held) deliver();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  });
}

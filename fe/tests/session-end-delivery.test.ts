import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionEndDelivery, type SessionEndCheckpoint } from '../src/background/session-end';
import { serverSession } from './session-fixture';
const session = serverSession();
const ack = { ...session, status: 'ENDED' as const, endedAt: '2026-10-19T00:00:00.000Z' };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('END interruption budget', () => {
  it('preserves attempts through three HTTP interruptions, stops automatic replay, and renews only on retry', async () => {
    let saved: SessionEndCheckpoint | undefined;
    const send = vi.fn(async () => new Promise<typeof ack>(() => {}));
    const workers: SessionEndDelivery[] = [];
    function worker() {
      const delivery = new SessionEndDelivery(async op => { const result = op(); saved = structuredClone(delivery.checkpoint); return result; }, () => true, () => true, () => false, send);
      workers.push(delivery); return delivery;
    }
    const first = worker(); first.begin(session, 1000); first.kick();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(saved).toMatchObject({ phase: 'sending', attempts: attempt, request: {} }));
      expect(send).toHaveBeenCalledTimes(attempt);
      const next = worker(); next.restore(saved); next.kick();
    }
    await vi.waitFor(() => expect(saved).toMatchObject({ phase: 'failed', attempts: 3, retryable: true }));
    for (let n = 0; n < 3; n++) { const next = worker(); next.restore(saved); next.kick(); }
    expect(send).toHaveBeenCalledTimes(3);
    const last = workers.at(-1)!; send.mockResolvedValue(ack); last.retry(); last.kick();
    await vi.waitFor(() => expect(saved).toMatchObject({ phase: 'acked', attempts: 1, request: {}, ack }));
    expect(send).toHaveBeenCalledTimes(4);
  });
});

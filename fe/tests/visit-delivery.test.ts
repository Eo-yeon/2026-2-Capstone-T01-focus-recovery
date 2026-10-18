import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisitDelivery } from '../src/background/visit-delivery';
import { serialExecutor } from '../src/background/serial';
import { VisitApiError } from '../src/api/visit';
import { Collector } from '../src/background/collector';
import { serverSession } from './session-fixture';
import { pageVisit } from './visit-fixture';
import type { PageVisit } from '../src/shared/types';
function mutationExecutor() {
  const serial = serialExecutor();
  return <T>(operation: () => T) => serial(async () => operation());
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const response = (visit: PageVisit) => ({ ...visit, updatedAt: null });
const deferred = () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const promise = new Promise<ReturnType<typeof response>>(done => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('sequential visit delivery', () => {
  it('sends one valid visit and records ACK only after completion', async () => {
    const gate = deferred(), visit = pageVisit();
    const send = vi.fn(() => gate.promise);
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect([visit]); delivery.kick(); await flush();
    expect(delivery.status().visits[0].phase).toBe('sending');
    gate.resolve(response(visit)); await flush();
    expect(delivery.status().visits[0].phase).toBe('acked');
    expect(send).toHaveBeenCalledExactlyOnceWith(visit);
  });
  it('sorts by sequence and does not send later visits before ACK, including arrivals during HTTP', async () => {
    const gate = deferred(), visits = [pageVisit(1), pageVisit(2), pageVisit(3)];
    const send = vi.fn(async (visit: PageVisit) => visit.sequence === 1 ? gate.promise : response(visit));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect([visits[1], visits[0]]); delivery.kick(); await flush();
    delivery.collect([visits[2], visits[0]]); delivery.kick(); await flush();
    expect(send.mock.calls.map(([visit]) => visit.sequence)).toEqual([1]);
    gate.resolve(response(visits[0])); await flush();
    expect(send.mock.calls.map(([visit]) => visit.sequence)).toEqual([1, 2, 3]);
    delivery.collect(visits); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(delivery.status().visits.every(visit => visit.phase === 'acked')).toBe(true);
  });
  it('does not send excluded, pending or valid-but-unsequenced collector visits', async () => {
    const collector = new Collector(); collector.start(serverSession()); collector.foreground(1, 0);
    collector.navigate(1, 'one', 'identity', 'new', 0);
    collector.observe(1, 'one', collector.state.session!.sessionId, { normalizedUrl: 'https://example.com/', domain: 'example.com', identity: 'identity', title: '문서', content: 'x'.repeat(60), isSearchResultPage: false }, undefined, 1000);
    collector.navigate(2, 'excluded', null, 'new', 1000);
    collector.navigate(3, 'pending', 'other', 'new', 1000);
    const send = vi.fn(async (visit: PageVisit) => response(visit));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect(collector.status(1000).readyVisits); delivery.kick(); await flush();
    expect(send).not.toHaveBeenCalled();
    collector.stop(1200); delivery.collect(collector.status(1200).readyVisits); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].sequence).toBe(1);
  });
  it('retries a lost response with exactly the original snapshot despite collector updates', async () => {
    const visit = pageVisit(), original = { ...visit };
    const send = vi.fn(async (v: PageVisit) => response(v)).mockRejectedValueOnce(new VisitApiError('network', '응답 유실', true));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect([visit]); delivery.kick(); await flush();
    visit.activeDurationMs += 5000; visit.behaviorVersion++; visit.tabSwitchCount++;
    delivery.collect([visit, pageVisit(2)]); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(send.mock.calls[0][0]).toEqual(original);
    expect(send.mock.calls[1][0]).toEqual(original);
    expect(send.mock.calls[2][0].sequence).toBe(2);
  });
  it.each([400, 404, 409])('retains terminal HTTP %i and holds all later visits without retry', async status => {
    const send = vi.fn().mockRejectedValue(new VisitApiError('http', '확인 필요', false, status, status === 409 ? 'VISIT_SEQUENCE_CONFLICT' : undefined));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect([pageVisit(), pageVisit(2)]); delivery.kick(); await flush();
    await vi.advanceTimersByTimeAsync(60000); delivery.retry(); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(delivery.status().visits.map(v => v.phase)).toEqual(['failed', 'queued']);
  });
  it('bounds automatic retries and permits explicit retry using the same snapshot', async () => {
    const original = pageVisit();
    const send = vi.fn().mockRejectedValue(new VisitApiError('timeout', '시간 초과', true));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect([original, pageVisit(2)]); delivery.kick(); await flush();
    await vi.advanceTimersByTimeAsync(10000); await flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(delivery.status().visits[0]).toMatchObject({ phase: 'failed', retryable: true, attempts: 3 });
    send.mockImplementation(async (visit: PageVisit) => response(visit));
    delivery.retry(); delivery.kick(); await flush();
    expect(send.mock.calls[3][0]).toEqual(original);
    expect(delivery.status().visits.every(v => v.phase === 'acked')).toBe(true);
  });
  it('persists the original snapshot before HTTP and restores an interrupted request', async () => {
    const gate = deferred(), original = pageVisit(); let saved: unknown;
    const serial = serialExecutor();
    const send = vi.fn(() => { expect(saved).toMatchObject({ entries: [{ visit: original, phase: 'sending' }] }); return gate.promise; });
    const delivery = new VisitDelivery(operation => serial(async () => { const result = operation(); saved = structuredClone(delivery.checkpoint); return result; }), () => true, send);
    delivery.collect([original]); delivery.kick(); await flush();
    const replay = vi.fn(async (v: PageVisit) => response(v));
    const restored = new VisitDelivery(mutationExecutor(), () => true, replay);
    restored.restore(structuredClone(saved)); restored.kick(); await flush();
    expect(replay).toHaveBeenCalledExactlyOnceWith(original);
    expect(restored.status().visits[0].phase).toBe('acked');
    gate.resolve(response(original)); await flush();
    const acked = new VisitDelivery(mutationExecutor(), () => true, replay);
    acked.restore(structuredClone(restored.checkpoint)); acked.collect([original]); acked.kick(); await flush();
    expect(replay).toHaveBeenCalledTimes(1);
  });
  it('does not block state operations while HTTP is pending', async () => {
    const serial = serialExecutor(), gate = deferred();
    const delivery = new VisitDelivery(operation => serial(async () => operation()), () => true, () => gate.promise);
    const visit = pageVisit(); delivery.collect([visit]); delivery.kick(); await flush();
    let processed = false; await serial(async () => { processed = true; });
    expect(processed).toBe(true); expect(delivery.status().visits[0].phase).toBe('sending');
    gate.resolve(response(visit)); await flush();
  });
  it('ignores late ACK after local deletion and stops unsent requests', async () => {
    const gate = deferred(), send = vi.fn(() => gate.promise), first = pageVisit();
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.collect([first, pageVisit(2)]); delivery.kick(); await flush(); delivery.clear();
    gate.resolve(response(first)); await flush();
    expect(send).toHaveBeenCalledTimes(1); expect(delivery.status().visits).toEqual([]);
  });
  it('does not send a deleted snapshot when checkpoint completion was delayed', async () => {
    let finishWrite!: () => void;
    const write = new Promise<void>(resolve => { finishWrite = resolve; });
    const send = vi.fn();
    const delivery = new VisitDelivery(async operation => { const result = operation(); await write; return result; }, () => true, send);
    delivery.collect([pageVisit()]); delivery.kick(); await flush();
    delivery.clear(); finishWrite(); await flush();
    expect(send).not.toHaveBeenCalled(); expect(delivery.status().visits).toEqual([]);
  });
  it('pauses sending for session recovery and resumes without altering requests', async () => {
    let enabled = false; const send = vi.fn(async (v: PageVisit) => response(v));
    const delivery = new VisitDelivery(mutationExecutor(), () => enabled, send);
    delivery.collect([pageVisit()]); delivery.kick(); await flush(); expect(send).not.toHaveBeenCalled();
    enabled = true; delivery.kick(); await flush(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not send when checkpoint saving fails', async () => {
    const send = vi.fn();
    const delivery = new VisitDelivery(async () => { throw new Error('PRIVATE_DATA'); }, () => true, send);
    delivery.collect([pageVisit()]); delivery.kick(); await flush();
    expect(send).not.toHaveBeenCalled(); expect(delivery.status().blocked).toBeTruthy();
  });
  it('blocks corrupt or foreign-server checkpoints instead of replacing snapshots', async () => {
    const send = vi.fn(), delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.restore({ apiBaseUrl: 'https://another.example', entries: [] });
    delivery.collect([pageVisit()]); delivery.kick(); await flush();
    expect(delivery.status().blocked).toBeTruthy(); expect(send).not.toHaveBeenCalled();
  });
});

describe('checkpoint restoration boundaries', () => {
  function saved(phase: 'queued' | 'sending' | 'retry-wait' | 'failed' | 'acked') {
    const delivery = new VisitDelivery(mutationExecutor(), () => false);
    delivery.collect([pageVisit(1), pageVisit(2)]);
    const checkpoint = structuredClone(delivery.checkpoint);
    Object.assign(checkpoint.entries[0], { phase, attempts: phase === 'queued' ? 0 : 1 });
    if (phase === 'retry-wait') checkpoint.entries[0].nextRetryAt = Date.now() + 1000;
    if (phase === 'failed') Object.assign(checkpoint.entries[0], { error: '확인 필요', retryable: false, code: 'VISIT_ID_CONFLICT' });
    return checkpoint;
  }
  it.each(['queued', 'sending', 'retry-wait', 'failed', 'acked'] as const)('restores %s without changing the original request or ACK', async phase => {
    const checkpoint = saved(phase), original = structuredClone(checkpoint.entries[0].visit);
    const send = vi.fn(async (visit: PageVisit) => response(visit));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.restore(structuredClone(checkpoint));
    expect(delivery.checkpoint.entries[0].visit).toEqual(original);
    expect(delivery.status().visits[0].phase).toBe(phase === 'sending' ? 'queued' : phase);
    delivery.kick(); await flush();
    if (phase === 'retry-wait') {
      expect(send).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1000); await flush();
    }
    if (phase === 'failed') {
      await vi.advanceTimersByTimeAsync(60000); delivery.kick(); await flush();
      expect(send).not.toHaveBeenCalled();
      expect(delivery.checkpoint).toEqual(checkpoint);
    } else {
      expect(send.mock.calls.map(([visit]) => visit.sequence)).toEqual(phase === 'acked' ? [2] : [1, 2]);
      if (phase !== 'acked') expect(send.mock.calls[0][0]).toEqual(original);
      expect(delivery.status().visits.every(visit => visit.phase === 'acked')).toBe(true);
    }
  });
  it('keeps exhausted retryable failures stopped across worker restarts until explicit retry', async () => {
    const checkpoint = saved('failed'); Object.assign(checkpoint.entries[0], { attempts: 3, retryable: true });
    const send = vi.fn(async (visit: PageVisit) => response(visit));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.restore(structuredClone(checkpoint)); delivery.kick(); await vi.advanceTimersByTimeAsync(60000); await flush();
    expect(send).not.toHaveBeenCalled(); expect(delivery.checkpoint).toEqual(checkpoint);
    delivery.retry(); delivery.kick(); await flush();
    expect(send.mock.calls[0][0]).toEqual(checkpoint.entries[0].visit);
    expect(delivery.status().visits.every(visit => visit.phase === 'acked')).toBe(true);
  });
  it('replays an uncertain last sending attempt once, then preserves a failed state instead of looping', async () => {
    const checkpoint = saved('sending'); checkpoint.entries[0].attempts = 3;
    const send = vi.fn().mockRejectedValue(new VisitApiError('network', '응답 미확인', true));
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.restore(structuredClone(checkpoint)); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledExactlyOnceWith(checkpoint.entries[0].visit);
    expect(delivery.status().visits[0]).toMatchObject({ phase: 'failed', attempts: 4, retryable: true });
    const restored = new VisitDelivery(mutationExecutor(), () => true, send);
    restored.restore(structuredClone(delivery.checkpoint)); restored.kick(); await vi.advanceTimersByTimeAsync(60000); await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['visit-id', 'sequence', 'mixed-session', 'url', 'time', 'retry-time', 'ack-order'] as const)('blocks %s corruption without rewriting or sending the record', async corruption => {
    const checkpoint = saved('queued');
    if (corruption === 'visit-id') checkpoint.entries[0].visit.visitId = crypto.randomUUID();
    if (corruption === 'sequence') checkpoint.entries[0].visit.sequence = 99;
    if (corruption === 'mixed-session') checkpoint.entries[1].visit.sessionId = crypto.randomUUID();
    if (corruption === 'url') checkpoint.apiBaseUrl = 'https://other.example';
    if (corruption === 'time') checkpoint.entries[0].visit.visitedAt = 'invalid';
    if (corruption === 'retry-time') checkpoint.entries[0].phase = 'retry-wait';
    if (corruption === 'ack-order') checkpoint.entries[1].phase = 'acked';
    const raw = structuredClone(checkpoint), send = vi.fn();
    const delivery = new VisitDelivery(mutationExecutor(), () => true, send);
    delivery.restore(checkpoint); delivery.collect([pageVisit(3)]); delivery.kick(); await flush();
    expect(delivery.status().blocked).toBeTruthy(); expect(send).not.toHaveBeenCalled();
    expect(checkpoint).toEqual(raw);
  });
});

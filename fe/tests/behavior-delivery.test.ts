import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorDelivery } from '../src/background/behavior-delivery';
import { VisitDelivery } from '../src/background/visit-delivery';
import { serialExecutor } from '../src/background/serial';
import { VisitApiError } from '../src/api/visit';
import type { VisitBehavior } from '../src/shared/types';
import { pageVisit } from './visit-fixture';
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const serial = () => { const queue = serialExecutor(); return <T>(operation: () => T) => queue(async () => operation()); };
const ack = (visitId: string, behavior: VisitBehavior) => ({ visitId, ...behavior, applied: true, updatedAt: '2026-10-18T10:00:00.000Z' });
const latest = (step = 1) => ({ activeDurationMs: 8000 * step, tabSwitchCount: step, behaviorVersion: 3 * step });
function setup() {
  const visit = pageVisit();
  const posts = new VisitDelivery(serial(), () => false); posts.collect([visit]); posts.checkpoint.entries[0].phase = 'acked';
  const send = vi.fn(async (_session: string, id: string, request: VisitBehavior) => ack(id, request));
  const delivery = new BehaviorDelivery(serial(), id => posts.checkpoint.entries.some(p => p.visitId === id && p.phase === 'acked'), send);
  const collect = (values = latest()) => delivery.collect([{ ...visit, ...values }], posts.checkpoint.entries);
  return { delivery, send, posts, visit, collect };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
describe('behavior delivery ordering and recovery', () => {
  it('skips unchanged POST behavior', async () => {
    const { delivery, send, visit, collect } = setup(); collect(visit); delivery.kick(); await flush();
    expect(send).not.toHaveBeenCalled(); expect(delivery.status().visits[0].phase).toBe('acked');
  });
  it('keeps POST immutable while changes wait for its ACK, then merges latest behavior', async () => {
    const visit = pageVisit(), postGate = gate<any>();
    const postSend = vi.fn(() => postGate.promise), queue = serial();
    const posts = new VisitDelivery(queue, () => true, postSend);
    const send = vi.fn(async (_s: string, id: string, value: VisitBehavior) => ack(id, value));
    const delivery = new BehaviorDelivery(queue, id => posts.checkpoint.entries.some(p => p.visitId === id && p.phase === 'acked'), send);
    posts.collect([visit]); posts.kick(); await flush();
    for (const value of [latest(), latest(2)]) { posts.collect([{ ...visit, ...value }]); delivery.collect([{ ...visit, ...value }], posts.checkpoint.entries); delivery.kick(); }
    await flush(); expect(send).not.toHaveBeenCalled(); expect(postSend.mock.calls[0]).toEqual([visit]);
    postGate.resolve({ ...visit, updatedAt: null }); await flush();
    delivery.collect([{ ...visit, ...latest(2) }], posts.checkpoint.entries); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledExactlyOnceWith(visit.sessionId, visit.visitId, latest(2));
    expect(posts.checkpoint.entries[0].visit).toEqual(visit);
  });
  it('coalesces in-flight changes and never runs two PATCHes for one visit', async () => {
    const { delivery, send, collect, visit } = setup(), pending = gate<ReturnType<typeof ack>>();
    send.mockImplementationOnce(() => pending.promise); collect(); delivery.kick(); await flush();
    for (let step = 2; step <= 4; step++) { collect(latest(step)); delivery.kick(); }
    await flush(); expect(send).toHaveBeenCalledTimes(1);
    expect(delivery.status().visits[0].request).toEqual(latest());
    pending.resolve(ack(visit.visitId, latest())); await flush();
    expect(send.mock.calls.map(c => c[2])).toEqual([latest(), latest(4)]);
    expect(delivery.status().visits[0]).toMatchObject({ phase: 'acked', ack: latest(4), latest: latest(4) });
  });
  it('allows serial Collector events during a slow PATCH', async () => {
    const queue = serial(), { posts, visit } = setup(), pending = gate<ReturnType<typeof ack>>();
    const delivery = new BehaviorDelivery(queue, () => true, () => pending.promise);
    delivery.collect([{ ...visit, ...latest() }], posts.checkpoint.entries); delivery.kick(); await flush();
    await queue(() => delivery.collect([{ ...visit, ...latest(2) }], posts.checkpoint.entries));
    expect(delivery.status().visits[0]).toMatchObject({ phase: 'sending', latest: latest(2) });
    delivery.clear(); pending.resolve(ack(visit.visitId, latest())); await flush();
  });
  it('handles several changed visits without letting a terminal failure block another visit', async () => {
    const { delivery, send, posts, visit, collect } = setup(), second = pageVisit(2); posts.collect([second]); posts.checkpoint.entries[1].phase = 'acked';
    send.mockRejectedValueOnce(new VisitApiError('http', '충돌', false, 409, 'BEHAVIOR_VERSION_CONFLICT'));
    collect(); delivery.collect([{ ...second, ...latest(2) }], posts.checkpoint.entries); delivery.kick(); await flush();
    expect(send.mock.calls.map(c => c[1])).toEqual([visit.visitId, second.visitId]);
    expect(delivery.status().visits.map(e => e.phase)).toEqual(['failed', 'acked']);
  });
  it('retries a lost response with the same snapshot before sending subsequent values', async () => {
    const { delivery, send, collect } = setup(); send.mockRejectedValueOnce(new VisitApiError('network', '유실', true));
    collect(); delivery.kick(); await flush(); collect(latest(2));
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(send.mock.calls.map(c => c[2])).toEqual([latest(), latest(), latest(2)]);
  });
  it('limits attempts and manual retry retains failed values, even after new values arrive', async () => {
    const { delivery, send, collect } = setup(); send.mockRejectedValue(new VisitApiError('timeout', '유실', true));
    collect(); delivery.kick(); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(3); expect(delivery.hasUnconfirmed()).toBe(true);
    collect(latest(2)); send.mockImplementation(async (_s, id, value) => ack(id, value));
    delivery.retry(); delivery.kick(); await flush();
    expect(send.mock.calls.map(c => c[2])).toEqual([latest(), latest(), latest(), latest(), latest(2)]);
    expect(delivery.hasUnconfirmed()).toBe(false);
  });
  it.each(['BEHAVIOR_VERSION_CONFLICT', 'BEHAVIOR_COUNTER_DECREASED', 'SESSION_ENDED'])('retains terminal %s without automatic correction or retry', async code => {
    const { delivery, send, collect } = setup(); send.mockRejectedValue(new VisitApiError('http', '확인 필요', false, 409, code));
    collect(); delivery.kick(); await flush(); collect(latest(2)); delivery.retry(); delivery.kick(); await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1); expect(delivery.status().visits[0]).toMatchObject({ phase: 'failed', code, request: latest(), latest: latest(2) });
  });
  it('persists before HTTP and replays interrupted requests after Worker restart', async () => {
    const { posts, visit } = setup(), pending = gate<ReturnType<typeof ack>>(), queue = serial(); let saved: any;
    const send = vi.fn(() => { expect(saved.entries[0]).toMatchObject({ phase: 'sending', request: latest() }); return pending.promise; });
    const delivery = new BehaviorDelivery(operation => queue(() => { const result = operation(); saved = structuredClone(delivery.checkpoint); return result; }), () => true, send);
    delivery.collect([{ ...visit, ...latest() }], posts.checkpoint.entries); delivery.kick(); await flush();
    const replay = vi.fn(async (_s: string, id: string, value: VisitBehavior) => ({ ...ack(id, value), applied: false }));
    const restored = new BehaviorDelivery(serial(), () => true, replay); restored.restore(saved, posts.checkpoint.entries);
    restored.collect([{ ...visit, ...latest(2) }], posts.checkpoint.entries); restored.kick(); await flush();
    expect(replay.mock.calls.map(c => c[2])).toEqual([latest(), latest(2)]);
    const acked = new BehaviorDelivery(serial(), () => true, replay); acked.restore(structuredClone(restored.checkpoint), posts.checkpoint.entries); acked.kick(); await flush();
    expect(replay).toHaveBeenCalledTimes(2); delivery.clear(); pending.resolve(ack(visit.visitId, latest())); await flush();
  });
  it('accepts a newer monotone server ACK and never rewinds it to a stale collector state', async () => {
    const { delivery, send, collect, visit } = setup(); send.mockResolvedValueOnce({ ...ack(visit.visitId, latest(3)), applied: false });
    collect(); delivery.kick(); await flush(); collect(latest(2)); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledTimes(1); expect(delivery.status().visits[0]).toMatchObject({ phase: 'acked', ack: latest(3), latest: latest(2) });
  });
  it.each([{ activeDurationMs: 9000, tabSwitchCount: 2, behaviorVersion: 2 }, { activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 10 }])('blocks incompatible latest values against ACK without inventing versions: %j', async incompatible => {
    const { delivery, send, collect } = setup(); collect(); delivery.kick(); await flush(); collect(incompatible); delivery.kick(); await flush();
    expect(send).toHaveBeenCalledTimes(1); expect(delivery.status().visits[0]).toMatchObject({ phase: 'failed', retryable: false, ack: latest(), latest: incompatible });
  });
  it('ignores late ACK after delete and permits a clean new queue', async () => {
    const { delivery, send, collect, visit } = setup(), pending = gate<ReturnType<typeof ack>>(); send.mockImplementationOnce(() => pending.promise);
    collect(); delivery.kick(); await flush(); delivery.clear(); pending.resolve(ack(visit.visitId, latest())); await flush();
    expect(delivery.status().visits).toEqual([]); expect(delivery.hasUnconfirmed()).toBe(false);
    collect(latest(2)); delivery.kick(); await flush(); expect(delivery.status().visits[0].ack).toEqual(latest(2));
  });
  it('never sends if checkpoint saving fails', async () => {
    const { posts, visit } = setup(), send = vi.fn();
    const delivery = new BehaviorDelivery(async () => { throw Error('PRIVATE'); }, () => true, send);
    delivery.collect([{ ...visit, ...latest() }], posts.checkpoint.entries); delivery.kick(); await flush();
    expect(send).not.toHaveBeenCalled(); expect(delivery.status().blocked).toBeTruthy();
  });
  it.each(['api', 'latest', 'request', 'ack', 'post', 'phase', 'duplicate'])('preserves and blocks corrupt %s recovery data', async field => {
    const { delivery, posts, collect } = setup(); collect();
    const saved = structuredClone(delivery.checkpoint), entry = saved.entries[0];
    if (field === 'api') saved.apiBaseUrl = 'https://other.example';
    if (field === 'latest') entry.latest.activeDurationMs = -1;
    if (field === 'request') { entry.request = latest(2); entry.phase = 'sending'; }
    if (field === 'ack') entry.ack!.behaviorVersion = -1;
    if (field === 'post') posts.checkpoint.entries[0].phase = 'sending';
    if (field === 'phase') entry.phase = 'sending';
    if (field === 'duplicate') saved.entries.push(structuredClone(entry));
    const original = structuredClone(saved), send = vi.fn();
    const restored = new BehaviorDelivery(serial(), () => true, send); restored.restore(saved, posts.checkpoint.entries); restored.kick(); await flush();
    expect(restored.status().blocked).toBeTruthy(); expect(send).not.toHaveBeenCalled(); expect(saved).toEqual(original);
  });
  it('uses the actual POST replay server behavior as baseline', async () => {
    const { posts, delivery, send, collect } = setup(); posts.checkpoint.entries[0].serverBehavior = latest(2);
    collect(); delivery.kick(); await flush(); expect(send).not.toHaveBeenCalled();
    expect(delivery.status().visits[0].ack).toEqual(latest(2));
  });
  it('does not send a deleted snapshot after a delayed checkpoint write', async () => {
    const { posts, visit } = setup(), write = gate<void>(), send = vi.fn();
    const delivery = new BehaviorDelivery(async operation => { const result = operation(); await write.promise; return result; }, () => true, send);
    delivery.collect([{ ...visit, ...latest() }], posts.checkpoint.entries); delivery.kick(); await flush();
    delivery.clear(); write.resolve(); await flush(); expect(send).not.toHaveBeenCalled();
  });
  it('keeps retry-wait deadlines across restart and never resets attempts without explicit retry', async () => {
    const { delivery, send, posts, collect } = setup(); send.mockRejectedValue(new VisitApiError('network', '유실', true));
    collect(); delivery.kick(); await flush();
    const saved = structuredClone(delivery.checkpoint), replay = vi.fn().mockRejectedValue(new VisitApiError('network', '유실', true));
    delivery.clear();
    const restored = new BehaviorDelivery(serial(), () => true, replay); restored.restore(saved, posts.checkpoint.entries); restored.kick(); await flush();
    expect(replay).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(replay).toHaveBeenCalledTimes(1); expect(restored.status().visits[0].attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(replay).toHaveBeenCalledTimes(2); expect(restored.status().visits[0]).toMatchObject({ phase: 'failed', attempts: 3 });
    const failed = new BehaviorDelivery(serial(), () => true, replay); failed.restore(structuredClone(restored.checkpoint), posts.checkpoint.entries); failed.kick(); await flush();
    expect(replay).toHaveBeenCalledTimes(2); expect(failed.hasUnconfirmed()).toBe(true);
  });
  it('rechecks POST/session permission after the checkpoint write', async () => {
    const { posts, visit } = setup(), write = gate<void>(), send = vi.fn(); let allowed = true;
    const delivery = new BehaviorDelivery(async operation => { const result = operation(); await write.promise; return result; }, () => allowed, send);
    delivery.collect([{ ...visit, ...latest() }], posts.checkpoint.entries); delivery.kick(); await flush(); allowed = false; write.resolve(); await flush();
    expect(send).not.toHaveBeenCalled(); expect(delivery.status().visits[0]).toMatchObject({ phase: 'queued', request: latest() });
  });
  it('exposes copies of latest/ACK/request so status consumers cannot mutate checkpoints', async () => {
    const { delivery, collect } = setup(); collect();
    const status = delivery.status(); status.visits[0].latest.activeDurationMs = 99999; status.visits[0].ack!.behaviorVersion = 999;
    expect(delivery.status().visits[0]).toMatchObject({ latest: latest(), ack: { behaviorVersion: 1 } });
  });
  it('marks an ACK checkpoint write failure unconfirmed rather than claiming completion', async () => {
    const { posts, visit } = setup(); let mutations = 0;
    const delivery = new BehaviorDelivery(async operation => { const result = operation(); if (++mutations === 2) throw Error('PRIVATE_STORAGE'); return result; }, () => true,
      async (_s, id, value) => ack(id, value));
    delivery.collect([{ ...visit, ...latest() }], posts.checkpoint.entries); delivery.kick(); await flush();
    expect(delivery.hasUnconfirmed()).toBe(true); expect(delivery.status().blocked).toContain('저장하지 못했습니다');
  });

});

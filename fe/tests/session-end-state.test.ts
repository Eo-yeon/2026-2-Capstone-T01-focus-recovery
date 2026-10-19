import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { API_BASE_URL } from '../src/api/client';
import { DurableRepository, validateState, type DurableState } from '../src/background/durable-state';
import { emptyState } from '../src/background/collector';
import { serverSession, SERVER_SESSION_ID } from './session-fixture';
const session = { ...serverSession(), sessionId: SERVER_SESSION_ID };
function fixture(): DurableState {
  return structuredClone({ collection: emptyState(), activeSession: { ...session, source: 'server', startRequest: { apiBaseUrl: API_BASE_URL, idempotencyKey: crypto.randomUUID(), goalText: session.goalText, response: session } },
    sessionEnd: { apiBaseUrl: API_BASE_URL, session, requestedAt: '2026-10-19T00:00:00.000Z', attempts: 0, phase: 'draining' } } as DurableState);
}
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
describe('v1 session end aggregate validation', () => {
  it.each([
    ['phase', (v: any) => v.sessionEnd.phase = 'ENDED'], ['session', (v: any) => v.sessionEnd.session.sessionId = crypto.randomUUID()],
    ['goal', (v: any) => v.sessionEnd.session.goalText = '다른 종료 목표'], ['time', (v: any) => v.sessionEnd.requestedAt = 'bad'],
    ['receipt', (v: any) => delete v.activeSession.startRequest], ['receipt response', (v: any) => v.activeSession.startRequest.response.sessionId = crypto.randomUUID()],
    ['active collection', (v: any) => v.collection.session = { ...session, source: 'server' }], ['attempts', (v: any) => v.sessionEnd.attempts = 4],
    ['negative attempts', (v: any) => v.sessionEnd.attempts = -1], ['fractional attempts', (v: any) => v.sessionEnd.attempts = 1.2],
    ['retry time', (v: any) => Object.assign(v.sessionEnd, { phase: 'retry-wait', attempts: 1, retryable: true })],
    ['sending attempts', (v: any) => Object.assign(v.sessionEnd, { phase: 'sending', request: {} })],
    ['unfrozen queued', (v: any) => v.sessionEnd.phase = 'queued'], ['mutable DTO', (v: any) => v.sessionEnd.request = { finalBehaviors: [] }],
    ['false ACK', (v: any) => v.sessionEnd.ack = { ...session, status: 'ENDED', endedAt: '2026-10-19T00:00:00.000Z' }],
    ['bad last server', (v: any) => v.sessionEnd.lastServer = { ...session, startedAt: 'bad' }],
    ['lost immutable snapshot', (v: any) => Object.assign(v.sessionEnd, { phase: 'sending', attempts: 1 })],
    ['error payload', (v: any) => v.sessionEnd.error = { message: 'PRIVATE' }],
    ['raw error code', (v: any) => v.sessionEnd.code = 'https://private.example.com'],
    ['server origin', (v: any) => v.sessionEnd.apiBaseUrl = 'https://other.example.com'],
  ])('rejects %s corruption without changing existing disk state', async (_name, corrupt) => {
    const repo = new DurableRepository(); await repo.initialize({}); const original = fixture(); await repo.save(original);
    const broken = structuredClone(original); corrupt(broken);
    await expect(repo.save(broken)).rejects.toBeDefined();
    const fresh = new DurableRepository(); expect((await fresh.initialize({})).value).toEqual(original); await fresh.close(); await repo.close();
  });
  it('rejects stale END writes after explicit deletion by revision', async () => {
    const first = new DurableRepository(), old = new DurableRepository();
    await first.initialize(fixture()); await old.initialize({}); await first.save({ collection: emptyState() });
    await expect(old.save(fixture())).rejects.toBeDefined(); const fresh = new DurableRepository();
    expect((await fresh.initialize({})).value.sessionEnd).toBeUndefined(); await first.close(); await old.close(); await fresh.close();
  });
  it('allows a correctly matched durable ENDED ACK and preserves the historical creation receipt', () => {
    const value = fixture(), ack = { ...session, status: 'ENDED' as const, endedAt: '2026-10-19T00:00:00.000Z' };
    Object.assign(value.sessionEnd!, { phase: 'acked', request: {}, attempts: 1, ack, lastServer: ack });
    expect(() => validateState(value)).not.toThrow();
  });
});

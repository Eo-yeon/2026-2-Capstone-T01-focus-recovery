import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSession, getSession, SessionEndError } from '../src/api/session-end';
import { REQUEST_TIMEOUT_MS } from '../src/api/client';
import { serverSession, SERVER_SESSION_ID } from './session-fixture';
const session = { ...serverSession(), sessionId: SERVER_SESSION_ID };
const ended = { ...session, status: 'ENDED' as const, endedAt: '2026-10-19T00:00:00.000Z' };
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ended)))));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('session end and lookup contract', () => {
  it('uses POST {}, GET and exact original identifiers without an idempotency header', async () => {
    expect(await endSession(session, {})).toEqual(ended); expect(await getSession(session)).toEqual(ended);
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
      [`http://localhost:8080/api/sessions/${session.sessionId}/end`, 'POST', '{}'],
      [`http://localhost:8080/api/sessions/${session.sessionId}`, 'GET', undefined],
    ]);
    expect((vi.mocked(fetch).mock.calls[0][1]?.headers as any)['Idempotency-Key']).toBeUndefined();
  });
  it.each([{}, { finalBehaviors: null }, { finalBehaviors: [] }, { finalBehaviors: [{ visitId: crypto.randomUUID(), activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 }] }])('supports optional finalBehaviors %j', async body => {
    await endSession(session, body); expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual(body);
  });
  it.each([400, 404, 409, 401, 403, 408, 429, 500, 503])('classifies HTTP %s without exposing error text', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: status === 404 ? 'SESSION_NOT_FOUND' : 'PRIVATE_CODE', message: 'PRIVATE_URL_GOAL' }), { status }));
    const error = await endSession(session, {}).catch(e => e);
    expect(error).toBeInstanceOf(SessionEndError); expect(error.retryable).toBe(status >= 500 || [408, 429].includes(status));
    expect(error.status).toBe(status); expect(error.code).toBe(status === 404 ? 'SESSION_NOT_FOUND' : undefined);
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });
  it.each([
    { sessionId: crypto.randomUUID() }, { goalText: '다른 세션 목표입니다' }, { startedAt: '2000-01-01T00:00:00.000Z' },
    { status: 'ACTIVE', endedAt: null }, { endedAt: null }, { endedAt: '2026-02-30T00:00:00.000Z' },
    { endedAt: '2026-10-19T00:00:00Z' }, { endedAt: '1969-01-01T00:00:00.000Z' },
  ])('rejects malformed ENDED response %j', async change => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...ended, ...change })));
    await expect(endSession(session, {})).rejects.toMatchObject({ kind: 'response', retryable: false });
  });
  it.each(['not-uuid', '../other/end', '1-1-1-1-1'])('rejects UUID path before HTTP: %s', async sessionId => {
    await expect(endSession({ ...session, sessionId }, {})).rejects.toMatchObject({ retryable: false }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ finalBehaviors: [{}] }, { finalBehaviors: 'bad' }, { extra: true }, { finalBehaviors: [{ visitId: SERVER_SESSION_ID, activeDurationMs: -1, tabSwitchCount: 0, behaviorVersion: 0 }] }])('rejects unsafe snapshot %j', async body => {
    await expect(endSession(session, body as any)).rejects.toMatchObject({ retryable: false }); expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies unreadable success JSON as uncertain and retryable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('PRIVATE_BAD_JSON'));
    await expect(endSession(session, {})).rejects.toMatchObject({ kind: 'response', retryable: true });
  });
  it('classifies network errors and never exposes their raw text', async () => {
    vi.mocked(fetch).mockRejectedValue(Error('PRIVATE_NETWORK_URL'));
    await expect(endSession(session, {})).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
  it('times out even if fetch ignores abort', async () => {
    vi.useFakeTimers(); vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const pending = expect(endSession(session, {})).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); await pending;
  });
  it('allows ACTIVE only on lookup', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(session))); expect(await getSession(session)).toEqual(session);
  });
});

it('freezes both expected session and final behavior snapshots before HTTP', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const original = { ...session }, body = { finalBehaviors: [{ visitId: SERVER_SESSION_ID, activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 }] };
  const request = endSession(original, body); original.goalText = '변경된 목표입니다'; body.finalBehaviors[0].activeDurationMs = 9999;
  release(new Response(JSON.stringify(ended))); await expect(request).resolves.toEqual(ended);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).finalBehaviors[0].activeDurationMs).toBe(1000);
});

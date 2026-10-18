import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateVisitBehavior } from '../src/api/behavior';
import { REQUEST_TIMEOUT_MS } from '../src/api/client';
import { pageVisit } from './visit-fixture';
const visit = pageVisit();
const request = { activeDurationMs: 8000, tabSwitchCount: 1, behaviorVersion: 3 };
const response = (overrides = {}) => ({ visitId: visit.visitId, ...request, updatedAt: '2026-10-18T10:00:00.000Z', applied: true, ...overrides });
const call = () => updateVisitBehavior(visit.sessionId, visit.visitId, request);
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response()), { status: 200 }))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('behavior PATCH contract', () => {
  it('sends only cumulative DTO fields with IDs in the path and no session idempotency key', async () => {
    expect(await updateVisitBehavior(visit.sessionId, visit.visitId, { ...visit, ...request })).toEqual(response());
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain(`/api/sessions/${visit.sessionId}/visits/${visit.visitId}/behavior`);
    expect(init).toMatchObject({ method: 'PATCH', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual(request);
  });
  it.each([
    { applied: true }, { applied: false }, { applied: false, updatedAt: null },
    { applied: false, behaviorVersion: 5, activeDurationMs: 12000, tabSwitchCount: 2 },
    { applied: false, behaviorVersion: 5 },
    { applied: false, behaviorVersion: 5, updatedAt: null },
  ])('accepts exact or monotonically superseding server state: %j', async overrides => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(response(overrides)), { status: 200 }));
    expect(await call()).toEqual(response(overrides));
  });
  for (const key of ['visitId', 'activeDurationMs', 'tabSwitchCount', 'behaviorVersion', 'updatedAt', 'applied']) {
    it(`rejects missing ${key}`, async () => {
      const body: Record<string, unknown> = response(); delete body[key];
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body)));
      await expect(call()).rejects.toMatchObject({ kind: 'response', retryable: false });
    });
  }
  it.each([
    { applied: true, updatedAt: null },
    { updatedAt: '2026-10-18T10:00:00Z' }, { updatedAt: '2026-10-18T10:00:00.1Z' },
    { updatedAt: '2026-10-18T10:00:00.0000Z' }, { updatedAt: '2026-10-18T10:00:00.000+00:00' },
    { updatedAt: '2026-13-18T10:00:00.000Z' },
    { visitId: 'foreign-id' }, { applied: 'true' }, { updatedAt: '2026-10-18T10:00:00+09:00' }, { updatedAt: '2026-02-30T10:00:00.000Z' },
    { activeDurationMs: '8000' }, { tabSwitchCount: -1 }, { tabSwitchCount: 2147483648 }, { behaviorVersion: 1.5 }, { behaviorVersion: Number.MAX_SAFE_INTEGER + 1 },
    { applied: true, behaviorVersion: 4 }, { applied: true, activeDurationMs: 9000 }, { applied: true, tabSwitchCount: 2 },
    { applied: false, behaviorVersion: 2 }, { applied: false, activeDurationMs: 9000 }, { applied: false, tabSwitchCount: 2 },
    { applied: false, behaviorVersion: 5, activeDurationMs: 7000 }, { applied: false, behaviorVersion: 5, tabSwitchCount: 0 },
  ])('does not ACK inconsistent responses: %j', async overrides => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(response(overrides))));
    await expect(call()).rejects.toMatchObject({ kind: 'response', retryable: false });
  });
  it.each([
    [400, 'INVALID_REQUEST'], [404, 'SESSION_NOT_FOUND'], [404, 'VISIT_NOT_FOUND'],
    [409, 'BEHAVIOR_VERSION_CONFLICT'], [409, 'BEHAVIOR_COUNTER_DECREASED'], [409, 'SESSION_ENDED'],
  ])('preserves terminal %i %s without leaking server messages', async (status, code) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code, message: 'PRIVATE_BODY' }), { status }));
    await expect(call()).rejects.toMatchObject({ kind: 'http', status, code, retryable: false });
    await expect(call()).rejects.not.toHaveProperty('message', expect.stringContaining('PRIVATE_BODY'));
  });
  it.each([408, 429, 500, 502, 503])('allows retry of transient HTTP %i even without JSON', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response('invalid json', { status }));
    await expect(call()).rejects.toMatchObject({ status, retryable: true });
  });
  it('rejects a non-contract successful status', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(response()), { status: 201 }));
    await expect(call()).rejects.toMatchObject({ kind: 'http', retryable: false });
  });
  it('can replay after malformed JSON without falsely ACKing', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{'));
    await expect(call()).rejects.toMatchObject({ kind: 'response', retryable: true });
  });
  it('sanitizes network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('PRIVATE_URL'));
    await expect(call()).rejects.toMatchObject({ kind: 'network', retryable: true });
    await expect(call()).rejects.not.toHaveProperty('message', expect.stringContaining('PRIVATE_URL'));
  });
  it.each(['fetch', 'body'])('times out during %s and aborts the same request', async stage => {
    vi.mocked(fetch).mockImplementation(async () => stage === 'fetch' ? new Promise(() => {}) : { status: 200, json: () => new Promise(() => {}) } as Response);
    const pending = expect(call()).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); await pending;
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it.each([{ activeDurationMs: -1 }, { tabSwitchCount: 1.2 }, { behaviorVersion: null }, { tabSwitchCount: 2147483648 }])('refuses invalid input without generating corrected values: %j', async overrides => {
    await expect(updateVisitBehavior(visit.sessionId, visit.visitId, { ...request, ...overrides } as typeof request)).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

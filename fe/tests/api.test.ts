import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, ApiError, REQUEST_TIMEOUT_MS } from '../src/api/client';
import { createSession } from '../src/api/session';
import { normalizeGoal, validGoal } from '../src/shared/goal';
import { SERVER_SESSION_ID, serverSession } from './session-fixture';

const goalText = '공개 문서 조사하기';
const key = '5f67ccbd-d16f-4d3b-a59b-a7a10b673302';
let payload: ReturnType<typeof serverSession>;
const send = () => createSession({ goalText }, key);
beforeEach(() => {
  payload = { ...serverSession(goalText), sessionId: SERVER_SESSION_ID };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 201 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('session API boundary', () => {
  it('accepts 201 and sends JSON and the idempotency key without credentials', async () => {
    await expect(send()).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith(`${API_BASE_URL}/api/sessions`, expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ goalText }), credentials: 'omit', redirect: 'error',
    }));
  });
  it('sanitizes network failures', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('PRIVATE_SERVER_DATA'));
    await expect(send()).rejects.toMatchObject({ kind: 'network' });
    await expect(send()).rejects.not.toThrow('PRIVATE_SERVER_DATA');
  });
  it.each([400, 422, 401, 500, 503])('maps HTTP %i without exposing server text', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response('PRIVATE_SERVER_DATA', { status }));
    await expect(send()).rejects.toMatchObject({ kind: 'http', status });
    await expect(send()).rejects.not.toThrow('PRIVATE_SERVER_DATA');
  });
  it.each(['fetch', 'body'])('times out during %s and aborts the request', async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      if (stage === 'fetch') return new Promise(() => undefined);
      return { status: 201, ok: true, json: () => new Promise(() => undefined) } as unknown as Response;
    });
    const result = send().catch(error => error as ApiError);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await result).toMatchObject({ kind: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{', { status: 201 }));
    await expect(send()).rejects.toMatchObject({ kind: 'response' });
  });
  it('rejects an unexpected successful HTTP status', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    await expect(send()).rejects.toMatchObject({ kind: 'response' });
  });
  it.each(['sessionId', 'goalText', 'startedAt', 'status', 'endedAt'])('rejects a missing %s', async field => {
    delete (payload as unknown as Record<string, unknown>)[field];
    await expect(send()).rejects.toMatchObject({ kind: 'response' });
  });
  it.each([
    { sessionId: '1-1-1-1-1' }, { sessionId: 1 }, { status: 'UNKNOWN' }, { goalText: '다른 작업 목표' },
    { goalText: ` ${goalText}` }, { startedAt: 'yesterday' }, { startedAt: '2026-02-30T00:00:00.000Z' },
    { endedAt: '2026-01-01T00:00:00.000Z' },
  ])('rejects invalid fields %j', async fields => {
    Object.assign(payload, fields);
    await expect(send()).rejects.toMatchObject({ kind: 'response' });
  });
  it('recognizes an ENDED replay for the background to refuse activation', async () => {
    payload.status = 'ENDED'; payload.endedAt = '2026-10-16T00:00:00.000Z';
    await expect(send()).resolves.toMatchObject({ status: 'ENDED' });
  });
});
describe('BE String.strip compatibility', () => {
  it('strips Java whitespace, preserves NBSP/BOM, and counts UTF-16 units', () => {
    expect(normalizeGoal(`\u001c\u3000${goalText}\u2005\n`)).toBe(goalText);
    expect(normalizeGoal('\u00a0목표\ufeff')).toBe('\u00a0목표\ufeff');
    expect(validGoal(' \n12345\u3000')).toBe(true);
    expect(validGoal('x'.repeat(150))).toBe(true);
    expect(validGoal('x'.repeat(151))).toBe(false);
    expect(validGoal('😀'.repeat(76))).toBe(false);
  });
});

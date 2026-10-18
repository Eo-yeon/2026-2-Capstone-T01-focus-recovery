import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePageVisit, visitRequest } from '../src/api/visit';
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from '../src/api/client';
import { pageVisit } from './visit-fixture';
let visit = pageVisit();
beforeEach(() => {
  visit = pageVisit();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...visit, updatedAt: null }), { status: 201 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('visit API contract', () => {
  it.each([201, 200])('validates HTTP %i and maps only DTO fields without a session creation key', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...visit, updatedAt: null }), { status }));
    await expect(savePageVisit(visit)).resolves.toMatchObject(visit);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/api/sessions/${visit.sessionId}/visits`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const { sessionId: _, ...request } = visit;
    expect(JSON.parse(init!.body as string)).toEqual(request);
    expect(visitRequest(visit)).toEqual(request);
  });
  it('preserves original search text, URL path casing, content and milliseconds', async () => {
    Object.assign(visit, { normalizedUrl: 'https://example.com/Docs/JWT', searchQuery: '스프링 + JWT', isSearchResultPage: true, content: '공개 본문😀'.repeat(20) });
    await savePageVisit(visit);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual(visitRequest(visit));
  });
  it('accepts replayed behavior updated on the server', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...visit, activeDurationMs: 3000, tabSwitchCount: 1, behaviorVersion: 3, updatedAt: '2026-10-18T02:00:00.000Z' }), { status: 200 }));
    await expect(savePageVisit(visit)).resolves.toMatchObject({ behaviorVersion: 3 });
  });
  it.each(['visitId', 'sessionId', 'sequence', 'browserTabKey', 'normalizedUrl', 'domain', 'title', 'content', 'searchQuery', 'isSearchResultPage', 'visitedAt', 'activeDurationMs', 'tabSwitchCount', 'behaviorVersion', 'updatedAt'])('rejects missing %s in a successful response', async field => {
    const response: Record<string, unknown> = { ...visit, updatedAt: null }; delete response[field];
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(response), { status: 201 }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ kind: 'response', retryable: false });
  });
  it.each(['visitId', 'sessionId', 'sequence', 'browserTabKey', 'normalizedUrl', 'domain', 'title', 'content', 'searchQuery', 'isSearchResultPage', 'visitedAt'])('rejects a mismatched original %s even on replay', async field => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...visit, [field]: 'DIFFERENT', updatedAt: null }), { status: 200 }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ kind: 'response', retryable: false });
  });
  it.each([201, 200])('rejects unsafe or decreased behavior on %i', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...visit, activeDurationMs: 999, updatedAt: null }), { status }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ kind: 'response' });
  });
  it.each(['SESSION_ENDED', 'VISIT_ID_CONFLICT', 'VISIT_SEQUENCE_CONFLICT', 'VISIT_SEQUENCE_OUT_OF_ORDER'])('retains 409 code %s without exposing server messages', async code => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code, message: 'PRIVATE_DATA', fieldErrors: [{ message: 'PRIVATE_DATA' }] }), { status: 409 }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ status: 409, code, retryable: false });
    await expect(savePageVisit(visit)).rejects.not.toThrow('PRIVATE_DATA');
  });
  it.each([400, 404, 401, 403, 204])('stops on HTTP %i', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response(status === 204 ? null : 'PRIVATE_DATA', { status }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ status, retryable: false });
  });
  it.each([500, 503, 408, 429])('allows bounded retry on HTTP %i', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ status, retryable: true });
  });
  it('retains retry eligibility when JSON is unreadable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{', { status: 201 }));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ kind: 'response', retryable: true });
  });
  it('sanitizes network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('PRIVATE_DATA'));
    await expect(savePageVisit(visit)).rejects.toMatchObject({ kind: 'network', retryable: true });
    await expect(savePageVisit(visit)).rejects.not.toThrow('PRIVATE_DATA');
  });
  it.each(['fetch', 'body'])('times out and aborts during %s', async stage => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return stage === 'fetch' ? new Promise(() => undefined) : { status: 201, json: () => new Promise(() => undefined) } as unknown as Response;
    });
    const outcome = savePageVisit(visit).catch(error => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ kind: 'timeout', retryable: true });
    expect(signal?.aborted).toBe(true);
  });
  it('rejects noncanonical request time before sending', async () => {
    visit.visitedAt = '2026-10-18T01:23:45Z';
    await expect(savePageVisit(visit)).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Unicode payload preservation at the visit API boundary', () => {
  it.each([
    ['Korean', '가'.repeat(5000), 5000, 5000, 201],
    ['English', 'a'.repeat(5000), 5000, 5000, 201],
    ['non-BMP within UTF-16 limit', '😀'.repeat(2500), 2500, 5000, 201],
    ['non-BMP above UTF-16 limit', '😀'.repeat(2501), 2501, 5002, 400],
  ] as const)('preserves %s without truncating for server validation', async (_label, content, points, units, status) => {
    visit.content = content;
    expect([...visit.content]).toHaveLength(points); expect(visit.content).toHaveLength(units);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(status === 400 ? { code: 'INVALID_REQUEST' } : { ...visit, updatedAt: null }), { status }));
    if (status === 400) await expect(savePageVisit(visit)).rejects.toMatchObject({ status: 400, retryable: false });
    else await expect(savePageVisit(visit)).resolves.toMatchObject({ content });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).content).toBe(content);
    expect(visit.content).toBe(content);
  });
});

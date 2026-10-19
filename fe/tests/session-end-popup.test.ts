// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevStatus } from '../src/shared/types';
let root: { unmount(): void } | undefined;
let status: DevStatus;
function button(name: string) { return [...document.querySelectorAll('button')].find(b => b.textContent === name)!; }
async function render() {
  await import('../src/popup/index');
  await vi.waitFor(() => expect(document.body.textContent).toContain('END_PENDING'));
}
beforeEach(async () => {
  vi.resetModules(); document.body.innerHTML = '<div id="root"></div>';
  vi.doMock('react-dom/client', async () => {
    const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
    return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { root = actual.createRoot(...args); return root; } };
  });
  status = { session: null, candidates: [], visits: [], readyVisits: [], capacityReached: false,
    storage: { phase: 'ready', recovered: true }, sessionStartRecovery: { kind: 'none' },
    visitDelivery: { visits: [{ visitId: 'synthetic-post', sequence: 1, phase: 'failed', attempts: 1, code: 'SESSION_ENDED', retryable: false }] },
    behaviorDelivery: { visits: [{ visitId: 'synthetic-patch', sequence: 1, phase: 'failed', attempts: 1, latest: { activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 }, retryable: false }] },
    sessionEnd: { apiBaseUrl: 'http://localhost:8080', state: 'END_PENDING', sessionId: 'synthetic-session', requestedAt: '2026-10-19T00:00:00.000Z', phase: 'failed', attempts: 1, retryable: false, code: 'SERVER_ENDED_UNCONFIRMED' },
  };
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, status })) } });
});
afterEach(() => { root?.unmount(); root = undefined; vi.restoreAllMocks(); });
describe('review C: Popup server/local conflict', () => {
  it('names the operator conflict and explains preserved counts and permanent deletion loss', async () => {
    await render(); const text = document.body.textContent!;
    expect(text).toContain('서버 종료·로컬 데이터 불일치 (운영자 확인 필요)');
    expect(text).toContain('필수 POST 미확인 1건 / PATCH 미확인 1건');
    expect(text).toContain('로컬 기록을 보존'); expect(text).toContain('서버 상태를 확인');
    expect(text).toContain('영구적으로 잃');
    expect(button('같은 종료 요청 재시도').disabled).toBe(true); expect(button('작업 세션 시작').disabled).toBe(true);
    expect(text).not.toContain('종료 ACK 저장 완료');
  });
  it('keeps ordinary retryable network exhaustion distinct and its retry button enabled', async () => {
    status.visitDelivery!.visits = []; status.behaviorDelivery!.visits = [];
    Object.assign(status.sessionEnd!, { phase: 'failed', attempts: 3, retryable: true, code: undefined, error: '서버에 연결할 수 없습니다.' });
    await render(); expect(button('같은 종료 요청 재시도').disabled).toBe(false);
    expect(document.body.textContent).not.toContain('서버 종료·로컬 데이터 불일치');
  });
  it('shows SESSION_ENDED evidence during lookup without enabling another END request', async () => {
    Object.assign(status.sessionEnd!, { phase: 'sending', code: undefined, retryable: undefined });
    await render(); expect(document.body.textContent).toContain('서버 종료·로컬 데이터 불일치 (운영자 확인 필요)');
    expect(button('같은 종료 요청 재시도').disabled).toBe(true);
  });
});

it('keeps a confirmed server ENDED conflict non-retryable even if an older retryable flag remains', async () => {
  status.sessionEnd!.lastServer = { sessionId: status.sessionEnd!.sessionId, goalText: '합성 종료 상태 확인', startedAt: '2026-10-18T00:00:00.000Z', status: 'ENDED', endedAt: '2026-10-19T00:00:00.000Z' };
  status.sessionEnd!.code = undefined; status.sessionEnd!.retryable = true;
  await render(); expect(button('같은 종료 요청 재시도').disabled).toBe(true);
  expect(document.body.textContent).toContain('서버 종료·로컬 데이터 불일치 (운영자 확인 필요)');
});
it('shows ordinary network retry-wait without suggesting an operator conflict', async () => {
  status.visitDelivery!.visits = []; status.behaviorDelivery!.visits = [];
  Object.assign(status.sessionEnd!, { phase: 'retry-wait', retryable: true, nextRetryAt: 20000, code: undefined });
  await render(); expect(document.body.textContent).toContain('재시도 대기');
  expect(document.body.textContent).not.toContain('서버 종료·로컬 데이터 불일치');
  expect(button('같은 종료 요청 재시도').disabled).toBe(true);
});

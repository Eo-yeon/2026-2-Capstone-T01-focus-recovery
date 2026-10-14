// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const card = '<div data-block-id="web/prs_template_v2_web_basic_desk.ts"><a href="https://example.com/docs"><span class="sds-comps-text-type-headline1">인증</span></a></div>';
let messages: any[];
let listeners: ((message: any, sender: any) => void)[];
let allowed: boolean;
async function tick(ms = 0) { await vi.advanceTimersByTimeAsync(ms); }
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); messages = []; listeners = []; allowed = true;
  delete (globalThis as any).__focusRecoveryCollector;
  document.body.innerHTML = '<form id="nx_search_form" role="search" action="https://search.naver.com/search.naver"><input name="query" value="PRIVATE_INPUT"></form><div id="main_pack"></div>';
  document.title = '공개 검색';
  vi.stubGlobal('location', new URL('https://search.naver.com/search.naver?query=JWT'));
  vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage: vi.fn(async (message: any) => { messages.push(message); return { ok: true, sessionId: allowed ? 'session' : null }; }), onMessage: { addListener: (listener: any) => listeners.push(listener) } } });
  // Browser crypto.subtle is not supplied by jsdom.
  vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } });
});
afterEach(async () => {
  allowed = false; listeners[0]?.({ type: 'session-changed' }, { id: 'extension' }); await tick();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (globalThis as any).__focusRecoveryCollector;
});
describe('search Content Script asynchronous lifecycle', () => {
  it('sends a waiting snapshot then uses MutationObserver to capture delayed organic results', async () => {
    await import('../src/content/index'); await tick();
    expect(messages.filter(m => m.type === 'snapshot')[0]).toMatchObject({ snapshot: null, reason: undefined });
    document.querySelector('#main_pack')!.innerHTML = card; await tick(1500);
    const snapshot = messages.find(m => m.snapshot)?.snapshot;
    expect(snapshot).toMatchObject({ searchQuery: 'JWT', organicResultCount: 1, isSearchResultPage: true });
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_INPUT');
  });
  it('times out without inventing results and recovers on a later DOM event', async () => {
    await import('../src/content/index'); await tick(8100);
    expect(messages.filter(m => m.type === 'snapshot').at(-1)).toMatchObject({ snapshot: null, reason: 'unavailable-content' });
    document.querySelector('#main_pack')!.innerHTML = card; await tick(1500);
    expect(messages.find(m => m.snapshot)?.snapshot.organicResultCount).toBe(1);
  });
  it('does not observe or send page data without an authorized active context', async () => {
    allowed = false;
    await import('../src/content/index'); await tick();
    document.querySelector('#main_pack')!.innerHTML = card; await tick(10000);
    expect(messages.every(m => m.type === 'context')).toBe(true);
  });
});

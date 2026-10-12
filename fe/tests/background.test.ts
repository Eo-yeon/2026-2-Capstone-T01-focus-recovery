import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeUrl } from '../src/shared/url';
import type { Reply } from '../src/shared/types';
function chromeEvent() {
  const listeners: ((...args: any[]) => unknown)[] = [];
  return { listeners, addListener: (listener: (...args: any[]) => unknown) => listeners.push(listener) };
}
let api: any;
let local: Record<string, any>;
let memory: Record<string, any>;
const extensionId = 'test-extension';
const popupSender = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
const pageSender = { id: extensionId, url: 'https://example.com/docs', tab: { id: 1 }, frameId: 0, documentId: 'document1', documentLifecycle: 'active' };
let frame: { documentId: string; url: string };
function area(data: Record<string, any>) {
  return {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (value: any) => { Object.assign(data, structuredClone(value)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
    setAccessLevel: vi.fn(async () => undefined),
  };
}
async function message(payload: unknown, sender = popupSender): Promise<Reply> {
  return new Promise(resolve => {
    const accepted = api.runtime.onMessage.listeners[0](payload, sender, resolve);
    if (!accepted) resolve({ ok: false, error: 'ignored' });
  });
}
beforeEach(async () => {
  vi.resetModules();
  local = {}; memory = {};
  frame = { documentId: 'document1', url: 'https://example.com/docs' };
  api = {
    runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: chromeEvent() },
    storage: { local: area(local), session: area(memory) },
    windows: { getAll: vi.fn(async () => [{ id: 1, focused: true, state: 'normal' }]), onFocusChanged: chromeEvent(), onBoundsChanged: chromeEvent() },
    tabs: { query: vi.fn(async () => [{ id: 1 }]), sendMessage: vi.fn(async () => undefined), onActivated: chromeEvent(), onRemoved: chromeEvent() },
    permissions: { contains: vi.fn(async () => true), getAll: vi.fn(async () => ({ origins: ['https://example.com/*'] })), onAdded: chromeEvent(), onRemoved: chromeEvent() },
    scripting: { getRegisteredContentScripts: vi.fn(async () => []), unregisterContentScripts: vi.fn(async () => undefined), registerContentScripts: vi.fn(async () => undefined), executeScript: vi.fn(async () => undefined) },
    webNavigation: { getFrame: vi.fn(async () => frame), onCommitted: chromeEvent(), onHistoryStateUpdated: chromeEvent(), onErrorOccurred: chromeEvent() },
  };
  vi.stubGlobal('chrome', api);
  await import('../src/background/index');
});
describe('background Chrome adapter', () => {
  it('communicates only during a session, starts on existing permitted tabs, and stops late snapshots', async () => {
    expect(await message({ type: 'context' }, pageSender)).toMatchObject({ ok: true, sessionId: null });
    const started = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    const id = started.status!.session!.sessionId;
    expect(local.activeSession.sessionId).toBe(id);
    expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ matches: ['https://example.com/*'], allFrames: false })]);
    expect(await message({ type: 'context' }, pageSender)).toMatchObject({ sessionId: id });
    const snapshot = { ...await describeUrl(frame.url), title: '공개 문서', content: '공개 기술 문서의 의미 있는 본문입니다. '.repeat(5) };
    expect(await message({ type: 'snapshot', sessionId: id, snapshot }, pageSender)).toMatchObject({ ok: true });
    expect(memory.collection.candidates[0].snapshot.content).toBe(snapshot.content);
    await message({ type: 'stop' });
    expect(local.activeSession).toBeUndefined();
    expect(await message({ type: 'snapshot', sessionId: id, snapshot }, pageSender)).toMatchObject({ sessionId: null });
    expect((await message({ type: 'status' })).status?.candidates).toHaveLength(1);
  });
  it('preserves a session on duplicate start and rejects content-script session control', async () => {
    const first = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    expect((await message({ type: 'start', goalText: '중복 세션 시작하기' })).ok).toBe(false);
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(first.status?.session?.sessionId);
    expect((await message({ type: 'stop' }, pageSender)).error).toBe('ignored');
  });
  it('allows the exact extension popup URL when opened in a browser tab', async () => {
    const reply = await message({ type: 'status' }, { ...popupSender, tab: { id: 99 } } as typeof popupSender);
    expect(reply.ok).toBe(true);
  });
  it('fails closed on checkpoint storage failure and can handle the next command', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' });
    api.storage.session.set.mockRejectedValueOnce(new Error('synthetic failure'));
    expect((await message({ type: 'context' }, pageSender)).ok).toBe(false);
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await message({ type: 'start', goalText: '새로운 작업 목표' })).ok).toBe(true);
  });
  it('ignores foreign extensions, child frames and inactive/BFCache documents', async () => {
    for (const sender of [{ ...pageSender, id: 'foreign' }, { ...pageSender, frameId: 1 }, { ...pageSender, documentLifecycle: 'cached' }]) {
      expect((await message({ type: 'context' }, sender)).error).toBe('ignored');
    }
  });
  it('validates normalized URL, identity and search flags against the browser-owned frame', async () => {
    const started = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    await message({ type: 'context' }, pageSender);
    const snapshot = { ...await describeUrl(frame.url), title: '문서', content: 'x'.repeat(50), normalizedUrl: 'https://evil.example/' };
    expect((await message({ type: 'snapshot', sessionId: started.status!.session!.sessionId, snapshot }, pageSender)).ok).toBe(false);
    expect(memory.collection.candidates[0].snapshot).toBeUndefined();
  });
  it('rechecks revoked origin permission and current document id before accepting data', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' });
    api.permissions.contains.mockResolvedValue(false);
    expect(await message({ type: 'context' }, pageSender)).toMatchObject({ sessionId: null });
    api.permissions.contains.mockResolvedValue(true); frame.documentId = 'other-document';
    expect(await message({ type: 'context' }, pageSender)).toMatchObject({ sessionId: null });
  });
  it('rehydrates a suspended worker from session storage, including sequence and ids', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' }); await message({ type: 'context' }, pageSender);
    const original = structuredClone(memory.collection);
    vi.resetModules(); api.runtime.onMessage.listeners.length = 0;
    await import('../src/background/index');
    const status = (await message({ type: 'status' })).status!;
    expect(status.session?.sessionId).toBe(original.session.sessionId);
    expect(status.candidates[0].visitId).toBe(original.candidates[0].visitId);
  });
  it('clears durable session metadata after browser restart and requires explicit start', async () => {
    local.activeSession = { sessionId: 'stale' };
    await message({ type: 'status' });
    expect(local.activeSession).toBeUndefined();
    expect(api.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(api.storage.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });
  it('routes history API changes to content script and erases records on permission removal', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' }); await message({ type: 'context' }, pageSender);
    api.webNavigation.onHistoryStateUpdated.listeners[0]({ frameId: 0, tabId: 1 });
    await message({ type: 'status' });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'capture' });
    api.permissions.onRemoved.listeners[0]({});
    const status = (await message({ type: 'status' })).status!;
    expect(status.session).toBeNull(); expect(status.candidates).toHaveLength(0);
  });
  it('deduplicates content registration and committed events for the same document', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' }); await message({ type: 'context' }, pageSender);
    api.webNavigation.onCommitted.listeners[0]({ frameId: 0, tabId: 1, documentId: 'document1', transitionType: 'link', url: frame.url });
    expect((await message({ type: 'status' })).status?.candidates).toHaveLength(1);
  });
});

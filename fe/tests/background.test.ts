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
let frame: { documentId: string; url: string; errorOccurred?: boolean };
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
  vi.restoreAllMocks();
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
  async function validVisit() {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    const start = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    const sessionId = start.status!.session!.sessionId;
    await message({ type: 'context' }, pageSender);
    clock.mockReturnValue(11000);
    const snapshot = { ...await describeUrl(frame.url), title: '공개 문서', content: '공개 문서의 의미 있는 본문입니다. '.repeat(5) };
    await message({ type: 'snapshot', sessionId, snapshot }, pageSender);
    expect(memory.collection.candidates[0].state).toBe('valid');
    return { sessionId, clock, snapshot, candidate: structuredClone(memory.collection.candidates[0]) };
  }
  it.each([undefined, 'documentB', 'document1'])('preserves A when B fails with error document id %s', async documentId => {
    const { sessionId, candidate } = await validVisit();
    frame.errorOccurred = true;
    api.webNavigation.onErrorOccurred.listeners[0]({ frameId: 0, tabId: 1, documentId, url: 'https://example.com/failed', error: 'net::ERR_FAILED' });
    const status = (await message({ type: 'status' })).status!;
    expect(status.session?.sessionId).toBe(sessionId);
    expect(memory.collection.candidates[0]).toEqual(candidate);
    expect(status.visits[0]).toMatchObject({ visitId: candidate.visitId, sequence: candidate.sequence, activeDurationMs: candidate.activeDurationMs, content: candidate.snapshot.content });
  });
  it('does not conflate failed query-based navigation with the current normalized URL', async () => {
    frame.url = 'https://example.com/docs?id=100';
    const { candidate } = await validVisit();
    frame.errorOccurred = true;
    api.webNavigation.onErrorOccurred.listeners[0]({ frameId: 0, tabId: 1, documentId: frame.documentId, url: 'https://example.com/docs?id=200' });
    await message({ type: 'status' });
    expect(memory.collection.candidates[0]).toEqual(candidate);
  });
  it('keeps the session and prior payload when getFrame fails, then processes the next valid event', async () => {
    const { sessionId, candidate } = await validVisit();
    api.webNavigation.getFrame.mockRejectedValueOnce(new Error('synthetic disappearing frame'));
    await message({ type: 'context' }, pageSender);
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(sessionId);
    expect(memory.collection.candidates[0]).toMatchObject({ visitId: candidate.visitId, state: 'valid', snapshot: candidate.snapshot, activeDurationMs: candidate.activeDurationMs });
    expect(await message({ type: 'context' }, pageSender)).toMatchObject({ ok: true, sessionId });
  });
  it.each(['windows', 'tabs'])('pauses uncertain foreground on %s query failure without ending the session', async target => {
    const { sessionId, candidate } = await validVisit();
    if (target === 'windows') api.windows.getAll.mockRejectedValueOnce(new Error('synthetic query failure'));
    else api.tabs.query.mockRejectedValueOnce(new Error('synthetic query failure'));
    api.tabs.onActivated.listeners[0]({ tabId: 1 });
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(sessionId);
    expect(memory.collection.foregroundTabId).toBeNull();
    expect(memory.collection.candidates[0].snapshot).toEqual(candidate.snapshot);
    api.tabs.onActivated.listeners[0]({ tabId: 1 });
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(sessionId);
    expect(memory.collection.foregroundTabId).toBe(1);
  });
  it('does not promote a failed current candidate and makes duplicate error events idempotent', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    const start = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    const sessionId = start.status!.session!.sessionId;
    await message({ type: 'context' }, pageSender);
    const snapshot = { ...await describeUrl(frame.url), title: '문서', content: 'x'.repeat(50) };
    await message({ type: 'snapshot', sessionId, snapshot }, pageSender);
    frame.errorOccurred = true;
    clock.mockReturnValue(12000);
    const error = { frameId: 0, tabId: 1, documentId: frame.documentId, url: frame.url, error: 'net::ERR_FAILED' };
    api.webNavigation.onErrorOccurred.listeners[0](error);
    let status = (await message({ type: 'status' })).status!;
    expect(status.session?.sessionId).toBe(sessionId);
    expect(status.visits).toHaveLength(0);
    expect(status.candidates[0]).toMatchObject({ state: 'excluded', reason: 'navigation-error' });
    expect(memory.collection.candidates[0].snapshot).toBeUndefined();
    const failed = structuredClone(memory.collection);
    clock.mockReturnValue(20000);
    api.webNavigation.onErrorOccurred.listeners[0](error);
    status = (await message({ type: 'status' })).status!;
    await message({ type: 'snapshot', sessionId, snapshot }, pageSender);
    expect(status.visits).toHaveLength(0);
    expect(memory.collection).toEqual(failed);
  });
  it.each(['different-document', 'different-url', 'healthy-frame'])('ignores an unconfirmed error when the live frame is %s', async condition => {
    const { candidate } = await validVisit();
    const url = frame.url;
    frame = condition === 'different-document' ? { ...frame, documentId: 'new-document', errorOccurred: true }
      : condition === 'different-url' ? { ...frame, url: 'https://example.com/other', errorOccurred: true }
        : { ...frame, errorOccurred: false };
    api.webNavigation.onErrorOccurred.listeners[0]({ frameId: 0, tabId: 1, documentId: 'document1', url });
    await message({ type: 'status' });
    expect(memory.collection.candidates[0]).toEqual(candidate);
  });
  it('blocks an error frame even when no error document id was available to the event handler', async () => {
    const { sessionId, candidate, snapshot, clock } = await validVisit();
    frame = { documentId: 'failed-document', url: 'https://example.com/failed', errorOccurred: true };
    api.webNavigation.onErrorOccurred.listeners[0]({ frameId: 0, tabId: 1, url: frame.url });
    const sender = { ...pageSender, documentId: frame.documentId, url: frame.url };
    expect(await message({ type: 'context' }, sender)).toMatchObject({ sessionId: null });
    expect(await message({ type: 'snapshot', sessionId, snapshot }, sender)).toMatchObject({ sessionId: null });
    clock.mockReturnValue(20000);
    expect((await message({ type: 'status' })).status?.visits).toHaveLength(1);
    expect(memory.collection.candidates[0]).toMatchObject({ visitId: candidate.visitId, state: 'valid', snapshot: candidate.snapshot, activeDurationMs: candidate.activeDurationMs });
    expect(memory.collection.candidates).toHaveLength(1);
  });
  it('handles a tab closing during getFrame without stopping collection in another tab', async () => {
    const { sessionId, candidate, snapshot, clock } = await validVisit();
    let rejectFrame!: (reason: Error) => void;
    let enteredFrame!: () => void;
    const entered = new Promise<void>(resolve => { enteredFrame = resolve; });
    api.webNavigation.getFrame.mockImplementationOnce(() => { enteredFrame(); return new Promise((_, reject) => { rejectFrame = reject; }); });
    const pending = message({ type: 'context' }, pageSender);
    await entered;
    api.tabs.onRemoved.listeners[0](1);
    rejectFrame(new Error('synthetic closed tab'));
    await pending;
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(sessionId);
    expect(memory.collection.tabs[1]).toBeUndefined();
    expect(memory.collection.candidates[0]).toMatchObject({ visitId: candidate.visitId, state: 'valid', snapshot: candidate.snapshot });
    frame = { documentId: 'document2', url: 'https://example.com/other' };
    api.tabs.query.mockResolvedValue([{ id: 2 }]);
    const other = { ...pageSender, tab: { id: 2 }, documentId: frame.documentId, url: frame.url };
    await message({ type: 'context' }, other);
    clock.mockReturnValue(12000);
    await message({ type: 'snapshot', sessionId, snapshot: { ...snapshot, ...await describeUrl(frame.url) } }, other);
    expect((await message({ type: 'status' })).status?.visits).toHaveLength(2);
  });
  it('isolates one tab error from another active visit', async () => {
    const { sessionId, candidate, snapshot } = await validVisit();
    frame = { documentId: 'document2', url: 'https://example.com/other' };
    const other = { ...pageSender, tab: { id: 2 }, documentId: frame.documentId, url: frame.url };
    await message({ type: 'context' }, other);
    frame.errorOccurred = true;
    api.webNavigation.onErrorOccurred.listeners[0]({ frameId: 0, tabId: 2, documentId: frame.documentId, url: frame.url });
    const status = (await message({ type: 'status' })).status!;
    expect(status.session?.sessionId).toBe(sessionId);
    expect(memory.collection.candidates[0]).toEqual(candidate);
    expect(status.candidates[1]).toMatchObject({ state: 'excluded', reason: 'navigation-error' });
    frame = { documentId: 'document1', url: pageSender.url };
    expect((await message({ type: 'snapshot', sessionId, snapshot }, pageSender)).ok).toBe(true);
  });
  it.each(['broadcast', 'injection'])('skips failed tabs.query during %s while keeping the local session', async phase => {
    api.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
    if (phase === 'broadcast') api.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
    api.tabs.query.mockRejectedValueOnce(new Error('synthetic query failure'));
    const start = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    expect(start.ok).toBe(true);
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBe(start.status?.session?.sessionId);
  });
  it('skips a committed event after a tab/frame has disappeared, preserving the previous visit', async () => {
    const { sessionId, candidate } = await validVisit();
    api.webNavigation.getFrame.mockRejectedValueOnce(new Error('synthetic closed frame'));
    api.webNavigation.onCommitted.listeners[0]({ frameId: 0, tabId: 1, documentId: 'new-document', transitionType: 'link', url: 'https://example.com/other' });
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(sessionId);
    expect(memory.collection.candidates).toHaveLength(1);
    expect(memory.collection.candidates[0]).toMatchObject({ visitId: candidate.visitId, snapshot: candidate.snapshot });
  });
  it('keeps unknown script configuration failures fatal', async () => {
    api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('synthetic unknown failure'));
    expect((await message({ type: 'start', goalText: '공개 문서 조사하기' })).ok).toBe(false);
    expect((await message({ type: 'status' })).status?.session).toBeNull();
  });
  it('fails closed if checkpoint loading fails and does not expose the exception message', async () => {
    vi.resetModules(); api.runtime.onMessage.listeners.length = 0;
    api.storage.session.get.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_ERROR'));
    await import('../src/background/index');
    const reply = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain('SYNTHETIC_PRIVATE_ERROR');
    expect(local.activeSession).toBeUndefined();
    expect(memory.collection.session).toBeNull();
  });
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_SESSION_ID, serverSession } from './session-fixture';
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
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith('/visits')
    ? { ...JSON.parse(init.body as string), sessionId: SERVER_SESSION_ID, updatedAt: null }
    : { ...serverSession(JSON.parse(init.body as string).goalText), sessionId: SERVER_SESSION_ID }), { status: 201 })));
  vi.stubGlobal('chrome', api);
  await import('../src/background/index');
});
  async function reloadWorker() {
    vi.resetModules();
    for (const group of [api.runtime, api.tabs, api.windows, api.webNavigation, api.permissions]) {
      for (const value of Object.values(group) as any[]) if (value?.listeners) value.listeners.length = 0;
    }
    await import('../src/background/index');
  }
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
  it.each(['blur', 'minimize'])('pauses on %s and resumes without counting a tab switch', async mode => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    api.windows.getAll.mockResolvedValue([{ id: 1, focused: mode === 'minimize', state: mode === 'minimize' ? 'minimized' : 'normal' }]);
    if (mode === 'blur') api.windows.onFocusChanged.listeners[0](-1);
    else api.windows.onBoundsChanged.listeners[0]({ id: 1, state: 'minimized' });
    await message({ type: 'status' });
    clock.mockReturnValue(20000);
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 0 });
    api.windows.getAll.mockResolvedValue([{ id: 1, focused: true, state: 'normal' }]);
    api.windows.onFocusChanged.listeners[0](1);
    await message({ type: 'status' });
    clock.mockReturnValue(21000);
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 3000, tabSwitchCount: 0 });
  });
  it('keeps rapid A → B → A activations even when the live query already reports A', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    clock.mockReturnValue(13000);
    api.tabs.onActivated.listeners[0]({ tabId: 1, windowId: 1 });
    api.tabs.onActivated.listeners[0]({ tabId: 1, windowId: 1 });
    const visit = (await message({ type: 'status' })).status!.visits[0];
    expect(visit).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 1 });
    expect(memory.collection.candidates).toHaveLength(1);
  });
  it('ignores an activation in an unfocused window and deduplicates cross-window focus/activation', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 2 });
    await message({ type: 'status' });
    expect(memory.collection.candidates[0].tabSwitchCount).toBe(0);
    api.windows.onFocusChanged.listeners[0](-1);
    api.windows.getAll.mockResolvedValue([{ id: 1, focused: false }, { id: 2, focused: true, state: 'normal' }]);
    api.tabs.query.mockResolvedValue([{ id: 2 }]);
    api.windows.onFocusChanged.listeners[0](2);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 2 });
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 1 });
    clock.mockReturnValue(20000);
    api.windows.onFocusChanged.listeners[0](-1);
    await message({ type: 'status' });
    expect(memory.collection.candidates[0].tabSwitchCount).toBe(1);
  });
  it.each([true, false])('handles close/activation ordering and finalizes the departing behavior (activation first: %s)', async activationFirst => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    api.tabs.query.mockResolvedValue([{ id: 2 }]);
    if (activationFirst) api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    api.tabs.onRemoved.listeners[0](1);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    const status = (await message({ type: 'status' })).status!;
    expect(status.readyVisits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 1, sequence: 1 });
    expect(memory.collection.tabs[1]).toBeUndefined();
  });
  it('settles at event arrival time even when a Chrome query delays processing', async () => {
    const { clock } = await validVisit();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.tabs.query.mockImplementationOnce(async () => { entered(); await gate; return [{ id: 2 }]; });
    clock.mockReturnValue(12000);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    await started;
    clock.mockReturnValue(20000);
    release();
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 1 });
  });
  it('recovers on a real activation without inferring activity since the last checkpoint', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(15000);
    api.tabs.query.mockResolvedValue([{ id: 2 }]);
    await reloadWorker();
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 1 });
  });
  it.each(['blur', 'minimize', 'query-failure'])('reconciles %s during worker recovery without charging an unknown gap', async mode => {
    const { clock } = await validVisit();
    clock.mockReturnValue(20000);
    if (mode === 'query-failure') api.windows.getAll.mockRejectedValueOnce(new Error('synthetic query failure'));
    else api.windows.getAll.mockResolvedValue([{ id: 1, focused: mode === 'minimize', state: mode === 'minimize' ? 'minimized' : 'normal' }]);
    await reloadWorker();
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 0 });
    expect(memory.collection.foregroundTabId).toBeNull();
  });
  it('pauses recovery when the browser reports multiple focused windows', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(20000);
    api.windows.getAll.mockResolvedValue([{ id: 1, focused: true, state: 'normal' }, { id: 2, focused: true, state: 'normal' }]);
    await reloadWorker();
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 0 });
    expect(memory.collection.foregroundTabId).toBeNull();
  });
  it('restores the same active visit and freezes its final behavior after stop and restart', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(15000);
    await reloadWorker();
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 0 });
    clock.mockReturnValue(16000);
    const stopped = (await message({ type: 'stop' })).status!;
    expect(stopped.readyVisits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 0 });
    clock.mockReturnValue(20000);
    await reloadWorker();
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    const restored = (await message({ type: 'status' })).status!;
    const { visitDelivery: stoppedDelivery, ...stoppedCollection } = stopped;
    const { visitDelivery: restoredDelivery, ...restoredCollection } = restored;
    expect(restoredCollection).toEqual(stoppedCollection);
    expect(stoppedDelivery!.visits[0].visitId).toBe(restoredDelivery!.visits[0].visitId);
    expect(restoredDelivery!.visits[0].phase).toBe('acked');
  });
  it('does not resume when a tab is selected inside a minimized window', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    api.windows.onBoundsChanged.listeners[0]({ id: 1, state: 'minimized', focused: false });
    await message({ type: 'status' });
    clock.mockReturnValue(13000);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    clock.mockReturnValue(20000);
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 0 });
    expect(memory.collection.foregroundTabId).toBeNull();
  });
  it('resumes an authorized selected document after a transient frame query failure', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    api.webNavigation.getFrame.mockRejectedValueOnce(new Error('synthetic query failure'));
    await message({ type: 'context' }, pageSender);
    clock.mockReturnValue(13000);
    await message({ type: 'context' }, pageSender);
    clock.mockReturnValue(14000);
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 3000, tabSwitchCount: 0 });
  });
  it('keeps per-window selections in event order across focus and activation interleaving', async () => {
    const { clock } = await validVisit();
    frame = { documentId: 'document2', url: 'https://example.com/other' };
    const other = { ...pageSender, tab: { id: 2 }, documentId: frame.documentId, url: frame.url };
    await message({ type: 'context' }, other);
    await message({ type: 'snapshot', sessionId: memory.collection.session.sessionId, snapshot: { ...await describeUrl(frame.url), title: '문서', content: 'x'.repeat(50) } }, other);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 2 });
    await message({ type: 'status' }); // A selection in an unfocused window is not a foreground switch.
    clock.mockReturnValue(12000);
    api.windows.onFocusChanged.listeners[0](2);
    clock.mockReturnValue(13000);
    api.tabs.onActivated.listeners[0]({ tabId: 3, windowId: 2 });
    clock.mockReturnValue(14000);
    api.windows.onFocusChanged.listeners[0](1);
    clock.mockReturnValue(15000);
    const visits = (await message({ type: 'status' })).status!.visits;
    expect(visits[0]).toMatchObject({ activeDurationMs: 3000, tabSwitchCount: 1 });
    expect(visits[1]).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 1 });
  });
  it('does not insert the latest selected tab before replaying post-restart activations', async () => {
    const { clock } = await validVisit();
    for (const tabId of [2, 3]) {
      frame = { documentId: `document${tabId}`, url: `https://example.com/page${tabId}` };
      const sender = { ...pageSender, tab: { id: tabId }, documentId: frame.documentId, url: frame.url };
      await message({ type: 'context' }, sender);
      await message({ type: 'snapshot', sessionId: memory.collection.session.sessionId, snapshot: { ...await describeUrl(frame.url), title: '문서', content: 'x'.repeat(50) } }, sender);
    }
    await reloadWorker();
    api.tabs.query.mockResolvedValue([{ id: 3 }]);
    clock.mockReturnValue(12000);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    clock.mockReturnValue(13000);
    api.tabs.onActivated.listeners[0]({ tabId: 3, windowId: 1 });
    clock.mockReturnValue(14000);
    const visits = (await message({ type: 'status' })).status!.visits;
    expect(visits.map(v => v.tabSwitchCount)).toEqual([1, 1, 0]);
    expect(visits.map(v => v.activeDurationMs)).toEqual([1000, 1000, 1000]);
  });
  it('preserves rapid cross-window focus events even when live focus has already returned', async () => {
    const { clock } = await validVisit();
    api.tabs.query.mockImplementation(async ({ windowId }: { windowId?: number }) => [{ id: windowId === 2 ? 2 : 1 }]);
    clock.mockReturnValue(12000);
    api.windows.onFocusChanged.listeners[0](2);
    clock.mockReturnValue(13000);
    api.windows.onFocusChanged.listeners[0](1);
    const status = (await message({ type: 'status' })).status!;
    expect(status.visits[0]).toMatchObject({ activeDurationMs: 2000, tabSwitchCount: 1 });
  });
  it('does not backdate a live browser query from a delayed content registration', async () => {
    const { clock } = await validVisit();
    let release!: () => void;
    let entered!: () => void;
    const querying = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.webNavigation.getFrame.mockImplementationOnce(async () => { entered(); await gate; return frame; });
    clock.mockReturnValue(12000);
    const context = message({ type: 'context' }, pageSender);
    await querying;
    clock.mockReturnValue(13000);
    api.tabs.query.mockResolvedValue([{ id: 2 }]);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    release();
    await context;
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 3000, tabSwitchCount: 1 });
  });
  it('ignores a delayed leave from the replaced document without pausing the new visit', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(12000);
    frame = { documentId: 'new-document', url: 'https://example.com/other' };
    const sender = { ...pageSender, documentId: frame.documentId, url: frame.url };
    await message({ type: 'context' }, sender);
    await message({ type: 'leave', sessionId: memory.collection.session.sessionId }, pageSender);
    clock.mockReturnValue(13000);
    await message({ type: 'snapshot', sessionId: memory.collection.session.sessionId, snapshot: { ...await describeUrl(frame.url), title: '문서', content: 'x'.repeat(50) } }, sender);
    const status = (await message({ type: 'status' })).status!;
    expect(status.visits[1]).toMatchObject({ activeDurationMs: 1000 });
    expect(memory.collection.foregroundTabId).toBe(1);
  });
  it('reconciles focus when the first post-restart event only closes a background tab', async () => {
    const { clock } = await validVisit();
    clock.mockReturnValue(20000);
    api.windows.getAll.mockResolvedValue([{ id: 1, focused: false, state: 'normal' }]);
    await reloadWorker();
    api.tabs.onRemoved.listeners[0](2);
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 0 });
    expect(memory.collection.foregroundTabId).toBeNull();
  });
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
    api.windows.onBoundsChanged.listeners[0]({ id: 1, focused: true, state: 'normal' });
    expect((await message({ type: 'status' })).status?.session?.sessionId).toBe(sessionId);
    expect(memory.collection.foregroundTabId).toBeNull();
    expect(memory.collection.candidates[0].snapshot).toEqual(candidate.snapshot);
    api.windows.onBoundsChanged.listeners[0]({ id: 1, focused: true, state: 'normal' });
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
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
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
    expect(memory.collection).toBeUndefined();
    expect((await message({ type: 'status' })).status?.sessionStartRecovery).toMatchObject({ kind: 'invalid', reason: 'initialization-failed' });
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
  it('fails closed on checkpoint storage failure and recovers the same session', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' });
    api.storage.session.set.mockRejectedValueOnce(new Error('synthetic failure'));
    expect((await message({ type: 'context' }, pageSender)).ok).toBe(false);
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await message({ type: 'start', goalText: '새로운 작업 목표' })).ok).toBe(false);
    expect((await message({ type: 'start', goalText: '공개 문서 조사하기' })).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
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
  it('serializes delayed browser queries across tabs and publishes in creation order rather than validation order', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    const started = await message({ type: 'start', goalText: '공개 문서 조사하기' });
    const sessionId = started.status!.session!.sessionId;
    let release!: () => void;
    let entered!: () => void;
    const querying = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const frames = { 1: frame, 2: { documentId: 'document2', url: 'https://example.com/other' } };
    api.webNavigation.getFrame.mockImplementation(async ({ tabId }: { tabId: 1 | 2 }) => frames[tabId]);
    api.webNavigation.getFrame.mockImplementationOnce(async () => { entered(); await gate; return frames[1]; });
    const first = message({ type: 'context' }, pageSender);
    await querying;
    const secondSender = { ...pageSender, tab: { id: 2 }, ...frames[2] };
    const second = message({ type: 'context' }, secondSender);
    release();
    await Promise.all([first, second]);
    const ids = memory.collection.candidates.map((c: any) => c.visitId);
    api.tabs.query.mockResolvedValue([{ id: 2 }]);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    await message({ type: 'status' });
    const payload = async (url: string) => ({ ...await describeUrl(url), title: '공개 문서', content: 'x'.repeat(50) });
    clock.mockReturnValue(11000);
    await message({ type: 'snapshot', sessionId, snapshot: await payload(frames[2].url) }, secondSender);
    api.tabs.onRemoved.listeners[0](2);
    expect((await message({ type: 'status' })).status!.readyVisits).toEqual([]);
    expect(memory.collection.candidates[1]).toMatchObject({ state: 'valid', finalized: true, sequence: null });
    clock.mockReturnValue(12000);
    api.tabs.query.mockResolvedValue([{ id: 1 }]);
    api.tabs.onActivated.listeners[0]({ tabId: 1, windowId: 1 });
    await message({ type: 'status' });
    clock.mockReturnValue(13000);
    await message({ type: 'snapshot', sessionId, snapshot: await payload(frames[1].url) }, pageSender);
    api.tabs.onRemoved.listeners[0](1);
    const ready = (await message({ type: 'status' })).status!.readyVisits;
    expect(ready.map(v => v.visitId)).toEqual(ids);
    expect(ready.map(v => v.sequence)).toEqual([1, 2]);
    vi.resetModules(); api.runtime.onMessage.listeners.length = 0;
    await import('../src/background/index');
    expect((await message({ type: 'status' })).status!.readyVisits).toEqual(ready);
  });
  it('migrates a legacy session checkpoint and preserves finalized resend data through stop and worker restart', async () => {
    const { clock, candidate } = await validVisit();
    const legacy = structuredClone(memory.collection);
    delete legacy.sequenceVersion;
    legacy.candidates.forEach((c: any, i: number) => { delete c.finalized; c.sequence = i + 1; });
    legacy.nextSequence = legacy.candidates.length + 1;
    memory.collection = legacy;
    vi.resetModules(); api.runtime.onMessage.listeners.length = 0;
    await import('../src/background/index');
    expect((await message({ type: 'status' })).status!.visits[0]).toMatchObject({ visitId: candidate.visitId, sequence: null });
    clock.mockReturnValue(12000);
    const stopped = (await message({ type: 'stop' })).status!;
    expect(stopped.readyVisits[0]).toMatchObject({ visitId: candidate.visitId, sequence: 1 });
    vi.resetModules(); api.runtime.onMessage.listeners.length = 0;
    await import('../src/background/index');
    const lateContext = message({ type: 'context' }, pageSender);
    const repeatedStop = message({ type: 'stop' });
    await Promise.all([lateContext, repeatedStop]);
    expect((await message({ type: 'status' })).status!.readyVisits).toEqual(stopped.readyVisits);
    expect(memory.collection.sequenceVersion).toBe(1);
    expect(memory.collection.nextSequence).toBe(2);
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

describe('background search verification', () => {
  async function openSearch() {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    frame.url = 'https://www.google.com/search?q=JWT&extra=OMITTED#OMITTED';
    const start = await message({ type: 'start', goalText: '공개 검색 조사하기' });
    const sessionId = start.status!.session!.sessionId;
    await message({ type: 'context' }, pageSender);
    const snapshot = { ...await describeUrl(frame.url), title: '검색', content: '검색어: JWT\n\n검색 결과 1\n제목: 인증', organicResultCount: 1 };
    clock.mockReturnValue(11000);
    return { sessionId, snapshot };
  }
  it('matches the query to the browser-owned URL and stores only bounded search data', async () => {
    const { sessionId, snapshot } = await openSearch();
    expect((await message({ type: 'snapshot', sessionId, snapshot }, pageSender)).ok).toBe(true);
    const status = (await message({ type: 'status' })).status!;
    expect(status.visits[0]).toMatchObject({ searchQuery: 'JWT', isSearchResultPage: true, normalizedUrl: 'https://www.google.com/search' });
    expect(JSON.stringify(memory)).not.toContain('OMITTED');
    expect(JSON.stringify(status)).not.toContain('organicResultCount');
  });
  it.each([{ searchQuery: '위조 검색어' }, { rawUrl: 'PRIVATE_URL' }, { isSearchResultPage: false, searchQuery: null, organicResultCount: undefined }, { organicResultCount: 0 }])('rejects mismatched or unchecked fields: %s', async fields => {
    const { sessionId, snapshot } = await openSearch();
    expect((await message({ type: 'snapshot', sessionId, snapshot: { ...snapshot, ...fields } }, pageSender)).ok).toBe(false);
    expect(memory.collection.candidates[0].snapshot).toBeUndefined();
  });
  it('rejects a syntactically valid query that differs from the live browser URL', async () => {
    const { sessionId, snapshot } = await openSearch();
    expect((await message({ type: 'snapshot', sessionId, snapshot: { ...snapshot, searchQuery: '위조' } }, pageSender)).ok).toBe(false);
    expect(memory.collection.candidates[0].snapshot).toBeUndefined();
  });
  it('does not store unauthorized search data even after script injection', async () => {
    const { sessionId, snapshot } = await openSearch(); api.permissions.contains.mockResolvedValue(false);
    expect(await message({ type: 'snapshot', sessionId, snapshot }, pageSender)).toMatchObject({ sessionId: null });
    expect(memory.collection.candidates[0].snapshot).toBeUndefined();
  });
  it('rehydrates valid search fields through actual adapter initialization', async () => {
    const { sessionId, snapshot } = await openSearch(); await message({ type: 'snapshot', sessionId, snapshot }, pageSender);
    const original = (await message({ type: 'status' })).status!.visits[0];
    vi.resetModules(); api.runtime.onMessage.listeners.length = 0; await import('../src/background/index');
    expect((await message({ type: 'status' })).status!.visits[0]).toEqual(original);
  });
});


describe('server session integration and durable recovery', () => {
  const goalText = '공개 문서 조사하기';
  const start = (goal = goalText) => message({ type: 'start', goalText: goal });
  it('uses the server ID/time/status and stores it before scripts start', async () => {
    const payload = { ...serverSession(goalText, 123456789), sessionId: SERVER_SESSION_ID };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 201 }));
    api.scripting.registerContentScripts.mockImplementation(async () => {
      expect(memory.collection.session).toMatchObject(payload);
      expect(local.activeSession.sessionId).toBe(SERVER_SESSION_ID);
    });
    expect((await start()).status?.session).toEqual({ ...payload, source: 'server' });
    expect(local.pendingSessionStart).toBeUndefined();
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBe(SERVER_SESSION_ID);
  });
  it('blocks concurrent starts at arrival even if the first request fails', async () => {
    let fail!: (reason: Error) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(fetch).mockImplementationOnce(() => { entered(); return new Promise((_, reject) => { fail = reject; }); });
    const first = start(); await waiting;
    expect((await start()).error).toContain('처리 중');
    expect(memory.collection?.session ?? null).toBeNull();
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
    fail(new Error('PRIVATE_NETWORK_ERROR'));
    expect((await first).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await message({ type: 'status' })).status?.session).toBeNull();
  });
  it('does not backdate queued collection events into the API wait', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    let respond!: (value: Response) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(fetch).mockImplementationOnce(() => { entered(); return new Promise(resolve => { respond = resolve; }); });
    const first = start(); await waiting;
    clock.mockReturnValue(11000);
    const context = message({ type: 'context' }, pageSender);
    clock.mockReturnValue(15000);
    respond(new Response(JSON.stringify(serverSession(goalText)), { status: 201 }));
    await first; await context;
    expect(memory.collection.candidates[0].visitedAt).toBe(new Date(15000).toISOString());
    expect(memory.collection.candidates[0].activeDurationMs).toBe(0);
  });
  it.each(['network', 'json', 'fields', '500', '422'])('keeps the same key and goal after %s, including worker restart', async failure => {
    if (failure === 'network') vi.mocked(fetch).mockRejectedValueOnce(new Error('PRIVATE'));
    else vi.mocked(fetch).mockResolvedValueOnce(new Response(failure === 'fields' ? '{}' : '{', { status: failure === '500' ? 500 : failure === '422' ? 422 : 201 }));
    const failed = await start();
    expect(failed.ok).toBe(false); expect(failed.status?.session).toBeNull();
    const pending = structuredClone(local.pendingSessionStart);
    expect(pending.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
    await reloadWorker();
    const state = (await message({ type: 'status' })).status!;
    expect(state.sessionStartRecovery).toMatchObject({ kind: 'pending', goalText });
    expect((await start('다른 작업 목표')).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await start()).ok).toBe(true);
    const keys = vi.mocked(fetch).mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual([pending.idempotencyKey, pending.idempotencyKey]);
  });
  it('retains a timed-out request through browser restart and local clear', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => undefined));
    const result = start();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await result).ok).toBe(false);
    vi.useRealTimers();
    const pending = structuredClone(local.pendingSessionStart);
    memory = {}; api.storage.session = area(memory);
    await reloadWorker();
    await message({ type: 'clear' }); await message({ type: 'stop' });
    expect(local.pendingSessionStart).toEqual(pending);
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await start()).ok).toBe(true);
    expect(vi.mocked(fetch).mock.calls[1][1]?.headers).toMatchObject({ 'Idempotency-Key': pending.idempotencyKey });
  });
  it('releases a first 400 rejection so the goal can be corrected', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('PRIVATE', { status: 400 }));
    expect((await start()).ok).toBe(false);
    expect(local.pendingSessionStart).toBeUndefined();
    expect((await start('새로운 작업 목표')).ok).toBe(true);
    const keys = vi.mocked(fetch).mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('does not release an uncertain request after a later 400', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('lost response'));
    await start(); const key = local.pendingSessionStart.idempotencyKey;
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 400 }));
    await start(); expect(local.pendingSessionStart.idempotencyKey).toBe(key);
  });
  it('does not send anything when the write before HTTP fails', async () => {
    await message({ type: 'status' });
    api.storage.local.set.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_ERROR'));
    expect((await start()).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
  });
  it.each(['response', 'checkpoint', 'metadata', 'cleanup'])('recovers after %s storage failure without creating a second session', async phase => {
    const baseSet = api.storage.local.set.getMockImplementation();
    const baseRemove = api.storage.local.remove.getMockImplementation();
    if (phase === 'response' || phase === 'metadata') api.storage.local.set.mockImplementationOnce(baseSet).mockImplementationOnce(async (value: any) => {
      if (phase === 'response' || value.activeSession) throw new Error('storage failure');
      await baseSet(value);
    });
    if (phase === 'metadata') {
      api.storage.local.set.mockReset();
      api.storage.local.set.mockImplementation(async (value: any) => {
        if (value.activeSession) throw new Error('storage failure');
        await baseSet(value);
      });
    }
    if (phase === 'checkpoint') api.storage.session.set.mockRejectedValueOnce(new Error('storage failure'));
    if (phase === 'cleanup') api.storage.local.remove.mockImplementation(async (key: string) => {
      if (key === 'pendingSessionStart') throw new Error('storage failure');
      await baseRemove(key);
    });
    expect((await start()).ok).toBe(false);
    const key = local.pendingSessionStart.idempotencyKey;
    api.storage.local.set.mockImplementation(baseSet); api.storage.local.remove.mockImplementation(baseRemove);
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    const keys = vi.mocked(fetch).mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys.every(value => value === key)).toBe(true);
    expect(keys).toHaveLength(phase === 'response' ? 2 : 1);
  });
  it('recovers a worker killed after sending but before receiving a response', async () => {
    const key = crypto.randomUUID();
    local.pendingSessionStart = { idempotencyKey: key, goalText, apiBaseUrl: 'http://localhost:8080' };
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.sessionStartRecovery).toMatchObject({ kind: 'pending', goalText });
    expect(fetch).not.toHaveBeenCalled();
    expect((await start()).ok).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ 'Idempotency-Key': key });
  });
  it('requires explicit recovery after a crash between activation checkpoint and pending cleanup', async () => {
    await start();
    local.pendingSessionStart = structuredClone(local.activeSession.startRequest);
    await reloadWorker();
    const state = (await message({ type: 'status' })).status!;
    expect(state.session).toBeNull(); expect(state.sessionStartRecovery).toMatchObject({ kind: 'pending', goalText });
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBeNull();
    expect((await start()).ok).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('blocks recovery against a different server and rejects a corrupt pending record', async () => {
    local.pendingSessionStart = { idempotencyKey: crypto.randomUUID(), goalText, apiBaseUrl: 'https://another-server.example' };
    await reloadWorker(); expect((await start()).ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
    local.pendingSessionStart.idempotencyKey = 'invalid';
    await reloadWorker(); expect((await start()).ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
    expect(local.pendingSessionStart).toBeDefined();
  });
  it('refuses an ENDED replay and retains the request for investigation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...serverSession(goalText), status: 'ENDED', endedAt: '2026-10-16T00:00:00.000Z' }), { status: 201 }));
    expect((await start()).error).toContain('이미 종료');
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBeNull();
    expect(local.pendingSessionStart.response.status).toBe('ENDED');
  });
  it('does not let mandatory API permission authorize collection or script registration', async () => {
    api.permissions.getAll.mockResolvedValue({ origins: ['http://localhost/*', 'https://example.com/*'] });
    api.tabs.query.mockResolvedValue([{ id: 1, url: 'http://localhost:9090/private' }]);
    await start();
    expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ matches: ['https://example.com/*'] })]);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    frame.url = 'http://localhost:9090/private';
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBeNull();
  });
  it('rejects invalid goals before HTTP and normalizes Java whitespace', async () => {
    expect((await start(' 1234 ')).ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
    await start('\u001c公開문서 조사하기\u3000');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).goalText).toBe('公開문서 조사하기');
    expect((await start()).ok).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses an upgrade checkpoint from a development-local session', async () => {
    await start();
    memory.collection.session.source = 'development-local';
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
  });
});

describe('corrupt start records stay inspectable', () => {
  const valid = () => ({ idempotencyKey: crypto.randomUUID(), goalText: '공개 문서 조사하기', apiBaseUrl: 'http://localhost:8080' });
  it.each([
    ['UUID', () => ({ ...valid(), idempotencyKey: 'broken' })],
    ['missing goal', () => ({ idempotencyKey: crypto.randomUUID(), apiBaseUrl: 'http://localhost:8080' })],
    ['missing key', () => ({ goalText: '공개 문서 조사하기', apiBaseUrl: 'http://localhost:8080' })],
    ['missing URL', () => ({ idempotencyKey: crypto.randomUUID(), goalText: '공개 문서 조사하기' })],
    ['URL scheme', () => ({ ...valid(), apiBaseUrl: 'file:///private' })],
    ['URL path', () => ({ ...valid(), apiBaseUrl: 'http://localhost:8080/api' })],
    ['empty query', () => ({ ...valid(), apiBaseUrl: 'http://localhost:8080/?' })],
    ['response', () => ({ ...valid(), response: { sessionId: 'broken' } })],
    ['null', () => null], ['false', () => false], ['string', () => 'PRIVATE_CORRUPTED_RECORD'],
  ])('preserves %s corruption and serves status/clear across restart', async (_label, makeRecord) => {
    const record = makeRecord(); local.pendingSessionStart = structuredClone(record);
    await reloadWorker();
    for (let restart = 0; restart < 2; restart++) {
      const reply = await message({ type: 'status' });
      expect(reply).toMatchObject({ ok: true, status: { session: null, sessionStartRecovery: { kind: 'invalid', reason: 'corrupted-record' } } });
      expect(JSON.stringify(reply)).not.toContain('PRIVATE_CORRUPTED_RECORD');
      expect((await message({ type: 'start', goalText: '새로운 작업 목표' })).ok).toBe(false);
      expect((await message({ type: 'clear' })).ok).toBe(true);
      expect((await message({ type: 'stop' })).ok).toBe(true);
      expect(local.pendingSessionStart).toEqual(record); expect(fetch).not.toHaveBeenCalled();
      expect(api.scripting.registerContentScripts).not.toHaveBeenCalled(); await reloadWorker();
    }
  });
  it('pauses an active checkpoint without erasing visits or the corrupt record', async () => {
    await message({ type: 'start', goalText: '공개 문서 조사하기' }); await message({ type: 'context' }, pageSender);
    const ids = memory.collection.candidates.map((c: any) => c.visitId);
    local.pendingSessionStart = { ...valid(), response: 'PRIVATE_CORRUPTED_RESPONSE' };
    const record = structuredClone(local.pendingSessionStart); await reloadWorker();
    expect(await message({ type: 'status' })).toMatchObject({ ok: true, status: { session: null, sessionStartRecovery: { kind: 'invalid' } } });
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBeNull();
    expect(memory.collection.candidates.map((c: any) => c.visitId)).toEqual(ids);
    expect(memory.collection.candidates.every((c: any) => c.activeSince === null)).toBe(true);
    expect(local.pendingSessionStart).toEqual(record); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('active failures preserve creation identity', () => {
  const goalText = '공개 문서 조사하기';
  const start = (goal = goalText) => message({ type: 'start', goalText: goal });
  it('blocks a new goal and resumes existing visits after save failure and restart', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    await start(); await message({ type: 'context' }, pageSender); clock.mockReturnValue(11000);
    await message({ type: 'snapshot', sessionId: SERVER_SESSION_ID, snapshot: { ...await describeUrl(frame.url), title: '문서', content: 'x'.repeat(50) } }, pageSender);
    const before = structuredClone(memory.collection);
    api.storage.session.set.mockRejectedValueOnce(new Error('PRIVATE_CHECKPOINT_ERROR'));
    expect((await message({ type: 'context' }, pageSender)).ok).toBe(false);
    expect((await start('다른 작업 목표')).ok).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    await reloadWorker();
    expect(await message({ type: 'status' })).toMatchObject({ ok: true, status: { session: null, sessionStartRecovery: { kind: 'pending', goalText } } });
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBeNull();
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(memory.collection.candidates.map((c: any) => c.visitId)).toEqual(before.candidates.map((c: any) => c.visitId));
    expect(memory.collection.candidates[0].activeDurationMs).toBe(before.candidates[0].activeDurationMs);
    expect(memory.collection.candidates[0].sequence).toBe(before.candidates[0].sequence); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['both stores', 'checkpoint cleanup'])('retains the receipt after repeated %s failures', async mode => {
    await start(); const receipt = structuredClone(local.activeSession);
    api.storage.session.set.mockRejectedValue(new Error('PRIVATE_STORAGE_FAILURE'));
    if (mode === 'both stores') api.storage.local.set.mockRejectedValue(new Error('PRIVATE_STORAGE_FAILURE'));
    else api.storage.session.remove.mockRejectedValue(new Error('PRIVATE_STORAGE_FAILURE'));
    expect((await message({ type: 'context' }, pageSender)).ok).toBe(false);
    expect(local.activeSession).toMatchObject({ sessionId: SERVER_SESSION_ID, startRequest: receipt.startRequest });
    api.storage.session.set.mockImplementation(area(memory).set); api.storage.local.set.mockImplementation(area(local).set);
    api.storage.session.remove.mockImplementation(area(memory).remove); await reloadWorker();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await start('다른 작업 목표')).ok).toBe(false);
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires operator recovery when a legacy active session has no creation key', async () => {
    await start(); delete local.activeSession.startRequest; await reloadWorker();
    api.storage.session.set.mockRejectedValueOnce(new Error('checkpoint failure'));
    expect((await message({ type: 'context' }, pageSender)).ok).toBe(false); await reloadWorker();
    expect(await message({ type: 'status' })).toMatchObject({ ok: true, status: { session: null, sessionStartRecovery: { kind: 'invalid', reason: 'missing-request' } } });
    expect(local.activeSession.sessionId).toBe(SERVER_SESSION_ID);
    expect((await start('다른 작업 목표')).ok).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('activation receipts and failure boundaries', () => {
  const goalText = '공개 문서 조사하기';
  const start = () => message({ type: 'start', goalText });
  it('reuses a received response in the same Worker when saving it fails', async () => {
    const set = api.storage.local.set.getMockImplementation();
    api.storage.local.set.mockImplementationOnce(set).mockRejectedValueOnce(new Error('response save'));
    expect((await start()).ok).toBe(false);
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries a failed Collector activation from its saved response', async () => {
    const { Collector } = await import('../src/background/collector');
    vi.spyOn(Collector.prototype, 'start').mockImplementationOnce(() => { throw new Error('activation'); });
    expect((await start()).ok).toBe(false);
    const pending = structuredClone(local.pendingSessionStart);
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await start()).status?.session?.sessionId).toBe(pending.response.sessionId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains the saved response through Script registration failure and restart', async () => {
    api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('PRIVATE_SCRIPT_ERROR'));
    const reply = await start();
    expect(reply).toMatchObject({ ok: false, status: { session: null, sessionStartRecovery: { kind: 'pending', goalText } } });
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_SCRIPT_ERROR');
    const pending = structuredClone(local.pendingSessionStart);
    await reloadWorker();
    expect((await message({ type: 'context' }, pageSender)).sessionId).toBeNull();
    expect((await start()).status?.session?.sessionId).toBe(pending.response.sessionId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not undo activation when a tab rejects its broadcast', async () => {
    api.tabs.sendMessage.mockRejectedValue(new Error('closed tab'));
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(local.activeSession.startRequest.response.sessionId).toBe(SERVER_SESSION_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('pauses an active session on a fatal permission sync error without losing its receipt', async () => {
    await start(); const key = local.activeSession.startRequest.idempotencyKey;
    api.permissions.getAll.mockRejectedValueOnce(new Error('permission configuration'));
    expect((await message({ type: 'sync-permissions' })).ok).toBe(false);
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    await reloadWorker();
    expect(local.activeSession.startRequest.idempotencyKey).toBe(key);
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps completed identity after browser restart but never resumes automatically', async () => {
    await start(); const key = local.activeSession.startRequest.idempotencyKey;
    memory = {}; api.storage.session = area(memory); await reloadWorker();
    expect(await message({ type: 'status' })).toMatchObject({ ok: true, status: { session: null, sessionStartRecovery: { kind: 'pending', goalText } } });
    expect(local.activeSession.startRequest.idempotencyKey).toBe(key);
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves visits when a crash leaves a pending response and checkpoint before active metadata', async () => {
    await start(); await message({ type: 'context' }, pageSender);
    const visitIds = memory.collection.candidates.map((candidate: any) => candidate.visitId);
    expect(visitIds).toHaveLength(1);
    local.pendingSessionStart = structuredClone(local.activeSession.startRequest);
    delete local.activeSession;
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await start()).status?.session?.sessionId).toBe(SERVER_SESSION_ID);
    expect(memory.collection.candidates.map((candidate: any) => candidate.visitId)).toEqual(visitIds);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('blocks a checkpoint whose visits conflict with its completed receipt', async () => {
    await start(); await message({ type: 'context' }, pageSender);
    memory.collection.candidates[0].sessionId = crypto.randomUUID();
    const original = structuredClone(local.activeSession); await reloadWorker();
    expect((await message({ type: 'status' })).status?.sessionStartRecovery).toMatchObject({ kind: 'invalid', reason: 'conflicting-records' });
    expect((await start()).ok).toBe(false);
    expect(local.activeSession).toEqual(original);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('only releases a completed receipt after an explicit local stop is persisted', async () => {
    await start(); await message({ type: 'stop' });
    expect(local.activeSession).toBeUndefined(); expect(local.pendingSessionStart).toBeUndefined();
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.sessionStartRecovery).toEqual({ kind: 'none' });
    expect((await message({ type: 'start', goalText: '새로운 작업 목표' })).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not release a receipt when local stop metadata cleanup fails', async () => {
    await start(); const receipt = structuredClone(local.activeSession);
    api.storage.local.remove.mockRejectedValueOnce(new Error('cleanup failure'));
    expect((await message({ type: 'stop' })).ok).toBe(false);
    expect(local.activeSession.startRequest).toEqual(receipt.startRequest);
    await reloadWorker();
    expect((await message({ type: 'status' })).status?.session).toBeNull();
    expect((await message({ type: 'start', goalText: '다른 작업 목표' })).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['response', 'metadata', 'conflict'])('blocks %s inconsistency without rewriting raw records', async kind => {
    await start();
    if (kind === 'response') local.activeSession.startRequest.response.sessionId = crypto.randomUUID();
    if (kind === 'metadata') local.activeSession.startedAt = 'broken';
    if (kind === 'conflict') local.pendingSessionStart = { ...structuredClone(local.activeSession.startRequest), idempotencyKey: crypto.randomUUID() };
    const records = structuredClone(local); await reloadWorker();
    expect((await message({ type: 'status' })).status?.sessionStartRecovery).toMatchObject({ kind: 'invalid', reason: kind === 'conflict' ? 'conflicting-records' : 'corrupted-record' });
    expect((await start()).ok).toBe(false);
    expect(local).toEqual(records); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('visit HTTP integration in the real background adapter', () => {
  async function prepare() {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    const started = await message({ type: 'start', goalText: '방문 저장 연동 검증하기' });
    const sessionId = started.status!.session!.sessionId;
    await message({ type: 'context' }, pageSender);
    clock.mockReturnValue(11000);
    await message({ type: 'snapshot', sessionId, snapshot: { ...await describeUrl(frame.url), title: '합성 문서', content: '공개 합성 본문입니다. '.repeat(10) } }, pageSender);
    return { clock, sessionId };
  }
  it('keeps processing collection events and new visits while awaiting the preceding HTTP ACK', async () => {
    const { clock, sessionId } = await prepare();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests: any[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string); requests.push({ url, body });
      if (requests.length === 1) await gate;
      return new Response(JSON.stringify({ ...body, sessionId, updatedAt: null }), { status: 201 });
    });
    clock.mockReturnValue(12000);
    frame = { documentId: 'document2', url: 'https://example.com/two' };
    const second = { ...pageSender, documentId: frame.documentId, url: frame.url };
    await message({ type: 'context' }, second);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const firstRequest = structuredClone(requests[0].body);
    clock.mockReturnValue(13000);
    await message({ type: 'snapshot', sessionId, snapshot: { ...await describeUrl(frame.url), title: '두 번째 문서', content: '새 공개 합성 본문입니다. '.repeat(10) } }, second);
    api.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 });
    await message({ type: 'stop' });
    const pending = (await message({ type: 'status' })).status!;
    expect(pending.session).toBeNull();
    expect(pending.readyVisits.map(v => v.sequence)).toEqual([1, 2]);
    expect(requests).toHaveLength(1);
    expect(memory.visitDelivery.entries[0].visit).toMatchObject(firstRequest);
    expect(memory.collection.candidates[1].tabSwitchCount).toBe(1);
    release();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.visitDelivery!.visits.map(v => v.phase)).toEqual(['acked', 'acked']));
    expect(requests.map(request => request.body.sequence)).toEqual([1, 2]);
    await message({ type: 'status' }); expect(requests).toHaveLength(2);
  });
  it('preserves a failed request and blocks a new session until explicit local deletion', async () => {
    await prepare();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'SESSION_ENDED' }), { status: 409 }));
    await message({ type: 'stop' });
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.visitDelivery!.visits[0]).toMatchObject({ phase: 'failed', code: 'SESSION_ENDED', retryable: false }));
    const count = vi.mocked(fetch).mock.calls.length;
    const blocked = await message({ type: 'start', goalText: '새 작업을 시작해 보기' });
    expect(blocked.ok).toBe(false); expect(fetch).toHaveBeenCalledTimes(count);
    await message({ type: 'clear' });
    expect(memory.visitDelivery.entries).toEqual([]);
    expect(memory.collection.candidates).toEqual([]);
  });
});

describe('session separation and local delivery lifecycle', () => {
  async function scenario() {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(20000);
    const sessions: string[] = [], visits: { sessionId: string; body: any }[] = [];
    let fail = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string), path = String(url);
      if (!path.endsWith('/visits')) {
        const session = serverSession(body.goalText, Date.now()); sessions.push(session.sessionId);
        return new Response(JSON.stringify(session), { status: 201 });
      }
      const sessionId = path.split('/').at(-2)!; visits.push({ sessionId, body: structuredClone(body) });
      return new Response(JSON.stringify(fail ? { code: 'SERVER_ERROR' } : { ...body, sessionId, updatedAt: null }), { status: fail ? 503 : 201 });
    });
    const begin = async () => {
      const result = await message({ type: 'start', goalText: '연속 세션 방문 보존 검증하기' });
      expect(result.ok).toBe(true); return result.status!.session!.sessionId;
    };
    const collect = async (sessionId: string, count: number) => {
      for (let i = 0; i < count; i++) {
        clock.mockReturnValue(Date.now() + 1500);
        frame = { documentId: crypto.randomUUID(), url: `https://example.com/${sessionId}/${i}` };
        const sender = { ...pageSender, documentId: frame.documentId, url: frame.url };
        await message({ type: 'context' }, sender);
        clock.mockReturnValue(Date.now() + 1100);
        await message({ type: 'snapshot', sessionId, snapshot: { ...await describeUrl(frame.url), title: '공개 합성 문서', content: '공개 본문 '.repeat(20) } }, sender);
      }
      api.tabs.onRemoved.listeners[0](1); await message({ type: 'status' });
    };
    const ack = async (count: number) => vi.waitFor(async () => {
      const state = (await message({ type: 'status' })).status!;
      expect(state.visitDelivery!.visits).toHaveLength(count);
      expect(state.visitDelivery!.visits.every(visit => visit.phase === 'acked')).toBe(true);
    });
    return { clock, sessions, visits, begin, collect, ack, setFail: (value: boolean) => { fail = value; } };
  }
  it('separates six ACKed visits in A from two visits in B without explicit clear and survives restart', async () => {
    const run = await scenario(), a = await run.begin(); await run.collect(a, 6); await run.ack(6);
    const originals = structuredClone(run.visits); await message({ type: 'stop' });
    const b = await run.begin(); expect(b).not.toBe(a);
    await run.collect(b, 2); await run.ack(2); await reloadWorker(); await message({ type: 'status' });
    expect(memory.visitDelivery.entries.map((entry: any) => [entry.visit.sessionId, entry.sequence, entry.phase])).toEqual([[b, 1, 'acked'], [b, 2, 'acked']]);
    expect(run.visits.slice(0, 6)).toEqual(originals);
    expect(run.visits.slice(6).map(visit => [visit.sessionId, visit.body.sequence])).toEqual([[b, 1], [b, 2]]);
    expect((await message({ type: 'status' })).status!.visitDelivery!.blocked).toBeUndefined();
    expect(run.sessions).toEqual([a, b]);
  });
  it('preserves an unresolved snapshot, then allows B after explicit retry and ACK', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = await scenario(), a = await run.begin(); run.setFail(true); await run.collect(a, 1); await message({ type: 'stop' });
      await vi.waitFor(() => expect(memory.visitDelivery.entries[0].phase).toBe('retry-wait'));
      for (const delay of [1000, 2000]) {
        run.clock.mockReturnValue(Date.now() + delay); await vi.advanceTimersByTimeAsync(delay);
      }
      expect(memory.visitDelivery.entries[0]).toMatchObject({ phase: 'failed', attempts: 3 });
      await reloadWorker(); const before = structuredClone(memory.visitDelivery);
      const denied = await message({ type: 'start', goalText: '두 번째 작업을 시작하기' });
      expect(denied.ok).toBe(false); expect(denied.error).toContain('확인되지 않은 방문');
      expect(run.sessions).toEqual([a]); expect(memory.visitDelivery).toEqual(before);
      expect(denied.status!.visitDelivery!.visits[0].error).toBeTruthy();
      run.setFail(false); await message({ type: 'retry-visits' }); await run.ack(1);
      expect(run.visits.at(-1)!.body).toEqual(run.visits[0].body);
      const b = await run.begin(); await run.collect(b, 2); await run.ack(2);
      expect(run.sessions).toEqual([a, b]); expect(b).not.toBe(a);
      expect(run.visits.slice(-2).map(visit => [visit.sessionId, visit.body.sequence])).toEqual([[b, 1], [b, 2]]);
    } finally { vi.useRealTimers(); }
  });
  it.each(['queued', 'sending', 'retry-wait', 'failed', 'acked'] as const)('rehydrates %s through the Background adapter without losing the snapshot', async phase => {
    const run = await scenario(), sessionId = await run.begin(); await run.collect(sessionId, 1); await run.ack(1);
    const entry = memory.visitDelivery.entries[0], original = structuredClone(entry.visit), calls = run.visits.length;
    Object.assign(entry, { phase, attempts: phase === 'queued' ? 0 : 1 });
    if (phase === 'retry-wait') entry.nextRetryAt = Date.now() + 60000;
    if (phase === 'failed') Object.assign(entry, { error: '확인 필요', retryable: false, code: 'VISIT_ID_CONFLICT' });
    const raw = structuredClone(memory.visitDelivery);
    await reloadWorker(); await message({ type: 'status' });
    if (phase === 'queued' || phase === 'sending') {
      await run.ack(1); expect(run.visits).toHaveLength(calls + 1);
      expect(run.visits.at(-1)!.body).toEqual(run.visits[0].body);
    } else {
      await message({ type: 'status' }); expect(run.visits).toHaveLength(calls);
      expect(memory.visitDelivery).toEqual(raw);
    }
    expect(memory.visitDelivery.entries[0].visit).toEqual(original);
    await message({ type: 'stop' }); await message({ type: 'clear' });
  });
  it('does not resurrect a deleted adapter checkpoint after a delayed successful HTTP response', async () => {
    const run = await scenario(), sessionId = await run.begin();
    let release!: () => void, received = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string); await gate; received = true;
      return new Response(JSON.stringify({ ...body, sessionId, updatedAt: null }), { status: 201 });
    });
    await run.collect(sessionId, 2); await message({ type: 'stop' });
    expect(memory.visitDelivery.entries.map((entry: any) => entry.phase)).toEqual(['sending', 'queued']);
    const requests = send.mock.calls.length;
    expect((await message({ type: 'clear' })).ok).toBe(true);
    release(); await vi.waitFor(() => expect(received).toBe(true));
    await message({ type: 'status' }); await reloadWorker(); await message({ type: 'status' });
    expect(memory.collection.candidates).toEqual([]); expect(memory.visitDelivery.entries).toEqual([]);
    expect(send).toHaveBeenCalledTimes(requests);
  });
  it('blocks a restored queue belonging to a different Collector session and preserves the raw checkpoint', async () => {
    const run = await scenario(), a = await run.begin(); await run.collect(a, 1); await run.ack(1);
    memory.visitDelivery.entries[0].visit.sessionId = crypto.randomUUID();
    memory.visitDelivery.entries[0].phase = 'queued';
    const raw = structuredClone(memory.visitDelivery), calls = run.visits.length;
    await reloadWorker(); const restored = (await message({ type: 'status' })).status!;
    expect(restored.visitDelivery!.blocked).toBeTruthy();
    expect(memory.visitDelivery).toEqual(raw); expect(run.visits).toHaveLength(calls);
    expect((await message({ type: 'stop' })).ok).toBe(true);
    expect((await message({ type: 'start', goalText: '다음 세션을 시작하기' })).ok).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describeUrl } from '../src/shared/url';
import { serverSession, SERVER_SESSION_ID } from './session-fixture';
import type { Reply } from '../src/shared/types';
const event = () => ({ listeners: [] as ((...args: any[]) => void)[], addListener(fn: (...args: any[]) => void) { this.listeners.push(fn); } });
let chromeApi: any, local: Record<string, any>, legacy: Record<string, any>;
let frame: { documentId: string; url: string };
const sender = { id: 'test', url: 'chrome-extension://test/popup.html' };
function area(data: Record<string, any>) {
  return { setAccessLevel: vi.fn(async () => undefined), get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values: any) => { Object.assign(data, structuredClone(values)); }), remove: vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) delete data[key]; }) };
}
async function message(value: unknown, content = false): Promise<Reply> {
  return new Promise(resolve => chromeApi.runtime.onMessage.listeners[0](value, content ? { ...sender, url: frame.url, tab: { id: 1 }, frameId: 0, documentId: frame.documentId, documentLifecycle: 'active' } : sender, resolve));
}
async function restart() {
  vi.resetModules();
  for (const group of Object.values(chromeApi) as any[]) for (const value of Object.values(group) as any[]) if (value?.listeners) value.listeners.length = 0;
  await import('../src/background/index');
}
async function raw() {
  const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('focus-recovery', 1); r.onsuccess = () => resolve(r.result); });
  try { return await new Promise<any>(resolve => { const tx = db.transaction('state'), r = tx.objectStore('state').get('current'); tx.oncomplete = () => resolve(r.result); }); } finally { db.close(); }
}
async function visit(duration = 1500) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
  expect((await message({ type: 'start', goalText: '공개 합성 문서 조사하기' })).ok).toBe(true);
  await message({ type: 'context' }, true); clock.mockReturnValue(10000 + duration);
  await message({ type: 'snapshot', sessionId: SERVER_SESSION_ID, snapshot: { ...(await describeUrl(frame.url))!, title: '공개 문서', content: '공개 합성 본문 '.repeat(20) } }, true);
  return clock;
}
beforeEach(async () => {
  vi.restoreAllMocks(); vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); local = {}; legacy = {};
  frame = { documentId: 'original-document', url: 'https://example.com/docs' };
  chromeApi = {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event(), onInstalled: event() },
    storage: { local: area(local), session: area(legacy) }, alarms: { create: vi.fn(async () => undefined), onAlarm: event() },
    windows: { getAll: vi.fn(async () => [{ id: 1, focused: true }]), onFocusChanged: event(), onBoundsChanged: event() },
    tabs: { query: vi.fn(async () => [{ id: 1 }]), sendMessage: vi.fn(async () => undefined), onActivated: event(), onRemoved: event() },
    permissions: { contains: vi.fn(async () => true), getAll: vi.fn(async () => ({ origins: ['https://example.com/*'] })), onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => undefined), unregisterContentScripts: vi.fn(async () => undefined), executeScript: vi.fn(async () => undefined) },
    webNavigation: { getFrame: vi.fn(async () => frame), onCommitted: event(), onHistoryStateUpdated: event(), onErrorOccurred: event() },
  };
  vi.stubGlobal('chrome', chromeApi);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith('/api/sessions')
    ? { ...serverSession(JSON.parse(init.body as string).goalText), sessionId: SERVER_SESSION_ID }
    : { ...JSON.parse(init.body as string), sessionId: SERVER_SESSION_ID, updatedAt: null }), { status: 201 })));
  await import('../src/background/index');
});

describe('real Background with IndexedDB', () => {
  it('restores after session storage disappears, retains identifiers and excludes the shutdown gap', async () => {
    const clock = await visit(), before = (await raw()).value.collection;
    legacy = {}; chromeApi.storage.session = area(legacy); clock.mockReturnValue(999999);
    await restart(); const reply = await message({ type: 'status' });
    expect(reply.status!.storage).toMatchObject({ phase: 'ready', recovered: true });
    expect(reply.status!.candidates[0]).toMatchObject({ visitId: before.candidates[0].visitId, sequence: null, activeDurationMs: 1500, behaviorVersion: 1 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); expect(Object.keys(legacy)).toEqual([]);
  });
  it.each(['document', 'tab', 'permission'])('preserves an unverifiable %s candidate as unresolved without allocating sequence', async kind => {
    await visit(0); const before = (await raw()).value.collection.candidates[0];
    if (kind === 'document') frame.documentId = 'replacement';
    if (kind === 'tab') chromeApi.webNavigation.getFrame.mockResolvedValue(null);
    if (kind === 'permission') chromeApi.permissions.contains.mockResolvedValue(false);
    await restart(); const reply = await message({ type: 'status' });
    expect(reply.status!.candidates[0]).toMatchObject({ visitId: before.visitId, recoveryRequired: true, sequence: null, finalized: false, activeDurationMs: before.activeDurationMs });
    expect(reply.status!.recoveryCandidates).toBe(1); await message({ type: 'stop' });
    expect((await message({ type: 'start', goalText: '새로운 문서 조사하기' })).ok).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it('never sends HTTP when the sending transaction aborts', async () => {
    await visit(); const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const r = put.apply(this, args); const value = args[0] as any;
      if (value.value.visitDelivery?.entries[0]?.phase === 'sending') r.addEventListener('success', () => this.transaction.abort()); return r;
    });
    await message({ type: 'stop' });
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.storage!.phase).toBe('failed'));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect((await raw()).value.visitDelivery.entries[0].phase).toBe('queued');
  });
  it('rolls back an uncommitted POST ACK, blocks PATCH and resumes the original request', async () => {
    await visit(); const put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const r = put.apply(this, args); const value = args[0] as any;
      if (value.value.visitDelivery?.entries[0]?.phase === 'acked') r.addEventListener('success', () => this.transaction.abort()); return r;
    });
    await message({ type: 'stop' });
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.storage!.phase).toBe('failed'));
    const saved = (await raw()).value, snapshot = saved.visitDelivery.entries[0].visit;
    expect(saved.visitDelivery.entries[0]).toMatchObject({ phase: 'sending', attempts: 1 });
    expect((await message({ type: 'status' })).status!.visitDelivery!.visits[0].phase).toBe('sending');
    expect(saved.behaviorDelivery.entries[0].ack).toBeUndefined(); fault.mockRestore(); await restart();
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.visitDelivery!.visits[0].phase).toBe('acked'));
    expect((await raw()).value.visitDelivery.entries[0].visit).toEqual(snapshot);
    expect((await raw()).value.visitDelivery.entries[0].attempts).toBe(2);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/visits'))).toHaveLength(2);
  });
  it.each(['clear', 'revoke'])('never recreates persistent data after %s with an HTTP response still in flight', async action => {
    await visit(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (_url, init) => { await held; return new Response(JSON.stringify({ ...JSON.parse(init!.body as string), sessionId: SERVER_SESSION_ID, updatedAt: null }), { status: 201 }); });
    await message({ type: 'stop' });
    await vi.waitFor(async () => expect((await raw()).value.visitDelivery.entries[0].phase).toBe('sending'));
    if (action === 'clear') await message({ type: 'clear' });
    else { chromeApi.permissions.onRemoved.listeners[0](); await message({ type: 'status' }); }
    release(); await message({ type: 'status' }); await restart(); await message({ type: 'status' });
    const saved = (await raw()).value; expect(saved.collection.candidates).toEqual([]); expect(saved.visitDelivery.entries).toEqual([]); expect(saved.behaviorDelivery.entries).toEqual([]);
  });
  it('blocks all actions after initialization failure and does not expose private errors', async () => {
    chromeApi.storage.session.get.mockRejectedValue(Error('PRIVATE_ERROR_URL')); await restart();
    const reply = await message({ type: 'start', goalText: '공개 문서 조사하기' }); expect(reply.ok).toBe(false);
    expect(reply.status!.storage!.phase).toBe('failed'); expect(JSON.stringify(reply)).not.toContain('PRIVATE_ERROR_URL'); expect(fetch).not.toHaveBeenCalled();
  });
  it('gates simultaneous popup, content and tab events until initialization completes', async () => {
    await message({ type: 'status' });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    chromeApi.storage.local.get.mockImplementationOnce(async () => { await held; return {}; }); await restart();
    const started = message({ type: 'start', goalText: '공개 문서 조사하기' }), content = message({ type: 'context' }, true);
    chromeApi.tabs.onActivated.listeners[0]({ tabId: 1, windowId: 1 });
    await Promise.resolve(); expect(fetch).not.toHaveBeenCalled(); release();
    expect((await started).ok).toBe(true); expect((await content).sessionId).toBe(SERVER_SESSION_ID);
    expect((await raw()).value.collection.candidates).toHaveLength(1);
  });
  it('commits a PATCH snapshot before HTTP, rolls back its failed ACK commit and replays the same version', async () => {
    await visit(); let releasePost!: () => void, releasePatch!: () => void;
    const postGate = new Promise<void>(resolve => { releasePost = resolve; });
    const patchGate = new Promise<void>(resolve => { releasePatch = resolve; });
    const requests: { method: string; body: any }[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string); requests.push({ method: init!.method!, body });
      if (String(url).endsWith('/visits')) { await postGate; return new Response(JSON.stringify({ ...body, sessionId: SERVER_SESSION_ID, updatedAt: null }), { status: 201 }); }
      const saved = (await raw()).value;
      expect(saved.visitDelivery.entries[0].phase).toBe('acked');
      expect(saved.behaviorDelivery.entries[0]).toMatchObject({ phase: 'sending', request: body });
      await patchGate;
      return new Response(JSON.stringify({ ...body, visitId: saved.visitDelivery.entries[0].visitId, applied: true, updatedAt: '2026-10-18T01:23:45.678Z' }));
    });
    chromeApi.tabs.onRemoved.listeners[0](1); await message({ type: 'status' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    chromeApi.tabs.onActivated.listeners[0]({ tabId: 2, windowId: 1 }); await message({ type: 'status' });
    expect((await raw()).value.behaviorDelivery.entries[0].phase).toBe('waiting-post');
    releasePost(); await vi.waitFor(() => expect(requests).toHaveLength(2));
    const snapshot = structuredClone(requests[1].body), put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const r = put.apply(this, args), entry = (args[0] as any).value.behaviorDelivery?.entries[0];
      if (entry?.phase === 'acked' && entry.ack.behaviorVersion === snapshot.behaviorVersion) r.addEventListener('success', () => this.transaction.abort()); return r;
    });
    releasePatch(); await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.storage!.phase).toBe('failed'));
    const original = (await raw()).value.behaviorDelivery.entries[0];
    expect(original).toMatchObject({ phase: 'sending', attempts: 1, request: snapshot }); expect(original.ack.behaviorVersion).toBeLessThan(snapshot.behaviorVersion);
    fault.mockRestore(); await restart();
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.behaviorDelivery!.visits[0].phase).toBe('acked'));
    expect(requests.map(r => r.method)).toEqual(['POST', 'PATCH', 'PATCH']); expect(requests[2].body).toEqual(snapshot);
    expect((await raw()).value.behaviorDelivery.entries[0].ack).toEqual(snapshot);
  });
  it('uses persisted retry time and an alarm event to resume after a Worker restart', async () => {
    const clock = await visit();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await message({ type: 'stop' });
    await vi.waitFor(async () => expect((await raw()).value.visitDelivery.entries[0].phase).toBe('retry-wait'));
    const before = (await raw()).value.visitDelivery.entries[0];
    const count = vi.mocked(fetch).mock.calls.length; await restart(); await message({ type: 'status' });
    expect(fetch).toHaveBeenCalledTimes(count);
    expect((await raw()).value.visitDelivery.entries[0].nextRetryAt).toBe(before.nextRetryAt);
    clock.mockReturnValue(before.nextRetryAt + 1);
    chromeApi.alarms.onAlarm.listeners[0]({ name: 'durable-delivery' });
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.visitDelivery!.visits[0].phase).toBe('acked'));
    expect((await raw()).value.visitDelivery.entries[0].attempts).toBe(2);
  });

  it('only finalizes a valid detached candidate on explicit stop and keeps its committed duration and ID', async () => {
    const clock = await visit(); const original = (await raw()).value.collection.candidates[0];
    frame.documentId = 'replacement'; clock.mockReturnValue(500000); await restart();
    const restored = (await message({ type: 'status' })).status!.candidates[0];
    expect(restored).toMatchObject({ visitId: original.visitId, sequence: null, recoveryRequired: true, finalized: false, activeDurationMs: 1500 });
    const stopped = (await message({ type: 'stop' })).status!;
    expect(stopped.readyVisits[0]).toMatchObject({ visitId: original.visitId, sequence: 1, activeDurationMs: 1500, behaviorVersion: original.behaviorVersion });
    expect(stopped.recoveryCandidates).toBe(0);
    await vi.waitFor(async () => expect((await message({ type: 'status' })).status!.visitDelivery!.visits[0].phase).toBe('acked'));
  });
  it('preserves the disk aggregate on a conflicting local receipt, including after repeated status requests', async () => {
    await visit(); const before = await raw();
    local.pendingSessionStart = { ...structuredClone(local.activeSession.startRequest), idempotencyKey: crypto.randomUUID() };
    await restart();
    for (let n = 0; n < 2; n++) expect((await message({ type: 'status' })).status!.sessionStartRecovery).toMatchObject({ kind: 'invalid', reason: 'conflicting-records' });
    expect(await raw()).toEqual(before); expect(fetch).toHaveBeenCalledTimes(1);
    const receipt = structuredClone(local.pendingSessionStart); await message({ type: 'clear' });
    expect((await raw()).value.collection.candidates).toEqual([]); expect(local.pendingSessionStart).toEqual(receipt);
  });

  it('reinjects permitted content scripts on extension reload without replacing the existing candidate', async () => {
    await visit(); const id = (await raw()).value.collection.candidates[0].visitId;
    chromeApi.scripting.executeScript.mockClear(); await restart();
    chromeApi.runtime.onInstalled.listeners[0]({ reason: 'update' }); await message({ type: 'status' });
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] });
    expect((await raw()).value.collection.candidates.map((c: any) => c.visitId)).toEqual([id]);
  });

});

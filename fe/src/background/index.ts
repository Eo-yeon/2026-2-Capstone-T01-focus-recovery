import { DurableRepository, LEGACY_KEYS, StorageFailure, isStartRecord, validActiveMetadata, staleLocalMirror, canonical, endDataDrained, type DurableState } from './durable-state';
import { SessionEndDelivery } from './session-end';
import { Collector, emptyState } from './collector';
import { serialExecutor } from './serial';
import { BehaviorDelivery } from './behavior-delivery';
import { VisitDelivery } from './visit-delivery';
import { describeUrl } from '../shared/url';
import { isContentMessage, isPopupMessage } from '../shared/messages';
import type { PendingSessionStart, Reply, ServerSession, SessionStartRecovery } from '../shared/types';
import { API_BASE_URL, ApiError } from '../api/client';
import { createSession, isWorkSession } from '../api/session';
import { normalizeGoal, validGoal } from '../shared/goal';

const enqueue = serialExecutor();
const collector = new Collector();
const repository = new DurableRepository();
let storage: { phase: 'initializing' | 'ready' | 'failed'; recovered: boolean; error?: string; metadataSyncPending?: boolean; legacyCleanupPending?: boolean } = { phase: 'initializing', recovered: false };
let committed: DurableState | undefined;
let localMirror: unknown;
class MetadataMirrorFailure extends Error {}
async function syncLocalMirror(value: unknown) {
  try {
    if (value === undefined) await chrome.storage.local.remove('activeSession');
    else await chrome.storage.local.set({ activeSession: value });
    localMirror = structuredClone(value);
    storage.metadataSyncPending = false;
  } catch {
    storage.metadataSyncPending = true;
    throw new MetadataMirrorFailure();
  }
}
async function persistDelivery() {
  try { await persist(); }
  catch (error) { if (!(error instanceof MetadataMirrorFailure)) throw error; }
}
let endingRequested = false;
let endRequestedAt = 0;
let durablePostAcks = new Set<string>();
function storageFailure(error: unknown) {
  storage = { ...storage, phase: 'failed', error: error instanceof StorageFailure ? error.code : 'storage' };
  delivery.blocked = '영속 저장·복구 오류입니다. 원본을 보존하고 전송을 차단했습니다. 저장 완료로 간주하지 않습니다.';
  behaviors.blocked = delivery.blocked;
  if (committed) {
    collector.restore(structuredClone(committed.collection));
    ending.restore(committed.sessionEnd);
    delivery.checkpoint = structuredClone(committed.visitDelivery ?? { apiBaseUrl: API_BASE_URL, entries: [] });
    behaviors.checkpoint = structuredClone(committed.behaviorDelivery ?? { apiBaseUrl: API_BASE_URL, entries: [] });
  }
  for (const candidate of collector.state.candidates) candidate.activeSince = null;
  collector.state.foregroundTabId = null;
  collector.state.session = null;
}
let pendingStart: PendingSessionStart | undefined;
let activeStart: PendingSessionStart | undefined;
let retainedSession: ServerSession | undefined;
let invalidRecovery: Extract<SessionStartRecovery, { kind: 'invalid' }>['reason'] | undefined;
let startInFlight = false;
let activatedAt = 0;
let needsForegroundRecovery = false;
let focusedWindowId: number | null | undefined;
const activeWindowTabs = new Map<number, number>();
const delivery: VisitDelivery = new VisitDelivery(operation => enqueue(async () => {
  await ready;
  const result = operation();
  await persistDelivery();
  return result;
}).then(result => { behaviors.kick(); ending.kick(); return result; }), () => storage.phase === 'ready' && !pendingStart && !invalidRecovery && !serverEnded());
const behaviors: BehaviorDelivery = new BehaviorDelivery(operation => enqueue(async () => {
  await ready;
  const result = operation();
  await persistDelivery();
  return result;
}).then(result => { ending.kick(); return result; }), visitId => storage.phase === 'ready' && !pendingStart && !invalidRecovery && !delivery.blocked && !serverEnded() && durablePostAcks.has(visitId));
function serverEnded(): boolean { return ending.checkpoint?.lastServer?.status === 'ENDED'; }
const ending: SessionEndDelivery = new SessionEndDelivery(operation => enqueue(async () => {
  await ready;
  const result = operation();
  await persistDelivery();
  return result;
}), () => storage.phase === 'ready' && !pendingStart && !invalidRecovery && !delivery.blocked && !behaviors.blocked,
() => Boolean(committed && endDataDrained(committed)),
() => [...delivery.checkpoint.entries, ...behaviors.checkpoint.entries].some(e => e.code === 'SESSION_ENDED'));
function suspend(now: number) {
  pendingStart ??= activeStart;
  if (!pendingStart && collector.state.session) invalidRecovery ??= 'missing-request';
  collector.suspend(now);
}
function recovery(): SessionStartRecovery {
  if (invalidRecovery) return { kind: 'invalid', reason: invalidRecovery, sessionId: retainedSession?.sessionId };
  if (!pendingStart) return { kind: 'none' };
  const blockedReason = pendingStart.apiBaseUrl !== API_BASE_URL ? 'server-changed'
    : pendingStart.response?.status === 'ENDED' ? 'server-ended' : undefined;
  return { kind: 'pending', goalText: pendingStart.goalText, blockedReason };
}
function status(now: number) {
  const collected = collector.status(endingRequested ? Math.min(now, endRequestedAt) : now);
  if (storage.phase === 'ready') {
    delivery.collect(collected.readyVisits);
    behaviors.collect(collected.readyVisits, delivery.checkpoint.entries);
  }
  const end = ending.checkpoint;
  const sessionEnd = end && (() => {
    const { request: _, session, ...state } = end;
    return { ...structuredClone(state), state: end.phase === 'acked' ? 'ENDED' as const : 'END_PENDING' as const, sessionId: session.sessionId };
  })();
  return { ...collected, sessionEnd, storage: { ...storage }, recoveryCandidates: collector.state.candidates.filter(c => c.recoveryRequired).length, sessionStartRecovery: recovery(), visitDelivery: delivery.status(), behaviorDelivery: behaviors.status() };
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const pending = (await chrome.storage.local.get('pendingSessionStart')).pendingSessionStart;
  if (pending !== undefined) {
    if (isStartRecord(pending)) pendingStart = pending;
    else invalidRecovery = 'corrupted-record';
  }
  const legacy: Partial<DurableState> = {};
  for (const key of LEGACY_KEYS) {
    const value = (await chrome.storage.session.get(key))[key];
    if (value !== undefined) Object.assign(legacy, { [key]: value });
  }
  const localMetadata = (await chrome.storage.local.get('activeSession')).activeSession as (ServerSession & { startRequest?: PendingSessionStart; interrupted?: boolean }) | undefined;
  localMirror = structuredClone(localMetadata);
  if (!validActiveMetadata(localMetadata)) {
    // Preserve malformed recovery metadata; it must not be silently overwritten by a disk mirror.
    if (localMetadata && ('startRequest' in localMetadata || 'interrupted' in localMetadata)) invalidRecovery = 'corrupted-record';
  }
  const hydrated = await repository.initialize({ ...legacy, activeSession: localMetadata });
  const durableMetadata = hydrated.value.activeSession as (ServerSession & { startRequest?: PendingSessionStart }) | undefined;
  const staleMirror = staleLocalMirror(hydrated.value, localMetadata);
  if (!invalidRecovery && !staleMirror && localMetadata) {
    const withoutInterruption = (value: unknown) => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'interrupted')) : value;
    if (canonical(withoutInterruption(durableMetadata)) !== canonical(withoutInterruption(localMetadata))) throw new StorageFailure('conflict');
  }
  const metadata = hydrated.value.activeSession;
  ending.restore(hydrated.value.sessionEnd);
  committed = structuredClone(hydrated.value);
  storage = { phase: 'ready', recovered: hydrated.recovered };
  // The migration receipt and imported data are committed together before cleanup.

  let interrupted = false;
  if (metadata && typeof metadata === 'object' && ('startRequest' in metadata || 'interrupted' in metadata)
    && (!isWorkSession(metadata) || !('source' in metadata) || metadata.source !== 'server' || metadata.status !== 'ACTIVE')) invalidRecovery = 'corrupted-record';
  if (isWorkSession(metadata) && 'source' in metadata && metadata.source === 'server') {
    retainedSession = metadata as ServerSession;
    const saved = metadata as ServerSession & { startRequest?: unknown; interrupted?: unknown };
    interrupted = saved.interrupted === true || (!staleMirror && localMetadata?.interrupted === true);
    if (saved.interrupted !== undefined && typeof saved.interrupted !== 'boolean') invalidRecovery = 'corrupted-record';
    if (saved.startRequest !== undefined) {
      if (isStartRecord(saved.startRequest) && saved.startRequest.response?.status === 'ACTIVE'
        && saved.startRequest.response.sessionId === metadata.sessionId && saved.startRequest.goalText === metadata.goalText
        && saved.startRequest.response.startedAt === metadata.startedAt) activeStart = saved.startRequest;
      else invalidRecovery = 'corrupted-record';
    }
  }
  if (ending.checkpoint?.phase === 'acked' && pendingStart && activeStart
    && (pendingStart.idempotencyKey === activeStart.idempotencyKey
      || pendingStart.response?.sessionId === activeStart.response?.sessionId)) invalidRecovery = 'conflicting-records';
  if (ending.checkpoint?.phase !== 'acked' && pendingStart && activeStart && (pendingStart.idempotencyKey !== activeStart.idempotencyKey
    || pendingStart.goalText !== activeStart.goalText || pendingStart.apiBaseUrl !== activeStart.apiBaseUrl
    || (pendingStart.response && pendingStart.response.sessionId !== activeStart.response?.sessionId))) invalidRecovery = 'conflicting-records';
  const state = hydrated.value.collection;
  if (state.session && (state.session.source !== 'server' || !isWorkSession(state.session))) throw new StorageFailure('corrupt');
  collector.restore(state);
  needsForegroundRecovery = Boolean(state.session);
  const savedDelivery = hydrated.value.visitDelivery;
  // A crash can leave the checkpoint and pending response durable before active metadata.
  if (!activeStart && pendingStart?.response?.status === 'ACTIVE'
    && collector.state.session?.sessionId === pendingStart.response.sessionId) activeStart = pendingStart;
  const expectedSessionId = activeStart?.response?.sessionId;
  delivery.restore(savedDelivery, expectedSessionId ?? collector.state.session?.sessionId ?? collector.state.candidates[0]?.sessionId);
  behaviors.restore(hydrated.value.behaviorDelivery, delivery.checkpoint.entries);
  durablePostAcks = new Set(delivery.checkpoint.entries.filter(e => e.phase === 'acked').map(e => e.visitId));
  await reconcileDocuments();
  if (activeStart && ((collector.state.session && collector.state.session.sessionId !== expectedSessionId)
    || collector.state.candidates.some(candidate => candidate.sessionId !== expectedSessionId))) invalidRecovery = 'conflicting-records';
  if (retainedSession && !pendingStart && !activeStart) invalidRecovery ??= 'missing-request';
  // A committed active receipt proves that pending-key removal was the only unfinished step.
  if (!invalidRecovery && !interrupted && !delivery.blocked && !behaviors.blocked && activeStart?.apiBaseUrl === API_BASE_URL
    && hydrated.value.localMirror && collector.state.session
    && pendingStart && canonical(pendingStart) === canonical(activeStart)) {
    try { await chrome.storage.local.remove('pendingSessionStart'); pendingStart = undefined; }
    catch { storage.metadataSyncPending = true; }
  }
  if (!ending.checkpoint && (invalidRecovery || pendingStart || interrupted || (!collector.state.session && activeStart)
    || (activeStart && activeStart.apiBaseUrl !== API_BASE_URL))) {
    collector.reconcileForeground(null, Date.now());
    suspend(Date.now());
  }
  if (!invalidRecovery && (staleMirror || !collector.state.session && !activeStart && !pendingStart)) {
    try { await syncLocalMirror(metadata); } catch (error) { if (!(error instanceof MetadataMirrorFailure)) throw error; }
  }
  if (!invalidRecovery && !delivery.blocked && !behaviors.blocked) {
    try { await chrome.storage.session.remove(LEGACY_KEYS); }
    catch { storage.legacyCleanupPending = true; }
  }
})().catch(error => {
  storageFailure(error);
  // Keep unread storage untouched and expose a blocked state instead of poisoning every dispatch.
  invalidRecovery = 'initialization-failed';
  try { collector.reconcileForeground(null, Date.now()); collector.suspend(Date.now()); }
  catch { collector.state = emptyState(); }
});
async function persist(explicitClear = false) {
  if (storage.phase !== 'ready') throw new StorageFailure('storage');
  if (delivery.blocked || behaviors.blocked || (invalidRecovery && !explicitClear)) return;
  behaviors.collect(collector.status(Date.now(), false).readyVisits, delivery.checkpoint.entries);
  const value: DurableState = {
    localMirror: { previous: structuredClone(localMirror) },
    collection: collector.state, sessionEnd: ending.checkpoint, visitDelivery: delivery.checkpoint, behaviorDelivery: behaviors.checkpoint,
    activeSession: ending.checkpoint ? { ...ending.checkpoint.session, source: 'server', startRequest: activeStart } : collector.state.session ? { ...collector.state.session, ...(activeStart ? { startRequest: activeStart } : {}) }
      : pendingStart || invalidRecovery ? retainedSession && { ...retainedSession, ...(activeStart ? { startRequest: activeStart } : {}), interrupted: true } : undefined,
  };
  try { await repository.save(value); }
  catch (error) { storageFailure(error); throw error; }
  committed = structuredClone(value);
  durablePostAcks = new Set(delivery.checkpoint.entries.filter(e => e.phase === 'acked').map(e => e.visitId));
  if (invalidRecovery) return;
  if (ending.checkpoint) {
    await syncLocalMirror(value.activeSession);
  } else if (collector.state.session) {
    retainedSession = collector.state.session;
    await syncLocalMirror(value.activeSession);
  } else if (!pendingStart && !activeStart && !invalidRecovery) await syncLocalMirror(undefined);
}
// Document IDs, unlike tab IDs and URLs alone, identify the same live Chrome document.
async function reconcileDocuments() {
  for (const candidate of collector.state.candidates) candidate.activeSince = null;
  collector.state.foregroundTabId = null;
  let detached = false;
  for (const [id, saved] of Object.entries(collector.state.tabs)) {
    const tabId = Number(id);
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId, frameId: 0 }));
    const url = frame && !frame.errorOccurred && await hasPermission(frame.url) ? await describeUrl(frame.url) : null;
    if (!frame || frame.documentId !== saved.documentId || !url || url.identity !== saved.currentIdentity) {
      const candidate = collector.current(tabId);
      if (candidate && !candidate.finalized) candidate.recoveryRequired = true;
      delete collector.state.tabs[tabId];
      detached = true;
    }
  }
  if (detached) { collector.state.lastActiveTabId = null; collector.state.lastActiveVisitId = null; }
}
function dispatch<T>(operation: (now: number) => Promise<T>, foregroundEvent = false): Promise<T> {
  const arrivedAt = Date.now();
  return enqueue(async () => {
    const now = Math.max(arrivedAt, activatedAt);
    try {
      await ready;
      if (needsForegroundRecovery) {
        needsForegroundRecovery = false;
        // No checkpoint proves what happened during suspension, even for matching endpoints.
        collector.reconcileForeground(null, now);
        if (!foregroundEvent) await refreshForeground(now);
      }
      if (storage.phase === 'failed') return await operation(now);
      const result = await operation(now);
      delivery.collect(collector.status(now, false).readyVisits);
      await persist();
      // Remove the recovery record only after the active checkpoint and metadata are durable.
      if (pendingStart?.response && pendingStart.response.sessionId === collector.state.session?.sessionId) {
        await chrome.storage.local.remove('pendingSessionStart');
        pendingStart = undefined;
      }
      return result;
    } catch (error) {
      // The aggregate already committed: a mirror failure must not rewrite a completed stop or ACK.
      if (error instanceof MetadataMirrorFailure) {
        if (!ending.checkpoint && collector.state.session) { retainedSession = collector.state.session; suspend(Date.now()); }
        throw error;
      }
      if (ending.checkpoint || endingRequested) throw error;
      // Stop collection independently of the durable request/response receipt.
      retainedSession ??= collector.state.session ?? undefined;
      try { suspend(Date.now()); }
      catch { collector.state = emptyState(); }
      if (retainedSession && (!invalidRecovery || invalidRecovery === 'missing-request')) {
        await syncLocalMirror({ ...retainedSession, ...(activeStart ? { startRequest: activeStart } : {}), interrupted: true }).catch(() => undefined);
      }
      if (storage.phase === 'ready') await persist().catch(() => undefined);
      throw error;
    }
  }).finally(() => { delivery.kick(); behaviors.kick(); ending.kick(); });
}
function event(operation: (now: number) => Promise<unknown>, foregroundEvent = false, duringEnd = false) {
  // Never log raw URLs, payloads, goals or platform error messages.
  void dispatch(async now => { if (storage.phase === 'ready' && (duringEnd || !ending.checkpoint && !endingRequested)) return operation(now); }, foregroundEvent).catch(() => undefined);
}
async function readBrowserState<T>(query: () => Promise<T>): Promise<T | undefined> {
  // Only browser state queries are recoverable here; storage and unknown errors escape.
  try { return await query(); }
  catch { return undefined; }
}
async function readFocusedWindow(): Promise<number | null | undefined> {
  const windows = await readBrowserState(() => chrome.windows.getAll());
  if (windows === undefined) return undefined;
  const focused = windows.filter(window => window.focused && window.state !== 'minimized');
  return focused.length > 1 ? undefined : focused[0]?.id ?? null;
}
async function refreshForeground(now: number) {
  if (endingRequested || ending.checkpoint) return;
  collector.foreground(null, now);
  const windowId = focusedWindowId = await readFocusedWindow();
  const tabs = windowId == null ? [] : await readBrowserState(() => chrome.tabs.query({ active: true, windowId }));
  const tabId = tabs?.[0]?.id ?? null;
  if (tabs === undefined) focusedWindowId = undefined;
  if (windowId != null && tabId !== null) activeWindowTabs.set(windowId, tabId);
  // Queries describe their completion time, never an earlier queued event's foreground.
  if (!endingRequested && !ending.checkpoint) collector.foreground(tabId, Math.max(now, Date.now()));
}
async function resumeDocument(tabId: number, now: number) {
  if (endingRequested || ending.checkpoint) return;
  if (focusedWindowId === undefined) await refreshForeground(now);
  else if (focusedWindowId !== null && collector.state.foregroundTabId === null && activeWindowTabs.get(focusedWindowId) === tabId) collector.foreground(tabId, now);
}
async function focusWindow(windowId: number, tabId: number | undefined, now: number) {
  focusedWindowId = windowId === chrome.windows.WINDOW_ID_NONE || windowId === -1 ? null : windowId;
  collector.foreground(null, now);
  if (focusedWindowId === null) return;
  if (tabId !== undefined) collector.foreground(tabId, now);
  else {
    const tabs = await readBrowserState(() => chrome.tabs.query({ active: true, windowId }));
    const observed = tabs?.[0]?.id;
    if (observed !== undefined) {
      activeWindowTabs.set(windowId, observed);
      if (!endingRequested && !ending.checkpoint) collector.foreground(observed, Math.max(now, Date.now()));
    }
  }
}
async function hasPermission(raw: string) {
  if (isApiHost(raw)) return false;
  try { return await chrome.permissions.contains({ origins: [`${new URL(raw).origin}/*`] }); }
  catch { return false; }
}
function isApiHost(raw: string): boolean {
  try {
    const url = new URL(raw), api = new URL(API_BASE_URL);
    // Chrome host permissions cover every port on this host.
    return url.protocol === api.protocol && url.hostname === api.hostname;
  } catch { return true; }
}
async function broadcast() {
  const tabs = await readBrowserState(() => chrome.tabs.query({}));
  if (!tabs) return;
  await Promise.all(tabs.filter(tab => tab.id !== undefined).map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'session-changed' }).catch(() => undefined)));
}
async function syncScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter(origin => /^https?:\/\//.test(origin) && !isApiHost(origin));
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  if (scripts.some(script => script.id === 'collector')) await chrome.scripting.unregisterContentScripts({ ids: ['collector'] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{ id: 'collector', js: ['content.js'], matches, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
    const tabs = await readBrowserState(() => chrome.tabs.query({}));
    if (!tabs) return;
    for (const tab of tabs) {
      if (tab.id !== undefined && (!tab.url || !isApiHost(tab.url))) {
        // Permission checks do not need tabs permission or access to background tab URLs.
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch { /* Restricted/unpermitted tabs are skipped. */ }
      }
    }
  }
}
async function startSession(goal: string): Promise<string | undefined> {
  if (endingRequested || ending.checkpoint && ending.checkpoint.phase !== 'acked') return '서버 종료 확인 전에는 새 세션을 시작할 수 없습니다.';
  if (storage.phase !== 'ready') return '영속 저장소 복구를 완료한 뒤 시작해 주세요.';
  if (!pendingStart && collector.state.candidates.some(c => c.recoveryRequired)) return '동일한 문서를 확인하지 못한 후보가 있습니다. 원본을 확인하거나 로컬 기록을 명시적으로 삭제해 주세요.';
  if (invalidRecovery) return '시작 요청 정보 확인이 필요합니다. 원본을 보존한 채 서버 상태를 확인해 주세요.';
  if (collector.state.session) return '이미 활성 세션이 있습니다.';
  if (!pendingStart && (delivery.hasUnconfirmed() || behaviors.hasUnconfirmed())) return '저장 또는 행동 갱신이 확인되지 않은 방문이 있습니다. 전송 상태를 확인하고 재시도하거나 로컬 기록을 명시적으로 삭제해 주세요.';
  const goalText = normalizeGoal(goal);
  if (!validGoal(goalText)) return '목표는 앞뒤 공백을 제외하고 5~150자로 입력해 주세요.';
  if (pendingStart && (pendingStart.goalText !== goalText || pendingStart.apiBaseUrl !== API_BASE_URL)) {
    return '확인되지 않은 이전 시작 요청이 있습니다. 기존 목표와 서버 설정으로 같은 요청을 재시도해 주세요.';
  }
  const retry = Boolean(pendingStart);
  pendingStart ??= { idempotencyKey: crypto.randomUUID(), goalText, apiBaseUrl: API_BASE_URL };
  // Persist before sending: worker termination cannot cause a retry with a fresh key.
  await chrome.storage.local.set({ pendingSessionStart: pendingStart });
  try {
    const response = pendingStart.response ?? await createSession({ goalText }, pendingStart.idempotencyKey);
    pendingStart.response = response;
    await chrome.storage.local.set({ pendingSessionStart: pendingStart });
    if (response.status !== 'ACTIVE') return '기존 서버 세션이 이미 종료되었습니다. 서버 상태를 확인해 주세요.';
    if (ending.checkpoint?.phase === 'acked' && response.sessionId === ending.checkpoint.session.sessionId) return '이미 종료한 세션의 ACTIVE 응답이 남아 있습니다. 원본을 보존하고 서버 상태를 확인해 주세요.';
    activatedAt = Date.now();
    if (ending.checkpoint?.phase === 'acked') { ending.clear(); activeStart = undefined; retainedSession = undefined; }
    if (activeStart) collector.resume(response);
    else { ending.clear(); collector.start(response); delivery.clear(); behaviors.clear(); }
    activeStart = pendingStart;
    await persist();
    await refreshForeground(Date.now());
    await syncScripts();
    await broadcast();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // A definitive validation rejection creates no session. Uncertain outcomes and conflicts retain the key.
    if (error.status === 400 && !retry) {
      await chrome.storage.local.remove('pendingSessionStart');
      pendingStart = undefined;
    }
    return error.message;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: Reply) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const tabId = sender.tab?.id;
  if (popup ? !isPopupMessage(message) : !isContentMessage(message) || tabId === undefined || sender.frameId !== 0 || !sender.documentId || sender.documentLifecycle !== 'active') return false;
  const endingMessage = popup && isPopupMessage(message) && message.type === 'end-session';
  if (endingMessage && endingRequested) { sendResponse({ ok: false, error: '종료 요청을 저장 중입니다.' }); return false; }
  if (endingMessage) { endingRequested = true; endRequestedAt = Date.now(); }
  const starting = popup && isPopupMessage(message) && message.type === 'start';
  if (starting && startInFlight) {
    sendResponse({ ok: false, error: '세션 생성 요청을 처리 중입니다. 잠시 기다려 주세요.' });
    return false;
  }
  if (starting) startInFlight = true;
  const reply = (result: Reply) => {
    if (starting) startInFlight = false;
    if (endingMessage) endingRequested = false;
    sendResponse(result);
  };
  void dispatch(async (now): Promise<Reply> => {
    if (popup && isPopupMessage(message)) {
      if ((storage.phase !== 'ready' || invalidRecovery === 'initialization-failed') && message.type !== 'status') return { ok: false, error: '저장된 상태를 확인할 수 없습니다. 확장 프로그램 상태를 확인하고 Worker를 재시작해 주세요.', status: status(now) };
      if (message.type === 'start') {
        const error = await startSession(message.goalText);
        if (error) return { ok: false, error, status: status(Date.now()) };
      } else if (message.type === 'end-session') {
        if (!ending.checkpoint) {
          const session = collector.state.session;
          if (!session || pendingStart || invalidRecovery || !activeStart) return { ok: false, error: '종료할 활성 세션의 생성 영수증 확인이 필요합니다.', status: status(now) };
          collector.stop(now);
          ending.begin(session, now);
          delivery.collect(collector.status(now, false).readyVisits);
          await persistDelivery();
        }
        await broadcast();
      } else if (message.type === 'retry-end') {
        ending.retry();
      } else if (message.type === 'stop') {
        if (ending.checkpoint) return { ok: true, status: status(now) };

        const wasActive = Boolean(collector.state.session);
        collector.stop(now);
        if (wasActive && !pendingStart && !invalidRecovery) {
          // A local stop is the only action that intentionally releases a completed receipt.
          const stoppedStart = activeStart;
          activeStart = undefined;
          try { await persist(); }
          catch (error) {
            if (error instanceof MetadataMirrorFailure) retainedSession = undefined;
            else activeStart = stoppedStart;
            throw error;
          }
          retainedSession = undefined;
        }
        await broadcast();
      } else if (message.type === 'clear') {
        if (collector.state.session) return { ok: false, error: '세션 종료 후 기록을 지워 주세요.' };
        collector.state = emptyState(activeStart && !ending.checkpoint ? collector.state.nextSequence : 1);
        if (ending.checkpoint) { ending.clear(); activeStart = undefined; retainedSession = undefined; }
        delivery.clear(); behaviors.clear();
        durablePostAcks.clear();
        await persist(true);
      } else if (message.type === 'retry-visits') {
        delivery.retry();
      } else if (message.type === 'retry-behaviors') {
        behaviors.retry();
      } else if (message.type === 'sync-permissions') {
        await syncScripts();
        await broadcast();
      }
      return { ok: true, status: status(Math.max(now, Date.now())) };
    }
    if (storage.phase !== 'ready') return { ok: false, sessionId: null };
    if (tabId === undefined || !sender.documentId || !isContentMessage(message)) return { ok: false };
    if (endingRequested || ending.checkpoint || !collector.state.session || collector.state.capacityReached) return { ok: true, sessionId: null };
    if (message.type !== 'context' && message.sessionId !== collector.state.session.sessionId) return { ok: true, sessionId: null };
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId, frameId: 0 }));
    if (endingRequested || ending.checkpoint) return { ok: true, sessionId: null };
    if (frame && frame.documentId !== sender.documentId) return { ok: true, sessionId: null };
    if (!frame || !await hasPermission(frame.url)) {
      if (collector.state.foregroundTabId === tabId) collector.foreground(null, now);
      return { ok: true, sessionId: null };
    }
    if (frame.errorOccurred) {
      const url = await describeUrl(frame.url);
      collector.navigationError(tabId, frame.documentId, url?.identity ?? null, now);
      if (collector.state.foregroundTabId === tabId && !collector.state.tabs[tabId]?.navigationFailed) collector.foreground(null, now);
      return { ok: true, sessionId: null };
    }
    if (endingRequested || ending.checkpoint) return { ok: true, sessionId: null };
    if (message.type === 'context') {
      const url = await describeUrl(frame.url);
      if (endingRequested || ending.checkpoint) return { ok: true, sessionId: null };
      const tab = collector.state.tabs[tabId];
      const granted = tab?.documentId === sender.documentId && tab.awaitingPermission === true;
      if (granted) delete tab.awaitingPermission;
      // Start a fresh post-grant candidate; never revive a policy-excluded sample.
      collector.navigate(tabId, sender.documentId, url?.identity ?? null, granted && url ? 'spa' : 'existing', now);
      await resumeDocument(tabId, now);
    } else if (message.type === 'leave') {
      collector.leave(tabId, sender.documentId, now);
    } else {
      const expected = await describeUrl(frame.url);
      if (endingRequested || ending.checkpoint) return { ok: true, sessionId: null };
      const snapshot = message.snapshot;
      if (snapshot && (!expected || Object.keys(expected).some(key => key === 'searchQuery' ? expected.searchQuery !== (snapshot.searchQuery ?? null) : expected[key as keyof typeof expected] !== snapshot[key as keyof typeof expected]))) return { ok: false };
      collector.observe(tabId, sender.documentId, message.sessionId, snapshot, message.reason, now);
    }
    return { ok: true, sessionId: collector.state.session?.sessionId ?? null };
  }).then(reply).catch(error => {
    reply({ ok: false, error: error instanceof MetadataMirrorFailure ? 'IndexedDB 저장은 완료했지만 로컬 메타데이터 동기화에 실패했습니다. 상태를 다시 확인해 주세요.' : '요청 처리에 실패해 수집을 중단했습니다. 기존 세션의 복구 상태를 확인해 주세요.', status: status(Date.now()) });
  });
  return true;
});
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  event(async now => {
    if (!collector.state.session) return;
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }));
    if (!frame) {
      if (collector.state.foregroundTabId === details.tabId) collector.foreground(null, now);
      return;
    }
    if (frame.documentId !== details.documentId) return;
    const allowed = await hasPermission(details.url);
    const inspected = await describeUrl(details.url);
    const url = allowed ? inspected : null;
    if (endingRequested || ending.checkpoint) return;
    collector.navigate(details.tabId, details.documentId, url?.identity ?? null, details.transitionType === 'reload' ? 'reload' : 'new', now);
    const tab = collector.state.tabs[details.tabId];
    if (!allowed && inspected && !isApiHost(details.url) && !frame.errorOccurred && tab?.identity === null
      && collector.current(details.tabId)?.reason === 'url-policy') tab.awaitingPermission = true;
    if (frame.errorOccurred) collector.navigationError(details.tabId, frame.documentId, url?.identity ?? null, now);
    await resumeDocument(details.tabId, now);
    await chrome.tabs.sendMessage(details.tabId, { type: 'capture' }).catch(() => undefined);
  });
});
// Chrome observes pushState/replaceState across isolated worlds; no MAIN-world patch needed.
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId === 0) event(async () => {
    if (collector.state.session) await chrome.tabs.sendMessage(details.tabId, { type: 'capture' }).catch(() => undefined);
  });
});
chrome.tabs.onActivated.addListener(info => {
  activeWindowTabs.set(info.windowId, info.tabId);
  event(async now => {
    if (focusedWindowId === undefined) focusedWindowId = await readFocusedWindow();
    if (info.windowId === focusedWindowId) collector.foreground(info.tabId, now);
    await broadcast();
  }, true);
});
chrome.windows.onFocusChanged.addListener(windowId => {
  // Capture the known selection before later activation events change the per-window cache.
  const tabId = activeWindowTabs.get(windowId);
  event(async now => { await focusWindow(windowId, tabId, now); await broadcast(); }, true);
});
chrome.windows.onBoundsChanged.addListener(window => event(async now => {
  if (window.id === focusedWindowId && window.state === 'minimized') {
    focusedWindowId = null;
    collector.foreground(null, now);
  } else if (focusedWindowId === undefined || window.focused) await refreshForeground(now);
}, true));
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [windowId, active] of activeWindowTabs) if (active === tabId) activeWindowTabs.delete(windowId);
  event(async now => { collector.removeTab(tabId, now); });
});
chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId === 0) event(async now => {
    const tab = collector.state.tabs[details.tabId];
    if (!collector.state.session || !details.documentId || tab?.documentId !== details.documentId) return;
    const url = await describeUrl(details.url);
    if (!url || url.identity !== tab.currentIdentity) return;
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }));
    if (!frame?.errorOccurred || frame.documentId !== details.documentId) return;
    const currentUrl = await describeUrl(frame.url);
    if (currentUrl?.identity === url.identity) collector.navigationError(details.tabId, details.documentId, url.identity, now);
  });
});
chrome.permissions.onAdded.addListener(() => event(syncScripts));
chrome.permissions.onRemoved.addListener(() => event(async now => {
  // An explicit server-end intent survives revocation; erase only on explicit clear.
  if (ending.checkpoint) { await syncScripts(); await broadcast(); return; }
  // Revocation is privacy-sensitive: stop and erase all in-memory samples.
  suspend(now);
  // Issued numbers may already be committed on the server, even without an ACK.
  collector.state = emptyState(collector.state.nextSequence);
  delivery.clear(); behaviors.clear();
  durablePostAcks.clear();
  await persist(true);
  await syncScripts();
  await broadcast();
}, false, true));

const RECOVERY_ALARM = 'durable-delivery';
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === RECOVERY_ALARM) event(async () => undefined, false, true); });
async function resumeScripts() {
  if (!collector.state.session || pendingStart || invalidRecovery) return;
  // Reload invalidates old isolated-world scripts even when the page document survives.
  await syncScripts();
  await broadcast();
}
chrome.runtime.onStartup.addListener(() => event(resumeScripts, true));
chrome.runtime.onInstalled.addListener(() => event(resumeScripts, true));
// Recreate the wakeup on every Worker start; older Chrome may discard alarms at restart.
void ready.then(async () => {
  if (storage.phase !== 'ready') return;
  await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
  delivery.kick(); behaviors.kick(); ending.kick();
}).catch(() => undefined);

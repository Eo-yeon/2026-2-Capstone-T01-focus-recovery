import { Collector, emptyState } from './collector';
import { serialExecutor } from './serial';
import { VisitDelivery } from './visit-delivery';
import { describeUrl } from '../shared/url';
import { isContentMessage, isPopupMessage } from '../shared/messages';
import type { CollectionState, PendingSessionStart, Reply, ServerSession, SessionStartRecovery } from '../shared/types';
import { API_BASE_URL, ApiError } from '../api/client';
import { createSession, isWorkSession, UUID } from '../api/session';
import { normalizeGoal, validGoal } from '../shared/goal';
import { isApiOrigin } from '../shared/api-origin';

const enqueue = serialExecutor();
const collector = new Collector();
let pendingStart: PendingSessionStart | undefined;
let activeStart: PendingSessionStart | undefined;
let retainedSession: ServerSession | undefined;
let invalidRecovery: Extract<SessionStartRecovery, { kind: 'invalid' }>['reason'] | undefined;
let startInFlight = false;
let activatedAt = 0;
let needsForegroundRecovery = false;
let focusedWindowId: number | null | undefined;
const activeWindowTabs = new Map<number, number>();
const delivery = new VisitDelivery(operation => enqueue(async () => {
  await ready;
  const result = operation();
  await persist();
  return result;
}), () => !pendingStart && !invalidRecovery);
function isStartRecord(value: unknown): value is PendingSessionStart {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.idempotencyKey === 'string' && UUID.test(v.idempotencyKey)
    && typeof v.goalText === 'string' && validGoal(v.goalText) && normalizeGoal(v.goalText) === v.goalText
    && isApiOrigin(v.apiBaseUrl)
    && (v.response === undefined || (isWorkSession(v.response) && v.response.goalText === v.goalText));
}
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
  const collected = collector.status(now);
  delivery.collect(collected.readyVisits);
  return { ...collected, sessionStartRecovery: recovery(), visitDelivery: delivery.status() };
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const pending = (await chrome.storage.local.get('pendingSessionStart')).pendingSessionStart;
  if (pending !== undefined) {
    if (isStartRecord(pending)) pendingStart = pending;
    else invalidRecovery = 'corrupted-record';
  }
  const metadata = (await chrome.storage.local.get('activeSession')).activeSession;
  let interrupted = false;
  if (metadata && typeof metadata === 'object' && ('startRequest' in metadata || 'interrupted' in metadata)
    && (!isWorkSession(metadata) || !('source' in metadata) || metadata.source !== 'server' || metadata.status !== 'ACTIVE')) invalidRecovery = 'corrupted-record';
  if (isWorkSession(metadata) && 'source' in metadata && metadata.source === 'server') {
    retainedSession = metadata as ServerSession;
    const saved = metadata as ServerSession & { startRequest?: unknown; interrupted?: unknown };
    interrupted = saved.interrupted === true;
    if (saved.interrupted !== undefined && typeof saved.interrupted !== 'boolean') invalidRecovery = 'corrupted-record';
    if (saved.startRequest !== undefined) {
      if (isStartRecord(saved.startRequest) && saved.startRequest.response?.status === 'ACTIVE'
        && saved.startRequest.response.sessionId === metadata.sessionId && saved.startRequest.goalText === metadata.goalText
        && saved.startRequest.response.startedAt === metadata.startedAt) activeStart = saved.startRequest;
      else invalidRecovery = 'corrupted-record';
    }
  }
  if (pendingStart && activeStart && (pendingStart.idempotencyKey !== activeStart.idempotencyKey
    || pendingStart.goalText !== activeStart.goalText || pendingStart.apiBaseUrl !== activeStart.apiBaseUrl
    || (pendingStart.response && pendingStart.response.sessionId !== activeStart.response?.sessionId))) invalidRecovery = 'conflicting-records';
  const saved = await chrome.storage.session.get('collection');
  const savedDelivery = (await chrome.storage.session.get('visitDelivery')).visitDelivery;
  if (saved.collection) {
    const state = saved.collection as CollectionState;
    if (state.session && (state.session.source !== 'server' || !isWorkSession(state.session) || state.session.status !== 'ACTIVE')) {
      await chrome.storage.session.remove('collection');
    } else {
      collector.restore(state);
      needsForegroundRecovery = true;
    }
  }
  // A crash can leave the checkpoint and pending response durable before active metadata.
  if (!activeStart && pendingStart?.response?.status === 'ACTIVE'
    && collector.state.session?.sessionId === pendingStart.response.sessionId) activeStart = pendingStart;
  const expectedSessionId = activeStart?.response?.sessionId;
  delivery.restore(savedDelivery, expectedSessionId ?? collector.state.session?.sessionId ?? collector.state.candidates[0]?.sessionId);
  if (activeStart && ((collector.state.session && collector.state.session.sessionId !== expectedSessionId)
    || collector.state.candidates.some(candidate => candidate.sessionId !== expectedSessionId))) invalidRecovery = 'conflicting-records';
  if (!collector.state.session && retainedSession && !pendingStart && !activeStart) invalidRecovery ??= 'missing-request';
  if (invalidRecovery || pendingStart || interrupted || (!collector.state.session && activeStart)
    || (activeStart && activeStart.apiBaseUrl !== API_BASE_URL)) {
    collector.reconcileForeground(null, Date.now());
    suspend(Date.now());
  } else if (!collector.state.session) await chrome.storage.local.remove('activeSession');
})().catch(() => {
  // Keep unread storage untouched and expose a blocked state instead of poisoning every dispatch.
  invalidRecovery = 'initialization-failed';
  try { collector.reconcileForeground(null, Date.now()); collector.suspend(Date.now()); }
  catch { collector.state = emptyState(); }
});
async function persist() {
  if (invalidRecovery === 'initialization-failed') return;
  await chrome.storage.session.set({ collection: collector.state, ...(!delivery.blocked ? { visitDelivery: delivery.checkpoint } : {}) });
  if (collector.state.session) {
    retainedSession = collector.state.session;
    await chrome.storage.local.set({ activeSession: { ...retainedSession, ...(activeStart ? { startRequest: activeStart } : {}) } });
  } else if (!pendingStart && !activeStart && !invalidRecovery) await chrome.storage.local.remove('activeSession');
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
      // Stop collection independently of the durable request/response receipt.
      retainedSession ??= collector.state.session ?? undefined;
      try { suspend(Date.now()); }
      catch { collector.state = emptyState(); }
      if (retainedSession && (!invalidRecovery || invalidRecovery === 'missing-request')) {
        await chrome.storage.local.set({ activeSession: { ...retainedSession, ...(activeStart ? { startRequest: activeStart } : {}), interrupted: true } }).catch(() => undefined);
      }
      try { await persist(); }
      // shortcut: total storage failure cannot persist suspension; revisit with durable server reconciliation.
      catch { await chrome.storage.session.remove('collection').catch(() => undefined); }
      throw error;
    }
  }).then(result => { delivery.kick(); return result; });
}
function event(operation: (now: number) => Promise<unknown>, foregroundEvent = false) {
  // Never log raw URLs, payloads, goals or platform error messages.
  void dispatch(operation, foregroundEvent).catch(() => undefined);
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
  collector.foreground(null, now);
  const windowId = focusedWindowId = await readFocusedWindow();
  const tabs = windowId == null ? [] : await readBrowserState(() => chrome.tabs.query({ active: true, windowId }));
  const tabId = tabs?.[0]?.id ?? null;
  if (tabs === undefined) focusedWindowId = undefined;
  if (windowId != null && tabId !== null) activeWindowTabs.set(windowId, tabId);
  // Queries describe their completion time, never an earlier queued event's foreground.
  collector.foreground(tabId, Math.max(now, Date.now()));
}
async function resumeDocument(tabId: number, now: number) {
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
      collector.foreground(observed, Math.max(now, Date.now()));
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
  if (invalidRecovery) return '시작 요청 정보 확인이 필요합니다. 원본을 보존한 채 서버 상태를 확인해 주세요.';
  if (collector.state.session) return '이미 활성 세션이 있습니다.';
  if (!pendingStart && delivery.hasUnconfirmed()) return '저장이 확인되지 않은 방문이 있습니다. 전송 상태를 확인하고 재시도하거나 로컬 기록을 명시적으로 삭제해 주세요.';
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
    activatedAt = Date.now();
    if (activeStart) collector.resume(response);
    else { collector.start(response); delivery.clear(); }
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
  const starting = popup && isPopupMessage(message) && message.type === 'start';
  if (starting && startInFlight) {
    sendResponse({ ok: false, error: '세션 생성 요청을 처리 중입니다. 잠시 기다려 주세요.' });
    return false;
  }
  if (starting) startInFlight = true;
  const reply = (result: Reply) => {
    if (starting) startInFlight = false;
    sendResponse(result);
  };
  void dispatch(async (now): Promise<Reply> => {
    if (popup && isPopupMessage(message)) {
      if (invalidRecovery === 'initialization-failed' && message.type !== 'status') return { ok: false, error: '저장된 상태를 확인할 수 없습니다. 확장 프로그램 상태를 확인하고 Worker를 재시작해 주세요.', status: status(now) };
      if (message.type === 'start') {
        const error = await startSession(message.goalText);
        if (error) return { ok: false, error, status: status(Date.now()) };
      } else if (message.type === 'stop') {
        const wasActive = Boolean(collector.state.session);
        collector.stop(now);
        if (wasActive && !pendingStart && !invalidRecovery) {
          // A local stop is the only action that intentionally releases a completed receipt.
          await chrome.storage.session.set({ collection: collector.state });
          await chrome.storage.local.remove('activeSession');
          activeStart = undefined;
          retainedSession = undefined;
        }
        await broadcast();
      } else if (message.type === 'clear') {
        if (collector.state.session) return { ok: false, error: '세션 종료 후 기록을 지워 주세요.' };
        collector.state = emptyState();
        delivery.clear();
        await chrome.storage.session.remove('visitDelivery');
      } else if (message.type === 'retry-visits') {
        delivery.retry();
      } else if (message.type === 'sync-permissions') {
        await syncScripts();
        await broadcast();
      }
      return { ok: true, status: status(Math.max(now, Date.now())) };
    }
    if (tabId === undefined || !sender.documentId || !isContentMessage(message)) return { ok: false };
    if (!collector.state.session || collector.state.capacityReached) return { ok: true, sessionId: null };
    if (message.type !== 'context' && message.sessionId !== collector.state.session.sessionId) return { ok: true, sessionId: null };
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId, frameId: 0 }));
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
    if (message.type === 'context') {
      const url = await describeUrl(frame.url);
      collector.navigate(tabId, sender.documentId, url?.identity ?? null, 'existing', now);
      await resumeDocument(tabId, now);
    } else if (message.type === 'leave') {
      collector.leave(tabId, sender.documentId, now);
    } else {
      const expected = await describeUrl(frame.url);
      const snapshot = message.snapshot;
      if (snapshot && (!expected || Object.keys(expected).some(key => key === 'searchQuery' ? expected.searchQuery !== (snapshot.searchQuery ?? null) : expected[key as keyof typeof expected] !== snapshot[key as keyof typeof expected]))) return { ok: false };
      collector.observe(tabId, sender.documentId, message.sessionId, snapshot, message.reason, now);
    }
    return { ok: true, sessionId: collector.state.session?.sessionId ?? null };
  }).then(reply).catch(() => {
    reply({ ok: false, error: '요청 처리에 실패해 수집을 중단했습니다. 기존 세션의 복구 상태를 확인해 주세요.', status: status(Date.now()) });
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
    const url = allowed ? await describeUrl(details.url) : null;
    collector.navigate(details.tabId, details.documentId, url?.identity ?? null, details.transitionType === 'reload' ? 'reload' : 'new', now);
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
  // Revocation is privacy-sensitive: stop and erase all in-memory samples.
  suspend(now);
  collector.state = emptyState();
  delivery.clear();
  await chrome.storage.session.remove('visitDelivery');
  await syncScripts();
  await broadcast();
}));

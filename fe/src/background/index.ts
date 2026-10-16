import { Collector, emptyState } from './collector';
import { serialExecutor } from './serial';
import { describeUrl } from '../shared/url';
import { isContentMessage, isPopupMessage } from '../shared/messages';
import type { CollectionState, PendingSessionStart, Reply } from '../shared/types';
import { API_BASE_URL, ApiError } from '../api/client';
import { createSession, isWorkSession, UUID } from '../api/session';
import { normalizeGoal, validGoal } from '../shared/goal';

const enqueue = serialExecutor();
const collector = new Collector();
let pendingStart: PendingSessionStart | undefined;
let startInFlight = false;
let activatedAt = 0;
let needsForegroundRecovery = false;
let focusedWindowId: number | null | undefined;
const activeWindowTabs = new Map<number, number>();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const pending = (await chrome.storage.local.get('pendingSessionStart')).pendingSessionStart as Record<string, unknown> | undefined;
  if (pending) {
    if (typeof pending.idempotencyKey !== 'string' || !UUID.test(pending.idempotencyKey)
      || typeof pending.goalText !== 'string' || !validGoal(pending.goalText) || normalizeGoal(pending.goalText) !== pending.goalText
      || typeof pending.apiBaseUrl !== 'string'
      || (pending.response !== undefined && (!isWorkSession(pending.response) || pending.response.goalText !== pending.goalText))) throw new Error('Invalid pending start');
    pendingStart = pending as unknown as PendingSessionStart;
  }
  const saved = await chrome.storage.session.get('collection');
  if (saved.collection) {
    const state = saved.collection as CollectionState;
    // Old development-local sessions must never become server-backed sessions on upgrade.
    if (state.session && (state.session.source !== 'server' || !isWorkSession(state.session) || state.session.status !== 'ACTIVE')) {
      await chrome.storage.session.remove('collection');
      await chrome.storage.local.remove('activeSession');
      return;
    }
    collector.restore(state);
    if (pendingStart && state.session) {
      // A crash before clearing pendingStart did not complete activation; require explicit recovery.
      collector.reconcileForeground(null, Date.now());
      collector.stop(Date.now());
    }
    needsForegroundRecovery = true;
  }
  // Browser restart/extension reload loses session storage: require a new explicit start.
  else await chrome.storage.local.remove('activeSession');
})();
// Retain the rejection for dispatch, without an unhandled platform error log.
void ready.catch(() => undefined);
async function persist() {
  await chrome.storage.session.set({ collection: collector.state });
  if (collector.state.session) await chrome.storage.local.set({ activeSession: collector.state.session });
  else await chrome.storage.local.remove('activeSession');
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
      await persist();
      // Remove the recovery record only after the active checkpoint and metadata are durable.
      if (pendingStart?.response && pendingStart.response.sessionId === collector.state.session?.sessionId) {
        await chrome.storage.local.remove('pendingSessionStart');
        pendingStart = undefined;
      }
      return result;
    } catch (error) {
      // Fail closed inside the same queue, before any later event can start a session.
      try { collector.stop(Date.now()); }
      catch { collector.state = emptyState(); }
      try { await persist(); }
      catch {
        await chrome.storage.local.remove('activeSession').catch(() => undefined);
        await chrome.storage.session.remove('collection').catch(() => undefined);
      }
      throw error;
    }
  });
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
  if (collector.state.session) return '이미 활성 세션이 있습니다.';
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
    collector.start(response);
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
      if (message.type === 'start') {
        const error = await startSession(message.goalText);
        if (error) return { ok: false, error, status: { ...collector.status(Date.now()), pendingStart: pendingStart && { goalText: pendingStart.goalText } } };
      } else if (message.type === 'stop') {
        collector.stop(now);
        await broadcast();
      } else if (message.type === 'clear') {
        if (collector.state.session) return { ok: false, error: '세션 종료 후 기록을 지워 주세요.' };
        collector.state = emptyState();
      } else if (message.type === 'sync-permissions') {
        await syncScripts();
        await broadcast();
      }
      return { ok: true, status: { ...collector.status(Math.max(now, Date.now())), pendingStart: pendingStart && !collector.state.session ? { goalText: pendingStart.goalText } : undefined } };
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
    reply({ ok: false, error: '요청 처리에 실패했습니다. 수집을 중단했습니다. 확장 프로그램 상태를 확인해 주세요.' });
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
  collector.stop(now);
  collector.state = emptyState();
  await syncScripts();
  await broadcast();
}));

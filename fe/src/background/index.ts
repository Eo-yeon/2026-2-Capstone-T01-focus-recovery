import { Collector, emptyState } from './collector';
import { serialExecutor } from './serial';
import { describeUrl } from '../shared/url';
import { isContentMessage, isPopupMessage } from '../shared/messages';
import type { CollectionState, Reply } from '../shared/types';

const enqueue = serialExecutor();
const collector = new Collector();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.session.get('collection');
  if (saved.collection) collector.state = saved.collection as CollectionState;
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
function dispatch<T>(operation: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    try {
      await ready;
      const result = await operation();
      await persist();
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
function event(operation: () => Promise<unknown>) {
  // Never log raw URLs, payloads, goals or platform error messages.
  void dispatch(operation).catch(() => undefined);
}
async function readBrowserState<T>(query: () => Promise<T>): Promise<T | undefined> {
  // Only browser state queries are recoverable here; storage and unknown errors escape.
  try { return await query(); }
  catch { return undefined; }
}
async function refreshForeground() {
  const windows = await readBrowserState(() => chrome.windows.getAll());
  const focused = windows?.find(window => window.focused && window.state !== 'minimized');
  const tabs = focused?.id === undefined ? [] : await readBrowserState(() => chrome.tabs.query({ active: true, windowId: focused.id }));
  // Unknown focus is a pause, never an assumed active tab.
  collector.foreground(tabs?.[0]?.id ?? null, Date.now());
}
async function hasPermission(raw: string) {
  try { return await chrome.permissions.contains({ origins: [`${new URL(raw).origin}/*`] }); }
  catch { return false; }
}
async function broadcast() {
  const tabs = await readBrowserState(() => chrome.tabs.query({}));
  if (!tabs) return;
  await Promise.all(tabs.filter(tab => tab.id !== undefined).map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'session-changed' }).catch(() => undefined)));
}
async function syncScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter(origin => /^https?:\/\//.test(origin));
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  if (scripts.some(script => script.id === 'collector')) await chrome.scripting.unregisterContentScripts({ ids: ['collector'] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{ id: 'collector', js: ['content.js'], matches, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
    const tabs = await readBrowserState(() => chrome.tabs.query({}));
    if (!tabs) return;
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        // Permission checks do not need tabs permission or access to background tab URLs.
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch { /* Restricted/unpermitted tabs are skipped. */ }
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: Reply) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const tabId = sender.tab?.id;
  if (popup ? !isPopupMessage(message) : !isContentMessage(message) || tabId === undefined || sender.frameId !== 0 || !sender.documentId || sender.documentLifecycle !== 'active') return false;
  void dispatch(async (): Promise<Reply> => {
    if (popup && isPopupMessage(message)) {
      if (message.type === 'start') {
        try { collector.start(message.goalText, Date.now()); }
        catch { return { ok: false, error: '활성 세션이 있거나 목표가 5~150자 범위를 벗어났습니다.' }; }
        await refreshForeground();
        await syncScripts();
        await broadcast();
      } else if (message.type === 'stop') {
        collector.stop(Date.now());
        await broadcast();
      } else if (message.type === 'clear') {
        if (collector.state.session) return { ok: false, error: '세션 종료 후 기록을 지워 주세요.' };
        collector.state = emptyState();
      } else if (message.type === 'sync-permissions') {
        await syncScripts();
        await broadcast();
      }
      return { ok: true, status: collector.status(Date.now()) };
    }
    if (tabId === undefined || !sender.documentId || !isContentMessage(message)) return { ok: false };
    if (!collector.state.session || collector.state.capacityReached) return { ok: true, sessionId: null };
    if (message.type !== 'context' && message.sessionId !== collector.state.session.sessionId) return { ok: true, sessionId: null };
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId, frameId: 0 }));
    if (!frame || frame.documentId !== sender.documentId || !await hasPermission(frame.url)) {
      if (collector.state.foregroundTabId === tabId) collector.foreground(null, Date.now());
      return { ok: true, sessionId: null };
    }
    if (frame.errorOccurred) {
      const url = await describeUrl(frame.url);
      collector.navigationError(tabId, frame.documentId, url?.identity ?? null, Date.now());
      if (collector.state.foregroundTabId === tabId && !collector.state.tabs[tabId]?.navigationFailed) collector.foreground(null, Date.now());
      return { ok: true, sessionId: null };
    }
    if (message.type === 'context') {
      const url = await describeUrl(frame.url);
      collector.navigate(tabId, sender.documentId, url?.identity ?? null, 'existing', Date.now());
      await refreshForeground();
    } else if (message.type === 'leave') {
      collector.leave(tabId, sender.documentId, Date.now());
    } else {
      const expected = await describeUrl(frame.url);
      const snapshot = message.snapshot;
      if (snapshot && (!expected || Object.keys(expected).some(key => expected[key as keyof typeof expected] !== snapshot[key as keyof typeof expected]))) return { ok: false };
      collector.observe(tabId, sender.documentId, message.sessionId, snapshot, message.reason, Date.now());
    }
    return { ok: true, sessionId: collector.state.session?.sessionId ?? null };
  }).then(sendResponse).catch(() => {
    sendResponse({ ok: false, error: '요청 처리에 실패했습니다. 수집을 중단했습니다. 확장 프로그램 상태를 확인해 주세요.' });
  });
  return true;
});
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  event(async () => {
    if (!collector.state.session) return;
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }));
    if (!frame) {
      if (collector.state.foregroundTabId === details.tabId) collector.foreground(null, Date.now());
      return;
    }
    if (frame.documentId !== details.documentId) return;
    const allowed = await hasPermission(details.url);
    const url = allowed ? await describeUrl(details.url) : null;
    collector.navigate(details.tabId, details.documentId, url?.identity ?? null, details.transitionType === 'reload' ? 'reload' : 'new', Date.now());
    if (frame.errorOccurred) collector.navigationError(details.tabId, frame.documentId, url?.identity ?? null, Date.now());
    await refreshForeground();
    await chrome.tabs.sendMessage(details.tabId, { type: 'capture' }).catch(() => undefined);
  });
});
// Chrome observes pushState/replaceState across isolated worlds; no MAIN-world patch needed.
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId === 0) event(async () => {
    if (collector.state.session) await chrome.tabs.sendMessage(details.tabId, { type: 'capture' }).catch(() => undefined);
  });
});
chrome.tabs.onActivated.addListener(() => event(async () => { await refreshForeground(); await broadcast(); }));
chrome.windows.onFocusChanged.addListener(() => event(async () => { await refreshForeground(); await broadcast(); }));
chrome.windows.onBoundsChanged.addListener(() => event(refreshForeground));
chrome.tabs.onRemoved.addListener(tabId => event(async () => { collector.removeTab(tabId, Date.now()); }));
chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId === 0) event(async () => {
    const tab = collector.state.tabs[details.tabId];
    if (!collector.state.session || !details.documentId || tab?.documentId !== details.documentId) return;
    const url = await describeUrl(details.url);
    if (!url || url.identity !== tab.currentIdentity) return;
    const frame = await readBrowserState(() => chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }));
    if (!frame?.errorOccurred || frame.documentId !== details.documentId) return;
    const currentUrl = await describeUrl(frame.url);
    if (currentUrl?.identity === url.identity) collector.navigationError(details.tabId, details.documentId, url.identity, Date.now());
  });
});
chrome.permissions.onAdded.addListener(() => event(syncScripts));
chrome.permissions.onRemoved.addListener(() => event(async () => {
  // Revocation is privacy-sensitive: stop and erase all in-memory samples.
  collector.stop(Date.now());
  collector.state = emptyState();
  await syncScripts();
  await broadcast();
}));

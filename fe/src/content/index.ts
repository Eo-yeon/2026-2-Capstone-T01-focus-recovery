import { describeUrl } from '../shared/url';
import { extractMainContent, isExcludedDocument, cleanText } from './extraction';
import { extractSearchContent } from './search';
import type { ContentMessage, Reply } from '../shared/types';

const marker = '__focusRecoveryCollector';
const scope = globalThis as typeof globalThis & { __focusRecoveryCollector?: boolean };
if (!scope[marker]) {
  scope[marker] = true;
  let sessionId: string | null = null;
  let generation = 0;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let maxWait: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let capturedIdentity: string | null = null;
  let searchDeadline = 0;
  let sending = false;
  let again = false;
  const retries = [350, 1000, 2000, 4000];
  async function send(message: ContentMessage): Promise<Reply | null> {
    try { return await chrome.runtime.sendMessage(message) as Reply; }
    catch { deactivate(); return null; }
  }
  function deactivate() {
    generation++;
    sessionId = null;
    capturedIdentity = null;
    searchDeadline = 0;
    observer?.disconnect();
    observer = null;
    clearTimeout(timer); clearTimeout(debounce); clearTimeout(maxWait);
    timer = debounce = maxWait = undefined;
  }
  async function capture() {
    if (!sessionId) return;
    if (sending) { again = true; return; }
    sending = true;
    const id = sessionId;
    const version = generation;
    try {
      const raw = location.href;
      const url = await describeUrl(raw);
      if (version !== generation || id !== sessionId) return;
      if (location.href !== raw) { again = true; return; }
      if (url?.identity !== capturedIdentity) {
        capturedIdentity = url?.identity ?? null;
        attempts = 0;
        searchDeadline = Date.now() + 8000;
      }
      const excluded = !url ? 'url-policy' : isExcludedDocument(document, url.isSearchResultPage ? new URL(raw) : undefined) ? 'dom-policy' : url.isSearchResultPage && !url.searchQuery ? 'search-pending' : undefined;
      // Never extract titles or body on an excluded document.
      const search = !excluded && url?.isSearchResultPage ? extractSearchContent(document, raw) : null;
      const content = excluded ? null : url?.isSearchResultPage ? search?.content ?? null : extractMainContent(document);
      const ready = url?.isSearchResultPage ? !!search : !!content && [...content].length >= 50;
      const reply = await send({
        type: 'snapshot', sessionId: id, reason: excluded ?? (!ready && Date.now() >= searchDeadline && url?.isSearchResultPage ? 'unavailable-content' : undefined),
        snapshot: url && content !== null && !excluded ? { ...url, content, ...(search ? { organicResultCount: search.organicResultCount } : {}), title: [...cleanText(document.title)].slice(0, 500).join('') } : null,
      });
      if (version !== generation) return;
      if (!reply?.ok || reply.sessionId !== id) { deactivate(); return; }
      if (excluded) { deactivate(); return; }
      if (!ready && attempts < retries.length) {
        clearTimeout(timer);
        timer = setTimeout(() => { void capture(); }, retries[attempts++]);
      } else if (!ready && url?.isSearchResultPage && Date.now() < searchDeadline) {
        clearTimeout(timer);
        timer = setTimeout(() => { void capture(); }, searchDeadline - Date.now());
      }
    } finally {
      sending = false;
      if (again) { again = false; schedule(); }
    }
  }
  function schedule() {
    if (!sessionId) return;
    clearTimeout(debounce);
    const run = () => { clearTimeout(debounce); clearTimeout(maxWait); debounce = maxWait = undefined; void capture(); };
    debounce = setTimeout(run, 350);
    maxWait ??= setTimeout(run, 1500);
  }
  async function context() {
    const version = generation;
    const reply = await send({ type: 'context' });
    if (version !== generation) return;
    const next = reply?.ok ? reply.sessionId ?? null : null;
    if (!next) { deactivate(); return; }
    if (next !== sessionId) {
      deactivate();
      sessionId = next;
      attempts = 0;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'type', 'autocomplete', 'name', 'contenteditable'] });
    }
    void capture();
    // One eligibility check, not a recurring behavior snapshot or keepalive loop.
    clearTimeout(timer);
    timer = setTimeout(() => { void capture(); }, 1100);
  }
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'session-changed') void context();
    if (message?.type === 'capture') { attempts = 0; void context(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void context(); });
  window.addEventListener('pageshow', () => { void context(); });
  window.addEventListener('popstate', () => { attempts = 0; void context(); });
  window.addEventListener('pagehide', () => { if (sessionId) void send({ type: 'leave', sessionId }); deactivate(); });
  void context();
}

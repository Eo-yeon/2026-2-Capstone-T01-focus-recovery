import type { CollectionState, DevStatus, ExclusionReason, PageSnapshot, PageVisit, VisitCandidate } from '../shared/types';
import { isMajorContentChange } from '../shared/content-change';
import { resumeActiveTime, settleActiveTime } from './active-time';
export const MAX_CANDIDATES = 200;
export function emptyState(): CollectionState {
  return { session: null, nextSequence: 1, tabs: {}, candidates: [], foregroundTabId: null, capacityReached: false };
}
export class Collector {
  constructor(public state = emptyState(), private uuid = () => crypto.randomUUID() as string) {}
  start(goalText: string, now: number): void {
    if (this.state.session) throw new Error('이미 활성 세션이 있습니다.');
    const trimmed = goalText.trim();
    // Match the existing BE request validator, not an invented FE policy.
    if (trimmed.length < 5 || trimmed.length > 150) throw new Error('현재 BE 구현과 동일하게 목표는 5~150자로 입력해 주세요.');
    this.state = emptyState();
    this.state.session = { sessionId: this.uuid(), goalText: trimmed, startedAt: new Date(now).toISOString(), source: 'development-local' };
  }
  current(tabId: number): VisitCandidate | undefined {
    return this.state.candidates.find(candidate => candidate.visitId === this.state.tabs[tabId]?.candidateId);
  }
  private validate(candidate: VisitCandidate): void {
    if (candidate.state === 'excluded') return;
    if (candidate.snapshot && [...candidate.snapshot.content].length >= 50 && candidate.activeDurationMs >= 1000) {
      candidate.state = 'valid';
      delete candidate.reason;
    }
  }
  private exclude(candidate: VisitCandidate, reason: ExclusionReason): void {
    candidate.state = 'excluded';
    candidate.reason = reason;
    candidate.activeSince = null;
    delete candidate.snapshot;
  }
  private pause(tabId: number, now: number, final = false): void {
    const candidate = this.current(tabId);
    if (!candidate) return;
    settleActiveTime(candidate, now);
    this.validate(candidate);
    if (final && candidate.state === 'pending') this.exclude(candidate, candidate.snapshot ? ([...candidate.snapshot.content].length < 50 ? 'short-content' : 'short-duration') : 'unavailable-content');
  }
  foreground(tabId: number | null, now: number): void {
    const old = this.state.foregroundTabId;
    if (old !== null) this.pause(old, now);
    this.state.foregroundTabId = tabId;
    if (tabId !== null && this.state.session) {
      const candidate = this.current(tabId);
      if (candidate) resumeActiveTime(candidate, now);
    }
  }
  navigate(tabId: number, documentId: string, identity: string | null, kind: 'new' | 'reload' | 'existing' | 'spa', now: number): void {
    if (!this.state.session || this.state.capacityReached) return;
    const old = this.state.tabs[tabId];
    if (old?.documentId === documentId && kind !== 'spa') return;
    if (old && kind === 'reload' && identity !== null && old.currentIdentity === identity) {
      this.pause(tabId, now);
      old.documentId = documentId;
      if (this.state.foregroundTabId === tabId) {
        const candidate = this.current(tabId);
        if (candidate) resumeActiveTime(candidate, now);
      }
      return;
    }
    this.pause(tabId, now, true);
    if (this.state.candidates.length >= MAX_CANDIDATES) {
      this.state.capacityReached = true;
      this.foreground(null, now);
      return;
    }
    const visitId = this.uuid();
    const candidate: VisitCandidate = {
      visitId, sessionId: this.state.session.sessionId, sequence: this.state.nextSequence++,
      browserTabKey: old?.browserTabKey ?? this.uuid(), visitedAt: new Date(now).toISOString(),
      state: 'pending', activeDurationMs: 0, activeSince: this.state.foregroundTabId === tabId ? now : null,
    };
    this.state.tabs[tabId] = { browserTabKey: candidate.browserTabKey, documentId, identity, currentIdentity: identity, candidateId: visitId };
    this.state.candidates.push(candidate);
    if (!identity) this.exclude(candidate, 'url-policy');
  }
  observe(tabId: number, documentId: string, sessionId: string, snapshot: PageSnapshot | null, reason: ExclusionReason | undefined, now: number): void {
    if (this.state.session?.sessionId !== sessionId || this.state.capacityReached) return;
    const tab = this.state.tabs[tabId];
    if (!tab || tab.documentId !== documentId) return;
    let candidate = this.current(tabId)!;
    if (reason === 'dom-policy' || reason === 'url-policy' || reason === 'search-pending' || snapshot?.isSearchResultPage) {
      this.exclude(candidate, reason ?? 'search-pending');
      return;
    }
    if (candidate.state === 'excluded') return;
    if (snapshot && candidate.snapshot && tab.identity !== snapshot.identity && isMajorContentChange(candidate.snapshot.content, snapshot.content)) {
      this.navigate(tabId, documentId, snapshot.identity, 'spa', now);
      if (this.state.capacityReached) return;
      candidate = this.current(tabId)!;
    }
    // URL-only changes keep the original identity/content baseline until content changes too.
    if (snapshot) this.state.tabs[tabId].currentIdentity = snapshot.identity;
    if (snapshot && (!candidate.snapshot || ([...candidate.snapshot.content].length < 50 && tab.identity === snapshot.identity))) {
      candidate.snapshot = snapshot;
      tab.identity = snapshot.identity;
    }
    if (this.state.foregroundTabId === tabId) {
      settleActiveTime(candidate, now);
      resumeActiveTime(candidate, now);
    }
    this.validate(candidate);
  }
  leave(tabId: number, documentId: string, now: number): void {
    if (this.state.tabs[tabId]?.documentId === documentId) this.pause(tabId, now);
  }
  removeTab(tabId: number, now: number): void {
    this.pause(tabId, now, true);
    delete this.state.tabs[tabId];
    if (this.state.foregroundTabId === tabId) this.state.foregroundTabId = null;
  }
  stop(now: number): void {
    for (const key of Object.keys(this.state.tabs)) this.pause(Number(key), now, true);
    this.state.session = null;
    this.state.foregroundTabId = null;
  }
  status(now: number): DevStatus {
    if (this.state.session && this.state.foregroundTabId !== null) this.foreground(this.state.foregroundTabId, now);
    const visits: PageVisit[] = this.state.candidates.filter(candidate => candidate.state === 'valid' && candidate.snapshot).map(candidate => {
      const { identity: _, ...snapshot } = candidate.snapshot!;
      return { ...snapshot, visitId: candidate.visitId, sessionId: candidate.sessionId, sequence: candidate.sequence, browserTabKey: candidate.browserTabKey, visitedAt: candidate.visitedAt, searchQuery: null, activeDurationMs: candidate.activeDurationMs, tabSwitchCount: null, behaviorVersion: null };
    });
    return { session: this.state.session, capacityReached: this.state.capacityReached, visits, candidates: this.state.candidates.map(({ snapshot: _, activeSince: __, ...candidate }) => candidate) };
  }
}

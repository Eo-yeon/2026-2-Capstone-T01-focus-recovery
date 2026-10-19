import type { CollectionState, DevStatus, ExclusionReason, PageSnapshot, PageVisit, VisitCandidate } from '../shared/types';
import { isMajorContentChange, isSearchContentChange } from '../shared/content-change';
import { validSearchQuery } from '../shared/url';
import { resumeActiveTime, settleActiveTime } from './active-time';
import type { WorkSessionResponse } from '../api/types';
import { isWorkSession } from '../api/session';
export const MAX_CANDIDATES = 200;
export function emptyState(sequenceStart = 1): CollectionState {
  return { sequenceVersion: 1, session: null, nextSequence: sequenceStart, ...(sequenceStart > 1 ? { sequenceStart } : {}), tabs: {}, candidates: [], foregroundTabId: null, lastActiveTabId: null, lastActiveVisitId: null, capacityReached: false };
}
export class Collector {
  constructor(public state = emptyState(), private uuid = () => crypto.randomUUID() as string) {
    this.restore(state);
  }
  restore(state: CollectionState): void {
    this.state = state;
    // Older local-only checkpoints never measured switches or issued behavior versions.
    for (const candidate of state.candidates) {
      candidate.tabSwitchCount ??= 0;
      candidate.behaviorVersion ??= candidate.activeDurationMs > 0 ? 1 : 0;
      candidate.activeTimeCursor ??= candidate.activeSince ?? Date.parse(candidate.visitedAt);
    }
    state.lastActiveTabId ??= state.foregroundTabId;
    state.lastActiveVisitId ??= state.lastActiveTabId === null ? null : this.current(state.lastActiveTabId)?.visitId ?? null;
    // Legacy checkpoints were local-only: retain IDs/content, discard candidate sequence gaps.
    if (state.sequenceVersion !== 1) {
      const openIds = new Set(state.session ? Object.values(state.tabs).map(tab => tab.candidateId) : []);
      this.state = { ...state, sequenceVersion: 1, nextSequence: 1, candidates: state.candidates.map(candidate => ({ ...candidate, sequence: null, finalized: !openIds.has(candidate.visitId) || (candidate.state === 'excluded' && candidate.reason !== 'unavailable-content') })) };
      if (state.capacityReached) for (const key of Object.keys(state.tabs)) this.pause(Number(key), Date.now(), true);
      this.assignSequences();
    }
  }
  private assignSequences(): void {
    // An open candidate can still recover or be excluded; never let later visits overtake it.
    for (const candidate of this.state.candidates) {
      if (!candidate.finalized) break;
      if (candidate.state === 'valid' && candidate.sequence === null) candidate.sequence = this.state.nextSequence++;
    }
  }
  start(session: WorkSessionResponse): void {
    if (this.state.session) throw new Error('이미 활성 세션이 있습니다.');
    if (!isWorkSession(session) || session.status !== 'ACTIVE') throw new Error('유효한 서버 활성 세션이 필요합니다.');
    this.state = emptyState();
    this.state.session = { ...session, source: 'server' };
  }
  resume(session: WorkSessionResponse): void {
    if (this.state.candidates.some(candidate => candidate.sessionId !== session.sessionId)) throw new Error('세션과 방문 기록이 일치하지 않습니다.');
    const paused = this.state;
    this.start(session);
    this.state = { ...paused, session: this.state.session };
  }
  suspend(now: number): void {
    for (const key of Object.keys(this.state.tabs)) this.pause(Number(key), now);
    this.state.session = null;
    this.state.foregroundTabId = null;
  }
  current(tabId: number): VisitCandidate | undefined {
    return this.state.candidates.find(candidate => candidate.visitId === this.state.tabs[tabId]?.candidateId);
  }
  private hasContent(snapshot: PageSnapshot): boolean {
    return snapshot.isSearchResultPage ? validSearchQuery(snapshot.searchQuery) && Number.isSafeInteger(snapshot.organicResultCount) && (snapshot.organicResultCount ?? 0) > 0 && snapshot.content.trim().length > 0 : [...snapshot.content].length >= 50;
  }
  private validate(candidate: VisitCandidate): void {
    if (candidate.state === 'excluded') return;
    if (candidate.snapshot && this.hasContent(candidate.snapshot) && candidate.activeDurationMs >= 1000) {
      candidate.state = 'valid';
      delete candidate.reason;
    }
  }
  private exclude(candidate: VisitCandidate, reason: ExclusionReason): void {
    candidate.state = 'excluded';
    candidate.reason = reason;
    candidate.activeSince = null;
    delete candidate.snapshot;
    if (reason !== 'unavailable-content') {
      candidate.finalized = true;
      this.assignSequences();
    }
  }
  private pause(tabId: number, now: number, final = false): void {
    const candidate = this.current(tabId);
    if (!candidate || candidate.finalized) return;
    settleActiveTime(candidate, now);
    this.validate(candidate);
    if (final && candidate.state === 'pending') this.exclude(candidate, candidate.snapshot ? (!this.hasContent(candidate.snapshot) ? 'short-content' : 'short-duration') : 'unavailable-content');
    if (final) {
      candidate.finalized = true;
      this.assignSequences();
    }
  }
  foreground(tabId: number | null, now: number): void {
    const old = this.state.foregroundTabId;
    if (old !== null) this.pause(old, now);
    this.state.foregroundTabId = tabId;
    if (tabId !== null && this.state.session && !this.state.capacityReached) {
      if (this.state.lastActiveTabId !== null && this.state.lastActiveTabId !== tabId) {
        const previous = this.state.candidates.find(candidate => candidate.visitId === this.state.lastActiveVisitId);
        // A close can finalize the visit before Chrome announces its replacement tab.
        if (previous && previous.state !== 'excluded') {
          previous.tabSwitchCount++;
          previous.behaviorVersion++;
        }
      }
      this.state.lastActiveTabId = tabId;
      const candidate = this.current(tabId);
      this.state.lastActiveVisitId = candidate?.visitId ?? null;
      if (candidate && !candidate.finalized && !this.state.tabs[tabId]?.navigationFailed && !this.state.tabs[tabId]?.documentLeft) resumeActiveTime(candidate, now);
    }
  }
  reconcileForeground(tabId: number | null, now: number): void {
    const old = this.state.foregroundTabId;
    if (old !== null) {
      const candidate = this.current(old);
      // Matching endpoints do not prove continuous focus across an unobserved worker gap.
      if (candidate && candidate.activeSince !== null) this.pause(old, candidate.activeSince);
    }
    this.foreground(tabId, now);
  }
  navigate(tabId: number, documentId: string, identity: string | null, kind: 'new' | 'reload' | 'existing' | 'spa', now: number): void {
    if (!this.state.session || this.state.capacityReached) return;
    const old = this.state.tabs[tabId];
    if (old?.documentId === documentId && kind !== 'spa') {
      if (kind === 'existing') delete old.documentLeft;
      return;
    }
    if (old && kind === 'reload' && identity !== null && old.currentIdentity === identity) {
      this.pause(tabId, now);
      old.documentId = documentId;
      delete old.navigationFailed;
      delete old.documentLeft;
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
      for (const key of Object.keys(this.state.tabs)) this.pause(Number(key), now, true);
      return;
    }
    const visitId = this.uuid();
    const candidate: VisitCandidate = {
      visitId, sessionId: this.state.session.sessionId, sequence: null, finalized: false,
      browserTabKey: old?.browserTabKey ?? this.uuid(), visitedAt: new Date(now).toISOString(),
      state: 'pending', activeDurationMs: 0, tabSwitchCount: 0, behaviorVersion: 0,
      activeSince: this.state.foregroundTabId === tabId ? now : null, activeTimeCursor: now,
    };
    this.state.tabs[tabId] = { browserTabKey: candidate.browserTabKey, documentId, identity, currentIdentity: identity, candidateId: visitId };
    this.state.candidates.push(candidate);
    if (this.state.foregroundTabId === tabId) this.state.lastActiveVisitId = visitId;
    if (!identity) this.exclude(candidate, 'url-policy');
  }
  observe(tabId: number, documentId: string, sessionId: string, snapshot: PageSnapshot | null, reason: ExclusionReason | undefined, now: number): void {
    if (this.state.session?.sessionId !== sessionId || this.state.capacityReached) return;
    const tab = this.state.tabs[tabId];
    if (!tab || tab.documentId !== documentId || tab.navigationFailed || tab.documentLeft) return;
    let candidate = this.current(tabId)!;
    if (candidate.finalized) return;
    if (reason === 'dom-policy' || reason === 'url-policy' || reason === 'search-pending' || (snapshot?.isSearchResultPage && !this.hasContent(snapshot))) {
      if (candidate.state !== 'valid' || reason === 'dom-policy' || reason === 'url-policy') this.exclude(candidate, reason ?? 'search-pending');
      return;
    }
    if (reason === 'unavailable-content') {
      if (candidate.state === 'pending') this.exclude(candidate, reason);
      return;
    }
    // Bounded search retries can recover on a later DOM/history event.
    if (candidate.state === 'excluded') {
      if (candidate.reason !== 'unavailable-content' || !snapshot?.isSearchResultPage || !this.hasContent(snapshot)) return;
      candidate.state = 'pending';
      delete candidate.reason;
    }
    if (snapshot && candidate.snapshot && tab.identity !== snapshot.identity && (snapshot.isSearchResultPage && candidate.snapshot.isSearchResultPage ? isSearchContentChange(candidate.snapshot.content, snapshot.content) : isMajorContentChange(candidate.snapshot.content, snapshot.content))) {
      this.navigate(tabId, documentId, snapshot.identity, 'spa', now);
      if (this.state.capacityReached) return;
      candidate = this.current(tabId)!;
    }
    // URL-only changes keep the original identity/content baseline until content changes too.
    if (snapshot) this.state.tabs[tabId].currentIdentity = snapshot.identity;
    if (snapshot && (!candidate.snapshot || (!this.hasContent(candidate.snapshot) && tab.identity === snapshot.identity))) {
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
    if (this.state.tabs[tabId]?.documentId === documentId) {
      this.pause(tabId, now);
      this.state.tabs[tabId].documentLeft = true;
    }
  }
  navigationError(tabId: number, documentId: string | undefined, identity: string | null, now: number): void {
    const tab = this.state.tabs[tabId];
    if (!this.state.session || !documentId || !identity || tab?.documentId !== documentId || tab.currentIdentity !== identity || tab.navigationFailed) return;
    const candidate = this.current(tabId)!;
    tab.navigationFailed = true;
    // Do not validate a failed candidate. A valid visit may predate a reused reload.
    settleActiveTime(candidate, now);
    if (candidate.state === 'pending') this.exclude(candidate, 'navigation-error');
  }
  removeTab(tabId: number, now: number): void {
    this.pause(tabId, now, true);
    delete this.state.tabs[tabId];
    if (this.state.foregroundTabId === tabId) this.state.foregroundTabId = null;
  }
  stop(now: number): void {
    // An explicit stop can close an already valid detached visit at its committed duration.
    // Undecided detached candidates retain their recovery hold and block later sequences.
    for (const candidate of this.state.candidates) if (candidate.recoveryRequired && candidate.state === 'valid') {
      candidate.finalized = true;
      delete candidate.recoveryRequired;
    }
    this.assignSequences();
    for (const key of Object.keys(this.state.tabs)) this.pause(Number(key), now, true);
    this.state.session = null;
    this.state.foregroundTabId = null;
    this.state.lastActiveTabId = null;
    this.state.lastActiveVisitId = null;
  }
  status(now: number, settle = true): DevStatus {
    if (settle && this.state.session && this.state.foregroundTabId !== null) this.foreground(this.state.foregroundTabId, now);
    const visits: DevStatus['visits'] = this.state.candidates.filter(candidate => candidate.state === 'valid' && candidate.snapshot).map(candidate => {
      const { identity: _, organicResultCount: __, ...snapshot } = candidate.snapshot!;
      return { ...snapshot, visitId: candidate.visitId, sessionId: candidate.sessionId, sequence: candidate.sequence, browserTabKey: candidate.browserTabKey, visitedAt: candidate.visitedAt, searchQuery: snapshot.searchQuery ?? null, activeDurationMs: candidate.activeDurationMs, tabSwitchCount: candidate.tabSwitchCount, behaviorVersion: candidate.behaviorVersion };
    });
    const readyVisits = visits.filter((visit): visit is PageVisit => visit.sequence !== null);
    return { session: this.state.session, capacityReached: this.state.capacityReached, visits, readyVisits, candidates: this.state.candidates.map(({ snapshot: _, activeSince: __, activeTimeCursor: ___, ...candidate }) => candidate) };
  }
}

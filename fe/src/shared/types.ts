export interface LocalSession {
  sessionId: string;
  goalText: string;
  startedAt: string;
  source: 'development-local';
}
export interface PageVisit {
  visitId: string;
  sessionId: string;
  sequence: number;
  browserTabKey: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  content: string;
  visitedAt: string;
  isSearchResultPage: boolean;
  searchQuery: null; // FE-007 owns extraction; search pages cannot become valid yet.
  activeDurationMs: number;
  tabSwitchCount: null; // Unmeasured, never fabricate zero.
  behaviorVersion: null; // FE-005/006 will define snapshot updates.
}
export type ExclusionReason = 'url-policy' | 'dom-policy' | 'search-pending' | 'short-content' | 'short-duration' | 'unavailable-content' | 'navigation-error';
export interface PageSnapshot {
  normalizedUrl: string;
  domain: string;
  identity: string; // SHA-256 of the pre-normalization URL, without fragment.
  title: string;
  content: string;
  isSearchResultPage: boolean;
}
export interface VisitCandidate {
  visitId: string;
  sessionId: string;
  sequence: number;
  browserTabKey: string;
  visitedAt: string;
  state: 'pending' | 'valid' | 'excluded';
  reason?: ExclusionReason;
  snapshot?: PageSnapshot;
  activeDurationMs: number;
  activeSince: number | null;
}
export interface TabState {
  browserTabKey: string;
  documentId: string;
  identity: string | null;
  currentIdentity: string | null;
  navigationFailed?: boolean;
  candidateId: string;
}
export interface CollectionState {
  session: LocalSession | null;
  nextSequence: number;
  tabs: Record<number, TabState>;
  candidates: VisitCandidate[];
  foregroundTabId: number | null;
  capacityReached: boolean;
}
export type ContentMessage =
  | { type: 'context' }
  | { type: 'snapshot'; sessionId: string; snapshot: PageSnapshot | null; reason?: ExclusionReason }
  | { type: 'leave'; sessionId: string };
export type PopupMessage = { type: 'status' } | { type: 'start'; goalText: string } | { type: 'stop' } | { type: 'clear' } | { type: 'sync-permissions' };
export interface DevStatus {
  session: LocalSession | null;
  candidates: Omit<VisitCandidate, 'snapshot' | 'activeSince'>[];
  visits: PageVisit[];
  capacityReached: boolean;
}
export interface Reply {
  ok: boolean;
  error?: string;
  sessionId?: string | null;
  status?: DevStatus;
}

import type { WorkSessionResponse } from '../api/types';
export type ServerSession = WorkSessionResponse & { source: 'server' };
export interface PendingSessionStart {
  idempotencyKey: string;
  goalText: string;
  apiBaseUrl: string;
  response?: WorkSessionResponse;
}
export type SessionStartRecovery =
  | { kind: 'none' }
  | { kind: 'pending'; goalText: string; blockedReason?: 'server-changed' | 'server-ended' }
  | { kind: 'invalid'; reason: 'corrupted-record' | 'conflicting-records' | 'missing-request' | 'initialization-failed'; sessionId?: string };
export interface VisitBehavior {
  activeDurationMs: number;
  tabSwitchCount: number;
  behaviorVersion: number;
}
export interface PageVisit extends VisitBehavior {
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
  searchQuery: string | null;
}
export type ExclusionReason = 'url-policy' | 'dom-policy' | 'search-pending' | 'short-content' | 'short-duration' | 'unavailable-content' | 'navigation-error';
export interface PageSnapshot {
  normalizedUrl: string;
  domain: string;
  identity: string; // SHA-256 of the pre-normalization URL, without fragment.
  title: string;
  content: string;
  isSearchResultPage: boolean;
  searchQuery?: string | null; // Absent on older ordinary HTML messages.
  organicResultCount?: number; // Internal extraction evidence; omitted from PageVisit.
}
export interface VisitCandidate extends VisitBehavior {
  visitId: string;
  sessionId: string;
  sequence: number | null; // Assigned once, in candidate creation order after finalization.
  finalized: boolean;
  recoveryRequired?: boolean; // Live document identity could not be verified after recovery.
  browserTabKey: string;
  visitedAt: string;
  state: 'pending' | 'valid' | 'excluded';
  reason?: ExclusionReason;
  snapshot?: PageSnapshot;
  activeSince: number | null;
  activeTimeCursor: number; // Last clock boundary; a backwards wall clock cannot recount time.
}
export interface TabState {
  browserTabKey: string;
  documentId: string;
  identity: string | null;
  currentIdentity: string | null;
  navigationFailed?: boolean;
  documentLeft?: boolean;
  candidateId: string;
}
export interface CollectionState {
  sequenceVersion: 1;
  session: ServerSession | null;
  nextSequence: number;
  tabs: Record<number, TabState>;
  candidates: VisitCandidate[];
  foregroundTabId: number | null;
  lastActiveTabId: number | null;
  lastActiveVisitId: string | null; // Retained across blur/close until the next actual tab is known.
  capacityReached: boolean;
}
export type ContentMessage =
  | { type: 'context' }
  | { type: 'snapshot'; sessionId: string; snapshot: PageSnapshot | null; reason?: ExclusionReason }
  | { type: 'leave'; sessionId: string };
export type PopupMessage = { type: 'status' } | { type: 'start'; goalText: string } | { type: 'stop' } | { type: 'clear' } | { type: 'sync-permissions' } | { type: 'retry-visits' } | { type: 'retry-behaviors' };
export interface VisitDeliveryStatus {
  blocked?: string;
  visits: { visitId: string; sequence: number; phase: 'queued' | 'sending' | 'retry-wait' | 'failed' | 'acked'; attempts: number; error?: string; code?: string; retryable?: boolean; nextRetryAt?: number }[];
}
export interface BehaviorDeliveryStatus {
  blocked?: string;
  visits: { visitId: string; sequence: number; phase: 'waiting-post' | 'queued' | 'sending' | 'retry-wait' | 'failed' | 'acked';
    latest: VisitBehavior; ack?: VisitBehavior; request?: VisitBehavior; attempts: number;
    error?: string; code?: string; retryable?: boolean; nextRetryAt?: number }[];
}
export interface DevStatus {
  storage?: { phase: 'initializing' | 'ready' | 'failed'; recovered: boolean; error?: string };
  recoveryCandidates?: number;
  session: ServerSession | null;
  sessionStartRecovery?: SessionStartRecovery;
  visitDelivery?: VisitDeliveryStatus;
  behaviorDelivery?: BehaviorDeliveryStatus;
  candidates: Omit<VisitCandidate, 'snapshot' | 'activeSince' | 'activeTimeCursor'>[];
  visits: (Omit<PageVisit, 'sequence'> & { sequence: number | null })[];
  readyVisits: PageVisit[]; // Only these have immutable, contiguous server sequences.
  capacityReached: boolean;
}
export interface Reply {
  ok: boolean;
  error?: string;
  sessionId?: string | null;
  status?: DevStatus;
}

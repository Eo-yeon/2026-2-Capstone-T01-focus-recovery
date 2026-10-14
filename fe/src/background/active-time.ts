import type { VisitCandidate } from '../shared/types';
export function settleActiveTime(candidate: VisitCandidate, now: number): void {
  if (candidate.activeSince !== null) candidate.activeDurationMs += Math.max(0, now - candidate.activeSince);
  candidate.activeSince = null;
}
export function resumeActiveTime(candidate: VisitCandidate, now: number): void {
  if (candidate.state !== 'excluded' && candidate.activeSince === null) candidate.activeSince = now;
}

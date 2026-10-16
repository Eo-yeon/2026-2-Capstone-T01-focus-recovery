import type { VisitCandidate } from '../shared/types';
export function settleActiveTime(candidate: VisitCandidate, now: number): void {
  if (candidate.activeSince !== null) {
    const duration = Math.max(0, now - candidate.activeSince);
    if (duration > 0) {
      candidate.activeDurationMs += duration;
      candidate.behaviorVersion++;
    }
    candidate.activeTimeCursor = Math.max(candidate.activeTimeCursor, candidate.activeSince, now);
  }
  candidate.activeSince = null;
}
export function resumeActiveTime(candidate: VisitCandidate, now: number): void {
  if (candidate.state !== 'excluded' && candidate.activeSince === null) candidate.activeSince = Math.max(now, candidate.activeTimeCursor);
}

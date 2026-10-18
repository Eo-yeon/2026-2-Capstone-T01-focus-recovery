import { MAX_DELIVERY_ATTEMPTS, stopExhaustedDelivery } from './delivery-retry';
import { API_BASE_URL } from '../api/client';
import { savePageVisit, VisitApiError } from '../api/visit';
import { UUID } from '../api/session';
import { behaviorSnapshot, coversBehavior, validBehavior } from '../api/behavior';
import type { VisitBehavior, PageVisit, VisitDeliveryStatus } from '../shared/types';

type Entry = { visit: PageVisit; serverBehavior?: VisitBehavior } & VisitDeliveryStatus['visits'][number];
interface Checkpoint { apiBaseUrl: string; entries: Entry[] }
function isSnapshot(visit: PageVisit) {
  return visit && typeof visit.visitId === 'string' && UUID.test(visit.visitId)
    && typeof visit.sessionId === 'string' && UUID.test(visit.sessionId)
    && ['browserTabKey', 'normalizedUrl', 'domain', 'title', 'content'].every(key => typeof visit[key as keyof PageVisit] === 'string')
    && (visit.searchQuery === null || typeof visit.searchQuery === 'string') && typeof visit.isSearchResultPage === 'boolean'
    && typeof visit.visitedAt === 'string' && Number.isFinite(Date.parse(visit.visitedAt))
    && new Date(visit.visitedAt).toISOString() === visit.visitedAt
    && Number.isSafeInteger(visit.activeDurationMs) && visit.activeDurationMs >= 1000
    && Number.isSafeInteger(visit.tabSwitchCount) && visit.tabSwitchCount >= 0
    && Number.isSafeInteger(visit.behaviorVersion) && visit.behaviorVersion >= 0;
}
export class VisitDelivery {
  // shortcut: storage.session survives worker restarts, not browser restarts; use IndexedDB for durable delivery.
  checkpoint: Checkpoint = { apiBaseUrl: API_BASE_URL, entries: [] };
  blocked: string | undefined;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private mutate: <T>(operation: () => T) => Promise<T>, private canSend: () => boolean, private send = savePageVisit) {}
  restore(value: unknown, sessionId?: string) {
    if (value === undefined) return;
    const saved = value as Checkpoint;
    if (!saved || saved.apiBaseUrl !== API_BASE_URL || !Array.isArray(saved.entries)
      || saved.entries.some(entry => !isSnapshot(entry?.visit) || entry.visitId !== entry.visit.visitId || entry.sequence !== entry.visit.sequence
        || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || (sessionId !== undefined && entry.visit.sessionId !== sessionId)
        || !['queued', 'sending', 'retry-wait', 'failed', 'acked'].includes(entry.phase)
        || (entry.serverBehavior !== undefined && (!validBehavior(entry.serverBehavior) || !coversBehavior(entry.serverBehavior, entry.visit)))
        || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0
        || (entry.phase === 'retry-wait' && !Number.isFinite(entry.nextRetryAt)))
      || new Set(saved.entries.map(entry => entry.visitId)).size !== saved.entries.length
      || saved.entries.some((entry, index) => index > 0 && (entry.sequence <= saved.entries[index - 1].sequence
        || entry.visit.sessionId !== saved.entries[0].visit.sessionId
        || (entry.phase === 'acked' && saved.entries[index - 1].phase !== 'acked')))) {
      this.blocked = '방문 전송 checkpoint 또는 API 서버 설정을 확인해 주세요. 원본을 보존하고 전송을 보류합니다.';
      return;
    }
    this.checkpoint = saved;
    for (const entry of saved.entries) if (entry.phase === 'sending') entry.phase = 'queued';
  }
  collect(visits: PageVisit[]) {
    if (this.blocked) return;
    for (const visit of [...visits].sort((a, b) => a.sequence - b.sequence)) {
      if (!Number.isSafeInteger(visit.sequence) || visit.sequence < 1 || this.checkpoint.entries.some(entry => entry.visitId === visit.visitId)) continue;
      this.checkpoint.entries.push({ visit: { ...visit }, visitId: visit.visitId, sequence: visit.sequence, phase: 'queued', attempts: 0 });
    }
    this.checkpoint.entries.sort((a, b) => a.sequence - b.sequence);
  }
  status(): VisitDeliveryStatus {
    return { blocked: this.blocked, visits: this.checkpoint.entries.map(({ visit: _, serverBehavior: __, ...status }) => ({ ...status })) };
  }
  hasUnconfirmed() { return Boolean(this.blocked) || this.checkpoint.entries.some(entry => entry.phase !== 'acked'); }
  retry() {
    if (this.blocked) return;
    const entry = this.checkpoint.entries.find(entry => entry.phase !== 'acked');
    if (entry?.phase === 'failed' && entry.retryable) {
      entry.phase = 'queued'; entry.attempts = 0; delete entry.nextRetryAt;
    }
  }
  clear() {
    clearTimeout(this.timer);
    this.blocked = undefined;
    this.checkpoint = { apiBaseUrl: API_BASE_URL, entries: [] };
  }
  kick() {
    const first = this.checkpoint.entries.find(entry => entry.phase !== 'acked');
    if (!this.running && !this.blocked && this.canSend() && (first?.phase === 'queued' || first?.phase === 'retry-wait')) void this.pump();
  }
  private async pump() {
    this.running = true;
    clearTimeout(this.timer);
    try {
      while (true) {
        const entry = await this.mutate(() => {
          if (this.blocked || !this.canSend()) return;
          const first = this.checkpoint.entries.find(entry => entry.phase !== 'acked');
          if (!first || first.phase === 'failed' || first.phase === 'sending') return;
          if (stopExhaustedDelivery(first)) return;
          if (first.phase === 'retry-wait' && first.nextRetryAt! > Date.now()) {
            this.timer = setTimeout(() => this.kick(), first.nextRetryAt! - Date.now());
            return;
          }
          first.phase = 'sending'; first.attempts++;
          return first;
        });
        if (!entry) break;
        if (!this.checkpoint.entries.includes(entry)) continue;
        if (!this.canSend()) {
          await this.mutate(() => { if (this.checkpoint.entries.includes(entry)) entry.phase = 'queued'; });
          break;
        }
        let failure: VisitApiError | undefined;
        let serverBehavior: VisitBehavior | undefined;
        try { serverBehavior = behaviorSnapshot(await this.send({ ...entry.visit })); }
        catch (error) { failure = error instanceof VisitApiError ? error : new VisitApiError('network', '방문 저장 중 오류가 발생했습니다.', true); }
        await this.mutate(() => {
          // Clear/permission revocation must not let a late ACK recreate deleted state.
          if (!this.checkpoint.entries.includes(entry)) return;
          if (!failure) {
            entry.serverBehavior = serverBehavior;
            entry.phase = 'acked'; delete entry.error; delete entry.code; delete entry.nextRetryAt; delete entry.retryable;
          } else {
            entry.error = failure.message; entry.code = failure.code; entry.retryable = failure.retryable;
            entry.phase = failure.retryable && entry.attempts < MAX_DELIVERY_ATTEMPTS ? 'retry-wait' : 'failed';
            if (failure.retryable && stopExhaustedDelivery(entry)) entry.error = `${failure.message} ${entry.error}`;
            if (entry.phase === 'retry-wait') entry.nextRetryAt = Date.now() + 1000 * entry.attempts;
          }
        });
      }
    } catch {
      this.blocked = '방문 전송 상태를 저장하지 못했습니다. 저장 완료로 간주하지 않으며 Worker와 저장소 상태 확인이 필요합니다.';
    } finally {
      this.running = false;
      // An event may enqueue a visit while the final checkpoint write is resolving.
      if (this.checkpoint.entries.find(entry => entry.phase !== 'acked')?.phase === 'queued') this.kick();
    }
  }
}

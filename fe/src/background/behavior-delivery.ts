import { API_BASE_URL } from '../api/client';
import { behaviorSnapshot, coversBehavior, sameBehavior, updateVisitBehavior, validBehavior } from '../api/behavior';
import { VisitApiError } from '../api/visit';
import type { BehaviorDeliveryStatus, PageVisit, VisitBehavior } from '../shared/types';
import type { VisitDelivery } from './visit-delivery';

type PostEntry = VisitDelivery['checkpoint']['entries'][number];
type Entry = BehaviorDeliveryStatus['visits'][number] & { sessionId: string; initial: VisitBehavior };
interface Checkpoint { apiBaseUrl: string; entries: Entry[] }
const phases = ['waiting-post', 'queued', 'sending', 'retry-wait', 'failed', 'acked'];
export class BehaviorDelivery {
  // shortcut: session storage recovers worker interruption only; durable browser recovery needs IndexedDB.
  checkpoint: Checkpoint = { apiBaseUrl: API_BASE_URL, entries: [] };
  blocked: string | undefined;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private mutate: <T>(operation: () => T) => Promise<T>, private canSend: (visitId: string) => boolean, private send = updateVisitBehavior) {}
  restore(value: unknown, posts: PostEntry[]) {
    if (value === undefined) return;
    const saved = value as Checkpoint;
    if (!saved || saved.apiBaseUrl !== API_BASE_URL || !Array.isArray(saved.entries)
      || new Set(saved.entries.map(e => e?.visitId)).size !== saved.entries.length
      || saved.entries.some(e => {
        const post = posts.find(p => p.visitId === e?.visitId);
        return !post || e.sessionId !== post.visit.sessionId || e.sequence !== post.sequence
          || !validBehavior(e.initial) || !sameBehavior(e.initial, post.visit)
          || !validBehavior(e.latest) || !coversBehavior(e.latest, e.initial)
          || !phases.includes(e.phase) || !Number.isSafeInteger(e.attempts) || e.attempts < 0
          || (e.ack !== undefined && (!validBehavior(e.ack) || !coversBehavior(e.ack, post.serverBehavior ?? e.initial) || post.phase !== 'acked'))
          || (e.request !== undefined && (!validBehavior(e.request) || !coversBehavior(e.latest, e.request)))
          || (['sending', 'retry-wait'].includes(e.phase) && !e.request)
          || (e.phase === 'retry-wait' && !Number.isFinite(e.nextRetryAt))
          || (e.phase === 'acked' && (!e.ack || !coversBehavior(e.ack, e.latest) || e.request !== undefined))
          || (e.phase === 'waiting-post' ? e.ack !== undefined || e.request !== undefined : post.phase !== 'acked' || !e.ack);
      })) {
      this.blocked = '행동 갱신 checkpoint가 방문 저장 상태와 일치하지 않습니다. 원본을 보존하고 전송을 보류합니다.';
      return;
    }
    this.checkpoint = saved;
    for (const entry of saved.entries) if (entry.phase === 'sending') entry.phase = 'queued';
  }
  collect(visits: PageVisit[], posts: PostEntry[]) {
    if (this.blocked) return;
    for (const post of posts) {
      let entry = this.checkpoint.entries.find(e => e.visitId === post.visitId);
      if (!entry) {
        const initial = behaviorSnapshot(post.visit);
        entry = { sessionId: post.visit.sessionId, visitId: post.visitId, sequence: post.sequence, initial, latest: { ...initial }, phase: 'waiting-post', attempts: 0 };
        this.checkpoint.entries.push(entry);
      }
      const visit = visits.find(v => v.visitId === entry.visitId);
      if (visit) entry.latest = behaviorSnapshot(visit);
      if (post.phase === 'acked' && !entry.ack) entry.ack = behaviorSnapshot(post.serverBehavior ?? post.visit);
      if (entry.phase === 'failed' || entry.request || !entry.ack) continue;
      if (coversBehavior(entry.ack, entry.latest)) entry.phase = 'acked';
      else if (coversBehavior(entry.latest, entry.ack)) entry.phase = 'queued';
      else {
        entry.phase = 'failed'; entry.retryable = false;
        entry.error = 'Collector와 서버 ACK의 행동 버전 또는 누적값이 충돌했습니다. 값을 보정하지 않고 확인을 기다립니다.';
      }
    }
  }
  status(): BehaviorDeliveryStatus {
    return { blocked: this.blocked, visits: this.checkpoint.entries.map(({ sessionId: _, initial: __, ...status }) => ({
      ...status, latest: { ...status.latest }, ...(status.ack ? { ack: { ...status.ack } } : {}), ...(status.request ? { request: { ...status.request } } : {}),
    })) };
  }
  hasUnconfirmed() { return Boolean(this.blocked) || this.checkpoint.entries.some(e => e.phase !== 'acked'); }
  retry() {
    if (this.blocked) return;
    for (const entry of this.checkpoint.entries) if (entry.phase === 'failed' && entry.retryable) {
      entry.phase = 'queued'; entry.attempts = 0; delete entry.nextRetryAt;
    }
  }
  clear() {
    clearTimeout(this.timer);
    this.checkpoint = { apiBaseUrl: API_BASE_URL, entries: [] }; this.blocked = undefined;
  }
  private eligible(entry: Entry) {
    return this.canSend(entry.visitId) && (entry.phase === 'queued' || entry.phase === 'retry-wait');
  }
  kick() {
    if (!this.running && !this.blocked && this.checkpoint.entries.some(e => this.eligible(e))) void this.pump();
  }
  private async pump() {
    this.running = true; clearTimeout(this.timer);
    try {
      while (true) {
        const entry = await this.mutate(() => {
          if (this.blocked) return;
          const pending = this.checkpoint.entries.filter(e => this.eligible(e));
          const next = pending.find(e => e.phase === 'queued' || e.nextRetryAt! <= Date.now());
          if (!next) {
            if (pending.length) this.timer = setTimeout(() => this.kick(), Math.max(0, Math.min(...pending.map(e => e.nextRetryAt!)) - Date.now()));
            return;
          }
          // Never replace a retry snapshot with the latest collector values.
          next.request ??= behaviorSnapshot(next.latest);
          next.phase = 'sending'; next.attempts++;
          return next;
        });
        if (!entry) break;
        if (!this.checkpoint.entries.includes(entry)) continue;
        if (!this.canSend(entry.visitId)) {
          await this.mutate(() => { if (this.checkpoint.entries.includes(entry)) entry.phase = 'queued'; });
          break;
        }
        let ack: VisitBehavior | undefined, failure: VisitApiError | undefined;
        try { ack = behaviorSnapshot(await this.send(entry.sessionId, entry.visitId, { ...entry.request! })); }
        catch (error) { failure = error instanceof VisitApiError ? error : new VisitApiError('network', '행동 갱신 중 오류가 발생했습니다.', true); }
        await this.mutate(() => {
          if (!this.checkpoint.entries.includes(entry)) return;
          if (failure) {
            entry.error = failure.message; entry.code = failure.code; entry.retryable = failure.retryable;
            entry.phase = failure.retryable && entry.attempts < 3 ? 'retry-wait' : 'failed';
            if (entry.phase === 'retry-wait') entry.nextRetryAt = Date.now() + 1000 * entry.attempts;
          } else {
            if (!entry.ack || coversBehavior(ack!, entry.ack)) entry.ack = ack;
            delete entry.request; delete entry.error; delete entry.code; delete entry.retryable; delete entry.nextRetryAt;
            entry.attempts = 0;
            entry.phase = 'acked';
            if (!coversBehavior(entry.ack!, entry.latest)) {
              if (coversBehavior(entry.latest, entry.ack!)) entry.phase = 'queued';
              else { entry.phase = 'failed'; entry.retryable = false; entry.error = '최신 Collector 행동값과 서버 ACK가 충돌했습니다. 서버 상태 확인이 필요합니다.'; }
            }
          }
        });
      }
    } catch {
      this.blocked = '행동 갱신 상태를 저장하지 못했습니다. 서버 갱신 완료로 간주하지 않습니다. Worker와 저장소 상태를 확인해 주세요.';
    } finally {
      this.running = false;
      if (this.checkpoint.entries.some(e => e.phase === 'queued' && this.canSend(e.visitId))) this.kick();
    }
  }
}

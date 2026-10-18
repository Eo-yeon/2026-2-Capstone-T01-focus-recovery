import { Collector, emptyState, MAX_CANDIDATES } from './collector';
import { VisitDelivery } from './visit-delivery';
import { BehaviorDelivery } from './behavior-delivery';
import { isWorkSession, UUID } from '../api/session';
import { coversBehavior, validBehavior } from '../api/behavior';
import { isContentMessage } from '../shared/messages';
import { isApiOrigin } from '../shared/api-origin';
import { normalizeGoal, validGoal } from '../shared/goal';
import type { CollectionState, PendingSessionStart } from '../shared/types';

export const DB_NAME = 'focus-recovery';
export const DB_VERSION = 1;
export const STORE = 'state';
export const LEGACY_KEYS = ['collection', 'visitDelivery', 'behaviorDelivery'];
export interface DurableState {
  collection: CollectionState;
  visitDelivery?: VisitDelivery['checkpoint'];
  behaviorDelivery?: BehaviorDelivery['checkpoint'];
  activeSession?: unknown;
}
interface RecordState {
  format: 1;
  revision: number;
  sessionId: string | null;
  migrated?: string;
  value: DurableState;
}
export class StorageFailure extends Error {
  constructor(public code: 'storage' | 'corrupt' | 'conflict' | 'server-changed') { super(code); }
}
export function isStartRecord(value: unknown): value is PendingSessionStart {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.idempotencyKey === 'string' && UUID.test(v.idempotencyKey)
    && typeof v.goalText === 'string' && validGoal(v.goalText) && normalizeGoal(v.goalText) === v.goalText
    && isApiOrigin(v.apiBaseUrl)
    && (v.response === undefined || (isWorkSession(v.response) && v.response.goalText === v.goalText));
}
export function validActiveMetadata(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isWorkSession(value) || !('source' in value) || value.source !== 'server' || value.status !== 'ACTIVE') return false;
  const saved = value as typeof value & { startRequest?: unknown; interrupted?: unknown };
  return (saved.interrupted === undefined || typeof saved.interrupted === 'boolean')
    && (saved.startRequest === undefined || isStartRecord(saved.startRequest)
      && saved.startRequest.response?.status === 'ACTIVE' && saved.startRequest.response.sessionId === value.sessionId
      && saved.startRequest.response.startedAt === value.startedAt && saved.startRequest.goalText === value.goalText);
}
function assertCollection(state: CollectionState) {
  if (!state || !Array.isArray(state.candidates) || state.candidates.length > MAX_CANDIDATES
    || !state.tabs || typeof state.tabs !== 'object' || Array.isArray(state.tabs)
    || (state.session !== null && (!isWorkSession(state.session) || state.session.source !== 'server' || state.session.status !== 'ACTIVE'))
    || !Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1 || typeof state.capacityReached !== 'boolean') throw new StorageFailure('corrupt');
  const ids = new Set<string>();
  let sequence = 1, unresolved = false;
  const sessionId = state.session?.sessionId ?? state.candidates[0]?.sessionId;
  for (const c of state.candidates) {
    if (!c || !UUID.test(c.visitId) || ids.has(c.visitId) || !UUID.test(c.sessionId) || c.sessionId !== sessionId
      || !UUID.test(c.browserTabKey) || !Number.isFinite(Date.parse(c.visitedAt)) || !validBehavior(c)
      || !['pending', 'valid', 'excluded'].includes(c.state) || typeof c.finalized !== 'boolean'
      || (c.activeSince !== null && !Number.isFinite(c.activeSince)) || !Number.isFinite(c.activeTimeCursor)
      || (c.recoveryRequired !== undefined && typeof c.recoveryRequired !== 'boolean')
      || (c.snapshot !== undefined && !isContentMessage({ type: 'snapshot', sessionId: c.sessionId, snapshot: c.snapshot }))
      || (c.state === 'valid' && (!c.snapshot || c.activeDurationMs < 1000))
      || (c.state === 'excluded' && (!c.reason || c.snapshot !== undefined))) throw new StorageFailure('corrupt');
    ids.add(c.visitId);
    if (!c.finalized) unresolved = true;
    if (c.sequence !== null) {
      if (unresolved || c.state !== 'valid' || c.sequence !== sequence++) throw new StorageFailure('corrupt');
    } else if (!unresolved && c.finalized && c.state === 'valid') throw new StorageFailure('corrupt');
  }
  if (state.sequenceVersion !== 1 || sequence !== state.nextSequence) throw new StorageFailure('corrupt');
  for (const [id, t] of Object.entries(state.tabs)) {
    const c = state.candidates.find(c => c.visitId === t?.candidateId);
    if (!/^\d+$/.test(id) || !c || c.browserTabKey !== t.browserTabKey || typeof t.documentId !== 'string'
      || ![t.identity, t.currentIdentity].every(v => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new StorageFailure('corrupt');
  }
  if (![state.foregroundTabId, state.lastActiveTabId].every(v => v === null || Number.isSafeInteger(v) && v >= 0)
    || (state.lastActiveVisitId !== null && !ids.has(state.lastActiveVisitId))) throw new StorageFailure('corrupt');
}
export function validateState(value: DurableState) {
  assertCollection(value?.collection);
  if (!validActiveMetadata(value.activeSession)) throw new StorageFailure('corrupt');
  const collector = new Collector(structuredClone(value.collection));
  const posts = new VisitDelivery(async operation => operation(), () => false);
  const sessionId = collector.state.session?.sessionId ?? collector.state.candidates[0]?.sessionId;
  if (sessionId && value.activeSession && (value.activeSession as { sessionId: string }).sessionId !== sessionId) throw new StorageFailure('conflict');
  posts.restore(structuredClone(value.visitDelivery), sessionId);
  if (posts.blocked) throw new StorageFailure(value.visitDelivery?.apiBaseUrl !== posts.checkpoint.apiBaseUrl ? 'server-changed' : 'corrupt');
  const ready = collector.status(0, false).readyVisits;
  if (ready.length && value.visitDelivery === undefined) throw new StorageFailure('corrupt');
  if (posts.checkpoint.entries.length && (value.behaviorDelivery === undefined
    || value.behaviorDelivery.entries.length !== posts.checkpoint.entries.length)) throw new StorageFailure('corrupt');
  for (const [index, entry] of posts.checkpoint.entries.entries()) {
    if (entry.sequence !== index + 1) throw new StorageFailure('conflict');
    const visit = ready.find(v => v.visitId === entry.visitId);
    if (!visit || Object.keys(entry.visit).some(key => !['activeDurationMs', 'tabSwitchCount', 'behaviorVersion'].includes(key)
      && entry.visit[key as keyof typeof visit] !== visit[key as keyof typeof visit])
      || !coversBehavior(visit, entry.visit)) throw new StorageFailure('conflict');
  }
  const behavior = new BehaviorDelivery(async operation => operation(), () => false);
  behavior.restore(structuredClone(value.behaviorDelivery), posts.checkpoint.entries);
  if (behavior.blocked) throw new StorageFailure('corrupt');
  for (const entry of behavior.checkpoint.entries) {
    const visit = ready.find(v => v.visitId === entry.visitId);
    if (!visit || !coversBehavior(visit, entry.latest)) throw new StorageFailure('conflict');
  }
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new StorageFailure('storage'));
    transaction.onerror = () => { /* Abort is authoritative; request success is not a commit. */ };
  });
}
export class DurableRepository {
  private opening?: Promise<IDBDatabase>;
  private revision = 0;
  private initialization?: Promise<{ value: DurableState; recovered: boolean }>;
  private migrated?: string;
  private open() {
    return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = event => {
        if ((event as IDBVersionChangeEvent).oldVersion === 0) request.result.createObjectStore(STORE);
      };
      let rejected = false;
      request.onerror = request.onblocked = () => { rejected = true; reject(new StorageFailure('storage')); };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        resolve(db);
      };
    });
  }
  async close() { (await this.opening?.catch(() => undefined))?.close(); this.opening = undefined; }
  private async read(): Promise<RecordState | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly'), completed = done(tx);
    const request = tx.objectStore(STORE).get('current');
    await completed;
    return request.result;
  }
  initialize(legacy: Partial<DurableState>) {
    return this.initialization ??= this.hydrate(legacy);
  }
  private async hydrate(legacy: Partial<DurableState>): Promise<{ value: DurableState; recovered: boolean }> {
    const saved = await this.read();
    const hasLegacy = LEGACY_KEYS.some(key => legacy[key as keyof DurableState] !== undefined);
    const imported = { ...legacy, collection: legacy.collection ?? emptyState() };
    // Canonical keys make the receipt independent of Chrome's property enumeration order.
    const canonical = (value: unknown): string => JSON.stringify(value, function (_key, v) {
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;
    });
    const legacyData = Object.fromEntries(LEGACY_KEYS.map(key => [key, legacy[key as keyof DurableState]]));
    const digest = hasLegacy ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(legacyData))))).map(v => v.toString(16).padStart(2, '0')).join('') : undefined;
    if (saved) {
      if (saved.format !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new StorageFailure('corrupt');
      validateState(saved.value);
      const sessionId = saved.value.collection.session?.sessionId ?? saved.value.collection.candidates[0]?.sessionId ?? null;
      if (saved.sessionId !== sessionId) throw new StorageFailure('conflict');
      if (hasLegacy && saved.migrated !== digest
        && canonical(legacyData) !== canonical(Object.fromEntries(LEGACY_KEYS.map(key => [key, saved.value[key as keyof DurableState]])))) throw new StorageFailure('conflict');
      this.revision = saved.revision; this.migrated = saved.migrated;
      return { value: saved.value, recovered: Boolean(sessionId) };
    }
    validateState(imported);
    this.migrated = digest;
    await this.save(imported);
    return { value: imported, recovered: Boolean(imported.collection.session || imported.collection.candidates.length) };
  }
  async save(value: DurableState): Promise<void> {
    validateState(value);
    const snapshot = structuredClone(value);
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' }), completed = done(tx);
    const store = tx.objectStore(STORE), request = store.get('current');
    const expectedRevision = this.revision, revision = expectedRevision + 1;
    request.onsuccess = () => {
      if ((request.result?.revision ?? 0) !== expectedRevision) { tx.abort(); return; }
      try { store.put({ format: 1, revision, migrated: this.migrated,
        sessionId: snapshot.collection.session?.sessionId ?? snapshot.collection.candidates[0]?.sessionId ?? null, value: snapshot } satisfies RecordState, 'current'); } catch { tx.abort(); }
    };
    await completed;
    this.revision = revision;
  }
}

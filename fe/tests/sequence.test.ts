import { beforeEach, describe, expect, it } from 'vitest';
import { Collector, MAX_CANDIDATES } from '../src/background/collector';
import type { CollectionState, PageSnapshot, PageVisit } from '../src/shared/types';

const page = (identity = 'a', content = '공개 기술 문서의 의미 있는 본문입니다. '.repeat(5)): PageSnapshot => ({ identity, content, normalizedUrl: 'https://example.com/docs', domain: 'example.com', title: '공개 문서', isSearchResultPage: false });
const search: PageSnapshot = { ...page(), isSearchResultPage: true, normalizedUrl: 'https://www.google.com/search', domain: 'www.google.com', searchQuery: 'JWT', organicResultCount: 1 };
let collector: Collector;
const observe = (tab: number, time: number, snapshot = page()) => collector.observe(tab, collector.state.tabs[tab].documentId, collector.state.session!.sessionId, snapshot, undefined, time);
const ready = () => collector.status(collector.current(collector.state.foregroundTabId ?? -1)?.activeSince ?? 0).readyVisits;
// FE contract check only: BE also accepts gaps; these finalized inputs stay contiguous and ordered.
function windowIds(visits: PageVisit[]): string[][] {
  expect(visits.map(v => v.sequence)).toEqual(visits.map((_, i) => i + 1));
  return visits.slice(4).map((_, i) => visits.slice(i, i + 5).map(v => v.visitId));
}
beforeEach(() => {
  let id = 0;
  collector = new Collector(undefined, () => `id-${++id}`);
  collector.start('공개 문서 조사하기', 0);
});
describe('finalized valid visit sequence contract', () => {
  it.each([5, 6, 7])('offers %i valid visits as contiguous size-5 stride-1 inputs', count => {
    collector.foreground(1, 0);
    for (let i = 0; i < count; i++) {
      collector.navigate(1, `doc${i}`, 'a', 'new', i * 2000);
      observe(1, i * 2000 + 1000);
    }
    collector.stop(count * 2000);
    const visits = ready();
    const ids = collector.state.candidates.map(v => v.visitId);
    expect(visits.map(v => v.visitId)).toEqual(ids);
    expect(new Set(ids).size).toBe(count); // Same-URL actual revisits remain separate visits.
    expect(windowIds(visits)).toEqual(Array.from({ length: count - 4 }, (_, i) => ids.slice(i, i + 5)));
  });
  it.each([1, 3])('skips %i consecutive exclusions between valid visits without consuming sequence', excludedCount => {
    collector.foreground(1, 0); collector.navigate(1, 'first', 'a', 'new', 0); observe(1, 1000);
    for (let i = 0; i < excludedCount; i++) collector.navigate(1, `excluded${i}`, null, 'new', 2000 + i);
    for (let i = 0; i < 4; i++) {
      collector.navigate(1, `last${i}`, 'a', 'new', 3000 + i * 2000); observe(1, 4000 + i * 2000);
    }
    collector.stop(10000);
    expect(ready().map(v => v.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(windowIds(ready())).toEqual([ready().map(v => v.visitId)]);
    expect(collector.state.candidates.filter(v => v.state === 'excluded').every(v => v.sequence === null)).toBe(true);
  });
  it('waits for an earlier background tab even when later valid visits finalize first', () => {
    collector.navigate(1, 'earlier', 'a', 'new', 0);
    collector.foreground(2, 0); collector.navigate(2, 'later', 'a', 'new', 0); observe(2, 1000); collector.removeTab(2, 1000);
    expect(collector.status(1000).visits).toHaveLength(1);
    expect(ready()).toEqual([]);
    expect(collector.state.candidates[1]).toMatchObject({ finalized: true, sequence: null });
    collector = new Collector(structuredClone(collector.state));
    expect(ready()).toEqual([]);
    collector.foreground(1, 2000); observe(1, 3000); collector.removeTab(1, 3000);
    expect(ready().map(v => v.visitId)).toEqual(collector.state.candidates.map(v => v.visitId));
    expect(ready().map(v => v.sequence)).toEqual([1, 2]);
  });
  it('releases later visits when an earlier pending tab closes as excluded', () => {
    collector.navigate(1, 'earlier', 'a', 'new', 0);
    collector.foreground(2, 0); collector.navigate(2, 'later', 'a', 'new', 0); observe(2, 1000); collector.removeTab(2, 1000);
    collector.removeTab(1, 2000);
    expect(ready()).toHaveLength(1);
    expect(ready()[0]).toMatchObject({ sequence: 1, visitId: collector.state.candidates[1].visitId });
  });
  it('waits for recoverable search exclusion, keeping recovered visit in original order', () => {
    collector.foreground(1, 0); collector.navigate(1, 'earlier', 'a', 'new', 0);
    collector.observe(1, 'earlier', collector.state.session!.sessionId, null, 'unavailable-content', 8000);
    const earlierId = collector.current(1)!.visitId;
    collector.foreground(2, 8000); collector.navigate(2, 'later', 'a', 'new', 8000); observe(2, 9000); collector.removeTab(2, 9000);
    expect(ready()).toEqual([]);
    collector.foreground(1, 10000); observe(1, 10000, search); observe(1, 11000, search); collector.removeTab(1, 11000);
    expect(ready().map(v => v.sequence)).toEqual([1, 2]);
    expect(ready()[0].visitId).toBe(earlierId);
  });
  it('excludes a formerly valid sensitive document before allocating any server sequence', () => {
    collector.foreground(1, 0); collector.navigate(1, 'earlier', 'a', 'new', 0); observe(1, 1000);
    collector.foreground(2, 1000); collector.navigate(2, 'later', 'a', 'new', 1000); observe(2, 2000); collector.removeTab(2, 2000);
    expect(ready()).toEqual([]);
    collector.observe(1, 'earlier', collector.state.session!.sessionId, null, 'dom-policy', 2000);
    expect(collector.current(1)?.snapshot).toBeUndefined();
    expect(collector.current(1)?.finalized).toBe(true);
    expect(ready().map(v => v.sequence)).toEqual([1]);
    expect(ready()[0].visitId).toBe(collector.state.candidates[1].visitId);
  });
  it.each(['url-policy', 'dom-policy'] as const)('never blocks later valid visits on an open permanently excluded %s tab', reason => {
    collector.navigate(1, 'excluded', reason === 'url-policy' ? null : 'a', 'new', 0);
    if (reason === 'dom-policy') collector.observe(1, 'excluded', collector.state.session!.sessionId, null, reason, 0);
    collector.foreground(2, 0); collector.navigate(2, 'valid', 'a', 'new', 0); observe(2, 1000); collector.removeTab(2, 1000);
    expect(collector.state.tabs[1]).toBeDefined();
    expect(collector.current(1)).toMatchObject({ finalized: true, state: 'excluded', sequence: null });
    expect(ready().map(v => v.sequence)).toEqual([1]);
  });
  it('preserves reload identity and finalizes SPA predecessor before the new visit', () => {
    collector.foreground(1, 0); collector.navigate(1, 'first', 'a', 'new', 0); observe(1, 1000);
    const id = collector.current(1)!.visitId;
    collector.navigate(1, 'reload', 'a', 'reload', 1200); observe(1, 2200);
    expect(collector.current(1)).toMatchObject({ visitId: id, finalized: false, sequence: null });
    const next = page('b', '우주 탐사선이 먼 행성과 은하의 형성을 연구합니다. '.repeat(5));
    observe(1, 2300, next); observe(1, 3300, next);
    expect(ready()[0]).toMatchObject({ visitId: id, sequence: 1 });
    expect(collector.current(1)!.visitId).not.toBe(id);
    collector.stop(3300);
    expect(ready().map(v => v.sequence)).toEqual([1, 2]);
  });
  it('ignores snapshots from a replaced document while accepting a late current snapshot', () => {
    collector.foreground(1, 0); collector.navigate(1, 'old', 'a', 'new', 0);
    collector.navigate(1, 'current', 'b', 'new', 1000);
    collector.observe(1, 'old', collector.state.session!.sessionId, page(), undefined, 3000);
    expect(collector.current(1)?.snapshot).toBeUndefined();
    observe(1, 4000, page('b')); collector.stop(4000);
    expect(ready().map(v => v.sequence)).toEqual([1]);
  });
  it('keeps resend payloads and next sequence stable across worker restoration and repeated status reads', () => {
    collector.foreground(1, 0); collector.navigate(1, 'first', 'a', 'new', 0); observe(1, 1000); collector.removeTab(1, 1200);
    const original = structuredClone(ready());
    collector = new Collector(structuredClone(collector.state));
    expect(ready()).toEqual(original);
    collector.foreground(2, 2000); collector.navigate(2, 'next', 'a', 'new', 2000); observe(2, 3000); collector.stop(3000);
    expect(ready()[0]).toEqual(original[0]);
    expect(ready().map(v => v.sequence)).toEqual([1, 2]);
    expect(new Set(ready().map(v => v.sequence)).size).toBe(2);
  });
  it('migrates local-only legacy gaps while preserving IDs, payload and active time', () => {
    collector.foreground(1, 0); collector.navigate(1, 'excluded', null, 'new', 0);
    collector.navigate(1, 'closed', 'a', 'new', 1000); observe(1, 2000);
    collector.navigate(1, 'open', 'a', 'new', 3000); observe(1, 4000);
    const legacy: any = structuredClone(collector.state);
    delete legacy.sequenceVersion;
    legacy.candidates.forEach((c: any, i: number) => { delete c.finalized; c.sequence = i + 1; });
    legacy.nextSequence = 4;
    collector = new Collector(legacy as CollectionState);
    expect(collector.state.candidates.map(c => c.visitId)).toEqual(legacy.candidates.map((c: any) => c.visitId));
    expect(collector.status(4000).readyVisits[0]).toMatchObject({ sequence: 1, content: legacy.candidates[1].snapshot.content, activeDurationMs: legacy.candidates[1].activeDurationMs });
    expect(collector.current(1)).toMatchObject({ sequence: null, finalized: false });
    collector.stop(4000);
    expect(ready().map(v => v.sequence)).toEqual([1, 2]);
  });
  it('finalizes all tabs at capacity so the now-unrecoverable prefix cannot block valid visits', () => {
    collector.navigate(1, 'blocking', 'a', 'new', 0);
    collector.foreground(2, 0); collector.navigate(2, 'valid', 'a', 'new', 0); observe(2, 1000);
    for (let i = 2; i <= MAX_CANDIDATES; i++) collector.navigate(3, `doc${i}`, null, 'new', 1000);
    expect(collector.state.capacityReached).toBe(true);
    expect(collector.state.candidates.every(c => c.finalized)).toBe(true);
    expect(ready().map(v => v.sequence)).toEqual([1]);
  });
  it('finalizes open candidates from a legacy checkpoint already at capacity', () => {
    collector.navigate(1, 'pending', 'a', 'new', 0);
    collector.foreground(2, 0); collector.navigate(2, 'valid', 'a', 'new', 0); observe(2, 1000); collector.foreground(null, 1000);
    const legacy: any = structuredClone(collector.state);
    legacy.capacityReached = true;
    delete legacy.sequenceVersion;
    legacy.candidates.forEach((c: any, i: number) => { delete c.finalized; c.sequence = i + 1; });
    collector = new Collector(legacy);
    expect(collector.state.candidates.every(c => c.finalized)).toBe(true);
    expect(ready().map(v => v.sequence)).toEqual([1]);
  });
  it('does not change finalized records or add visits after stop, even on delayed recovery/navigation', () => {
    collector.foreground(1, 0); collector.navigate(1, 'doc', 'a', 'new', 0); observe(1, 1000);
    const sessionId = collector.state.session!.sessionId;
    collector.stop(1000);
    const original = structuredClone(collector.state.candidates);
    collector.observe(1, 'doc', sessionId, null, 'dom-policy', 2000);
    collector.navigate(2, 'late', 'a', 'new', 2000); collector.foreground(1, 3000); collector.leave(1, 'doc', 4000); collector.stop(5000);
    expect(collector.state.candidates).toEqual(original);
    expect(ready().map(v => v.sequence)).toEqual([1]);
  });
});

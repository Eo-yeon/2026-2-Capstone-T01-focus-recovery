import { serverSession } from './session-fixture';
import { beforeEach, describe, expect, it } from 'vitest';
import { Collector } from '../src/background/collector';
import { isSearchContentChange } from '../src/shared/content-change';
import { serialExecutor } from '../src/background/serial';
import type { PageSnapshot } from '../src/shared/types';
const search = (identity = 'a', query = 'JWT', title = '인증'): PageSnapshot => ({ normalizedUrl: 'https://www.google.com/search', domain: 'www.google.com', identity, title: '검색', isSearchResultPage: true, searchQuery: query, organicResultCount: 1, content: `검색어: ${query}\n\n검색 결과 1\n제목: ${title}` });
let collector: Collector;
const observe = (snapshot: PageSnapshot | null, now: number, reason?: 'unavailable-content' | 'search-pending') => collector.observe(1, collector.state.tabs[1].documentId, collector.state.session!.sessionId, snapshot, reason, now);
beforeEach(() => {
  let id = 0; collector = new Collector(undefined, () => `id-${++id}`);
  collector.start(serverSession('공개 문서 조사하기', 0)); collector.foreground(1, 0); collector.navigate(1, 'doc', 'a', 'new', 0);
});
describe('search candidate lifecycle', () => {
  it('validates a short organic result at exactly 1 second; hides internal evidence in PageVisit', () => {
    expect([...search().content].length).toBeLessThan(50);
    observe(search(), 999); expect(collector.status(999).visits).toHaveLength(0);
    observe(search(), 1000);
    expect(collector.status(1000).visits[0]).toMatchObject({ searchQuery: 'JWT', isSearchResultPage: true, normalizedUrl: 'https://www.google.com/search', activeDurationMs: 1000 });
    expect(collector.status(1000).visits[0]).not.toHaveProperty('organicResultCount');
    expect(collector.status(1000).visits[0]).not.toHaveProperty('identity');
  });
  it('waits on empty initial DOM and accepts asynchronously loaded results', () => {
    observe(null, 1100); expect(collector.current(1)?.state).toBe('pending');
    observe(search(), 2500); expect(collector.status(2500).visits).toHaveLength(1);
  });
  it('erases an exhausted pending payload and recovers on later verified search results', () => {
    observe(search(), 500); observe(null, 8000, 'unavailable-content');
    expect(collector.current(1)).toMatchObject({ state: 'excluded', reason: 'unavailable-content' });
    expect(collector.current(1)?.snapshot).toBeUndefined();
    observe(search(), 9000); observe(search(), 10000);
    expect(collector.current(1)?.state).toBe('valid');
  });
  it.each([{ searchQuery: null }, { searchQuery: '' }, { organicResultCount: 0 }, { organicResultCount: undefined }])('rejects search data without extraction evidence: %s', fields => {
    observe({ ...search(), ...fields }, 2000); expect(collector.status(2000).visits).toHaveLength(0);
    expect(collector.current(1)?.snapshot).toBeUndefined();
  });
  it('preserves a valid search and other visits through temporary missing DOM or failed extraction', () => {
    observe(search(), 1000); const original = structuredClone(collector.current(1));
    observe(null, 2000); observe(null, 9000, 'unavailable-content'); observe(null, 10000, 'search-pending');
    expect(collector.current(1)).toMatchObject({ state: 'valid', snapshot: original?.snapshot });
    collector.navigate(1, 'failed-search', 'b', 'new', 11000); observe(null, 19000, 'unavailable-content');
    expect(collector.status(19000).visits[0].visitId).toBe(original?.visitId);
  });
  it('reuses ID, sequence and tab key on reload and tab return', () => {
    observe(search(), 1000); const original = collector.current(1)!;
    collector.navigate(1, 'reloaded', 'a', 'reload', 1200); observe(null, 1300); observe(search(), 2400);
    collector.foreground(2, 2500); collector.foreground(1, 5000); collector.navigate(1, 'reloaded', 'a', 'existing', 5000);
    expect(collector.current(1)).toBe(original); expect(collector.state.candidates).toHaveLength(1);
    expect(original.activeDurationMs).toBe(2500);
  });
  it('creates new visits on full back/forward search navigation with the same normalized URL', () => {
    observe(search(), 1000); collector.navigate(1, 'next', 'b', 'new', 1100); observe(search('b', '우주', '행성'), 2100);
    collector.navigate(1, 'doc', 'a', 'new', 2200); observe(search(), 3200);
    collector.stop(3200);
    expect(collector.status(3200).readyVisits.map(v => v.sequence)).toEqual([1, 2, 3]);
    expect(new Set(collector.status(3200).visits.map(v => v.visitId)).size).toBe(3);
  });
  it('ignores query-only and UI changes, then creates a SPA visit for query plus actual short result change', () => {
    observe(search(), 1000); observe(search('b', '우주'), 1500);
    expect(collector.state.candidates).toHaveLength(1);
    observe(search('b', '우주', '행성'), 2000); observe(search('b', '우주', '행성'), 3000);
    expect(collector.status(3000).visits.map(v => v.searchQuery)).toEqual(['JWT', '우주']);
    expect(isSearchContentChange(search().content, search('b', '우주').content)).toBe(false);
  });
  it('keeps an append-only result change and same-URL content change in the existing visit', () => {
    observe(search(), 1000); observe({ ...search('b'), content: `${search().content}\n\n검색 결과 2\n제목: 추가 문서`, organicResultCount: 2 }, 1500);
    observe(search('a', 'JWT', '행성'), 2000); expect(collector.state.candidates).toHaveLength(1);
  });
  it('handles content-before-URL changes and reload after a URL-only search change', () => {
    observe(search(), 1000); observe(search('a', '우주', '행성'), 1500); observe(search('b', '우주', '행성'), 2000);
    expect(collector.state.candidates).toHaveLength(2);
    observe(search('c', '우주', '행성'), 2100); collector.navigate(1, 'reload', 'c', 'reload', 2200);
    expect(collector.state.candidates).toHaveLength(2);
  });
  it('restores search evidence and the pending lifecycle through worker restart', () => {
    observe(search(), 500); const saved = structuredClone(collector.state); collector = new Collector(saved, () => 'new');
    collector.reconcileForeground(1, 1000);
    observe(search(), 1500); expect(collector.status(1500).visits[0]).toMatchObject({ visitId: saved.candidates[0].visitId, sequence: null, searchQuery: 'JWT', activeDurationMs: 1000 });
    collector.stop(1500);
    expect(collector.status(1500).readyVisits[0]).toMatchObject({ visitId: saved.candidates[0].visitId, sequence: 1 });
  });
  it('keeps concurrent search candidates in creation order without premature sequence allocation', async () => {
    const queue = serialExecutor(); const id = collector.state.session!.sessionId;
    await Promise.all([2, 3].map(tab => queue(async () => { collector.navigate(tab, `doc${tab}`, 'b', 'new', 1000); collector.observe(tab, `doc${tab}`, id, search('b'), undefined, 1000); })));
    expect(collector.state.candidates.map(v => v.browserTabKey)).toHaveLength(3);
    expect(new Set(collector.state.candidates.map(v => v.visitId)).size).toBe(3);
    expect(collector.state.candidates.map(v => v.sequence)).toEqual([null, null, null]);
  });
});

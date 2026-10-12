import { beforeEach, describe, expect, it } from 'vitest';
import { Collector, MAX_CANDIDATES } from '../src/background/collector';
import { isMajorContentChange } from '../src/shared/content-change';
import { serialExecutor } from '../src/background/serial';
import type { PageSnapshot } from '../src/shared/types';
let collector: Collector;
const bodyA = 'JWT 문서에서 토큰 검증 방법과 Spring Security 인증 처리 절차를 설명합니다. 안전한 공개 기술 문서의 의미 있는 본문입니다.';
const bodyB = '우주 탐사선은 먼 행성의 대기와 암석을 연구합니다. 천문학자들이 수집한 관측 자료로 태양계 형성 과정을 분석하는 과학 기사입니다.';
const page = (identity = 'a', content = bodyA): PageSnapshot => ({ identity, content, normalizedUrl: 'https://example.com/post', domain: 'example.com', title: '공개 기술 문서', isSearchResultPage: false });
const session = () => collector.state.session!.sessionId;
const observe = (tab = 1, doc = 'doc1', snapshot: PageSnapshot | null = page(), time = 1000) => collector.observe(tab, doc, session(), snapshot, undefined, time);
beforeEach(() => { let id = 0; collector = new Collector(undefined, () => `id-${++id}`); });
describe('session and visit state', () => {
  it('does not collect before a session or after stop; ignores delayed previous-session messages', () => {
    collector.navigate(1, 'doc1', 'a', 'new', 0);
    expect(collector.state.candidates).toHaveLength(0);
    collector.start('공개 문서 찾기', 0); const oldId = session();
    collector.navigate(1, 'doc1', 'a', 'new', 0); observe(); collector.stop(1500);
    collector.navigate(2, 'doc2', 'b', 'new', 1600);
    expect(collector.state.candidates).toHaveLength(1);
    collector.start('다른 문서 찾기', 2000); collector.navigate(1, 'doc1', 'a', 'new', 2000);
    collector.observe(1, 'doc1', oldId, page(), undefined, 4000);
    expect(collector.current(1)?.snapshot).toBeUndefined();
  });
  it('enforces existing BE goal validation and preserves a running session on duplicate start', () => {
    expect(() => collector.start('   ', 0)).toThrow();
    expect(() => collector.start('한'.repeat(151), 0)).toThrow();
    collector.start('  공개 문서 찾기  ', 0); const id = session();
    expect(collector.state.session?.goalText).toBe('공개 문서 찾기');
    expect(() => collector.start('다른 작업 목표', 0)).toThrow();
    expect(session()).toBe(id);
  });
  it('becomes valid only at 1,000 ms of focused active time', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0);
    observe(1, 'doc1', page(), 999); expect(collector.status(999).visits).toHaveLength(0);
    observe(); expect(collector.status(1000).visits).toHaveLength(1);
    expect(collector.status(1000).visits[0]).toMatchObject({ activeDurationMs: 1000, searchQuery: null, tabSwitchCount: null, behaviorVersion: null });
    expect(collector.status(1000).visits[0]).not.toHaveProperty('identity');
  });
  it('excludes short content and short active time on document departure', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0);
    observe(1, 'doc1', page('a', 'x'.repeat(49)), 1000); collector.navigate(1, 'doc2', 'b', 'new', 1100);
    expect(collector.state.candidates[0].reason).toBe('short-content');
    observe(1, 'doc2', page('b'), 1200); collector.stop(1500);
    expect(collector.state.candidates[1].reason).toBe('short-duration');
    expect(collector.status(2000).visits).toHaveLength(0);
  });
  it('accepts the exact 50-character boundary', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0);
    observe(1, 'doc1', page('a', '한'.repeat(50)), 1000);
    expect(collector.status(1000).visits).toHaveLength(1);
  });
  it('does not count background tabs or an unfocused/minimized Chrome window', () => {
    collector.start('공개 문서 찾기', 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    expect(collector.current(1)?.activeDurationMs).toBe(0);
    collector.foreground(1, 2000); collector.foreground(null, 2500); collector.foreground(1, 10000); observe(1, 'doc1', page(), 10500);
    expect(collector.current(1)?.activeDurationMs).toBe(1000);
  });
  it('reuses visit id, sequence and duration on a same-document reload', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    const original = collector.current(1)!;
    collector.leave(1, 'doc1', 1100); collector.navigate(1, 'reloadDoc', 'a', 'reload', 1300); observe(1, 'reloadDoc', page(), 2300);
    expect(collector.current(1)).toBe(original); expect(collector.state.candidates).toHaveLength(1);
    expect(original.activeDurationMs).toBe(2100);
  });
  it('creates new visits for full navigation and back/forward, even to a known URL or BFCache document id', () => {
    collector.start('공개 문서 찾기', 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    collector.navigate(1, 'doc2', 'b', 'new', 2000); observe(1, 'doc2', page('b'), 3000);
    collector.navigate(1, 'doc1', 'a', 'new', 4000); observe(1, 'doc1', page(), 5000);
    expect(collector.state.candidates.map(v => v.sequence)).toEqual([1, 2, 3]);
    expect(new Set(collector.state.candidates.map(v => v.visitId)).size).toBe(3);
    expect(new Set(collector.state.candidates.map(v => v.browserTabKey)).size).toBe(1);
  });
  it('resumes the same visit when switching back to an existing tab', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'existing', 0); observe();
    const original = collector.current(1);
    collector.navigate(2, 'doc2', 'b', 'existing', 1200); collector.foreground(2, 1200); collector.foreground(1, 5000);
    collector.navigate(1, 'doc1', 'a', 'existing', 5000); observe(1, 'doc1', page(), 6000);
    expect(collector.current(1)).toBe(original); expect(original?.activeDurationMs).toBe(2200);
    expect(collector.state.candidates).toHaveLength(2);
  });
  it('creates a SPA visit only when URL identity and major content both change, retaining normalized URL', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    observe(1, 'doc1', page('b'), 1500); expect(collector.state.candidates).toHaveLength(1);
    observe(1, 'doc1', page('b', bodyB), 2000); observe(1, 'doc1', page('b', bodyB), 3000);
    expect(collector.state.candidates).toHaveLength(2);
    expect(collector.current(1)?.sequence).toBe(2);
    expect(collector.status(3000).visits.map(v => v.normalizedUrl)).toEqual(['https://example.com/post', 'https://example.com/post']);
  });
  it('detects content-before-history updates using the frozen document baseline', () => {
    collector.start('공개 문서 찾기', 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    observe(1, 'doc1', page('a', bodyB), 1500); observe(1, 'doc1', page('b', bodyB), 2000);
    expect(collector.state.candidates).toHaveLength(2);
  });
  it('does not duplicate UI changes, append-only changes, same-URL DOM changes, or repeated snapshots', () => {
    collector.start('공개 문서 찾기', 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    observe(1, 'doc1', page('b', `${bodyA}\n댓글 펼치기`), 1500);
    observe(1, 'doc1', page('a', bodyB), 1600); observe(1, 'doc1', page(), 1700);
    expect(collector.state.candidates).toHaveLength(1);
    expect(isMajorContentChange(bodyA, `${bodyA} ${bodyB}`)).toBe(false);
  });
  it('reuses a reload after a URL-only UI change', () => {
    collector.start('공개 문서 찾기', 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    observe(1, 'doc1', page('b'), 1500); collector.navigate(1, 'doc2', 'b', 'reload', 2000);
    expect(collector.state.candidates).toHaveLength(1);
  });
  it('rejects stale documents and preserves sensitive exclusions without any payload', () => {
    collector.start('공개 문서 찾기', 0); collector.navigate(1, 'doc1', null, 'new', 0);
    observe(); expect(collector.current(1)?.snapshot).toBeUndefined();
    collector.navigate(1, 'doc2', 'b', 'new', 2000); observe(1, 'doc1', page(), 3000);
    expect(collector.current(1)?.snapshot).toBeUndefined();
    collector.observe(1, 'doc2', session(), page('b'), 'dom-policy', 4000);
    expect(collector.current(1)?.state).toBe('excluded'); expect(collector.current(1)?.snapshot).toBeUndefined();
  });
  it.each([true, false])('never promotes search pages even without results/query (flag %s)', flag => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0);
    collector.observe(1, 'doc1', session(), { ...page(), isSearchResultPage: flag }, 'search-pending', 2000);
    expect(collector.status(3000).visits).toHaveLength(0); expect(collector.current(1)?.reason).toBe('search-pending');
    expect(collector.current(1)?.snapshot).toBeUndefined();
  });
  it('erases a valid payload if a sensitive DOM appears later', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    collector.observe(1, 'doc1', session(), null, 'dom-policy', 2000);
    expect(collector.status(2000).visits).toHaveLength(0); expect(collector.current(1)?.snapshot).toBeUndefined();
  });
  it('recovers ids, sequences, duration and session after worker rehydration', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    const state = structuredClone(collector.state); collector = new Collector(state, () => 'newId');
    expect(collector.status(2000).visits[0]).toMatchObject({ visitId: state.candidates[0].visitId, sequence: 1, activeDurationMs: 2000 });
    collector.navigate(2, 'doc2', 'b', 'new', 2000); expect(collector.current(2)?.sequence).toBe(2);
  });
  it('stops safely at bounded development storage capacity', () => {
    collector.start('공개 문서 찾기', 0);
    for (let i = 0; i <= MAX_CANDIDATES; i++) collector.navigate(1, `doc${i}`, 'a', 'new', i);
    expect(collector.state.candidates).toHaveLength(MAX_CANDIDATES); expect(collector.state.capacityReached).toBe(true);
    expect(collector.state.foregroundTabId).toBeNull();
  });
  it('serializes simultaneous tabs, allows excluded sequence gaps, and survives operation failure', async () => {
    collector.start('공개 문서 찾기', 0); const queue = serialExecutor();
    const events = Array.from({ length: 20 }, (_, i) => queue(async () => { await Promise.resolve(); collector.navigate(i, `doc${i}`, i === 3 ? null : 'a', 'new', 0); }));
    await Promise.all(events);
    expect(collector.state.candidates.map(v => v.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(collector.state.candidates[3].state).toBe('excluded');
    await expect(queue(async () => { throw new Error('test'); })).rejects.toThrow();
    await expect(queue(async () => 42)).resolves.toBe(42);
  });
  it('finalizes visits on close/stop without accruing time after end', () => {
    collector.start('공개 문서 찾기', 0); collector.foreground(1, 0); collector.navigate(1, 'doc1', 'a', 'new', 0); observe();
    collector.stop(1500); expect(collector.status(10000).visits[0].activeDurationMs).toBe(1500);
    expect(collector.state.candidates[0].activeSince).toBeNull();
  });
});

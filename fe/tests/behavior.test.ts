import { beforeEach, describe, expect, it } from 'vitest';
import { Collector } from '../src/background/collector';
import type { PageSnapshot, VisitBehavior } from '../src/shared/types';

const page = (identity = 'a', content = '공개 기술 문서 본문입니다. '.repeat(8)): PageSnapshot => ({ identity, content, normalizedUrl: 'https://example.com/docs', domain: 'example.com', title: '문서', isSearchResultPage: false });
let collector: Collector;
function open(tab: number, now = 0) {
  collector.navigate(tab, `doc${tab}`, `page${tab}`, 'new', now);
  collector.observe(tab, `doc${tab}`, collector.state.session!.sessionId, page(`page${tab}`), undefined, now);
}
const behavior = (tab: number): VisitBehavior => {
  const { activeDurationMs, tabSwitchCount, behaviorVersion } = collector.current(tab)!;
  return { activeDurationMs, tabSwitchCount, behaviorVersion };
};
beforeEach(() => {
  let id = 0;
  collector = new Collector(undefined, () => `id-${++id}`);
  collector.start('공개 문서 조사하기', 0);
  collector.foreground(1, 0);
  open(1);
});
describe('per-visit cumulative behavior snapshots', () => {
  it('attributes A → B → A → B to the departing visits and excludes inactive time', () => {
    open(2);
    collector.foreground(2, 1500);
    expect(behavior(1)).toEqual({ activeDurationMs: 1500, tabSwitchCount: 1, behaviorVersion: 2 });
    collector.foreground(1, 3500);
    expect(behavior(2)).toEqual({ activeDurationMs: 2000, tabSwitchCount: 1, behaviorVersion: 2 });
    collector.foreground(2, 4000);
    expect(behavior(1)).toEqual({ activeDurationMs: 2000, tabSwitchCount: 2, behaviorVersion: 4 });
  });
  it('does not count the initial tab, duplicate activation or a background candidate', () => {
    open(2);
    collector.foreground(1, 1000);
    const before = behavior(1);
    collector.foreground(1, 1000);
    expect(behavior(1)).toEqual(before);
    expect(before.tabSwitchCount).toBe(0);
    expect(behavior(2)).toEqual({ activeDurationMs: 0, tabSwitchCount: 0, behaviorVersion: 0 });
  });
  it('pauses on blur/minimize and resumes the same tab without a switch', () => {
    collector.foreground(null, 1500);
    const paused = behavior(1);
    collector.foreground(null, 3000);
    collector.status(5000);
    expect(behavior(1)).toEqual(paused);
    collector.foreground(1, 6000);
    collector.foreground(null, 7000);
    expect(behavior(1)).toEqual({ activeDurationMs: 2500, tabSwitchCount: 0, behaviorVersion: 2 });
  });
  it('counts a cross-window switch once across intervening WINDOW_ID_NONE and duplicate events', () => {
    open(2);
    collector.foreground(null, 1500);
    collector.foreground(2, 1500);
    collector.foreground(2, 1500);
    expect(behavior(1).tabSwitchCount).toBe(1);
    collector.foreground(null, 2000);
    collector.foreground(1, 2000);
    expect(behavior(2)).toMatchObject({ activeDurationMs: 500, tabSwitchCount: 1 });
  });
  it('counts departure to an unpermitted/untracked tab without collecting its data', () => {
    collector.foreground(99, 1200);
    collector.foreground(99, 1200);
    expect(behavior(1)).toMatchObject({ activeDurationMs: 1200, tabSwitchCount: 1 });
    expect(collector.current(99)).toBeUndefined();
    collector.foreground(1, 5000);
    collector.stop(6000);
    expect(behavior(1)).toMatchObject({ activeDurationMs: 2200, tabSwitchCount: 1 });
    expect(collector.state.candidates).toHaveLength(1);
  });
  it('does not give excluded pages behavior on departure or create data for them', () => {
    collector.navigate(2, 'restricted', null, 'new', 0);
    collector.foreground(2, 1200);
    collector.foreground(1, 2000);
    expect(collector.current(2)).toMatchObject({ state: 'excluded', activeDurationMs: 0, tabSwitchCount: 0, behaviorVersion: 0 });
    expect(collector.current(2)?.snapshot).toBeUndefined();
  });
  it.each([true, false])('counts close-induced replacement once (activation first: %s)', activationFirst => {
    open(2);
    if (activationFirst) collector.foreground(2, 1200);
    collector.removeTab(1, 1200);
    collector.foreground(2, 1200);
    collector.foreground(2, 1200);
    collector.removeTab(1, 1200);
    const closed = collector.status(1200).readyVisits[0];
    expect(closed).toMatchObject({ activeDurationMs: 1200, tabSwitchCount: 1, behaviorVersion: 2, sequence: 1 });
  });
  it('does not count closing the last foreground tab without a replacement', () => {
    collector.removeTab(1, 1200);
    collector.foreground(null, 1500);
    const snapshot = collector.status(2000).readyVisits[0];
    expect(snapshot).toMatchObject({ activeDurationMs: 1200, tabSwitchCount: 0, behaviorVersion: 1 });
  });
  it('issues a new version for a switch with no extra duration and ignores duplicate switches', () => {
    collector.foreground(2, 0);
    const snapshot = behavior(1);
    expect(snapshot).toEqual({ activeDurationMs: 0, tabSwitchCount: 1, behaviorVersion: 1 });
    collector.foreground(2, 500);
    expect(behavior(1)).toEqual(snapshot);
  });
  it('does not treat a background tab closing as a switch', () => {
    open(2);
    collector.removeTab(2, 1000);
    collector.foreground(1, 1000);
    expect(behavior(1).tabSwitchCount).toBe(0);
    expect(collector.state.candidates[1].tabSwitchCount).toBe(0);
  });
  it('keeps a reload in the same visit with no switch and stops time between documents', () => {
    collector.status(1000);
    const id = collector.current(1)!.visitId;
    collector.leave(1, 'doc1', 1200);
    collector.leave(1, 'doc1', 1500);
    collector.status(1800);
    collector.navigate(1, 'reload', 'page1', 'reload', 2000);
    collector.status(3000);
    expect(collector.current(1)).toMatchObject({ visitId: id, activeDurationMs: 2200, tabSwitchCount: 0 });
  });
  it('settles navigation and gives the next visit independent counters', () => {
    collector.navigate(1, 'next', 'next', 'new', 1500);
    expect(collector.state.candidates[0]).toMatchObject({ finalized: true, activeDurationMs: 1500, tabSwitchCount: 0, behaviorVersion: 1 });
    expect(behavior(1)).toEqual({ activeDurationMs: 0, tabSwitchCount: 0, behaviorVersion: 0 });
    collector.status(2500);
    expect(behavior(1)).toEqual({ activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 });
  });
  it('retains URL-only SPA behavior and splits only on URL plus major content change', () => {
    collector.observe(1, 'doc1', collector.state.session!.sessionId, page('spa'), undefined, 1000);
    expect(collector.state.candidates).toHaveLength(1);
    collector.observe(1, 'doc1', collector.state.session!.sessionId, page('spa', '우주 탐사선은 먼 행성의 대기를 관측합니다. '.repeat(8)), undefined, 1500);
    expect(collector.state.candidates).toHaveLength(2);
    expect(collector.state.candidates.map(c => [c.activeDurationMs, c.tabSwitchCount])).toEqual([[1500, 0], [0, 0]]);
  });
  it('never associates different values with an issued version and returns independent snapshots', () => {
    const seen = new Map<number, VisitBehavior>();
    const first = collector.status(1000).visits[0];
    for (const now of [1000, 1000, 1500, 1500, 2000]) {
      const snapshot = collector.status(now).visits[0];
      const value = { activeDurationMs: snapshot.activeDurationMs, tabSwitchCount: snapshot.tabSwitchCount, behaviorVersion: snapshot.behaviorVersion };
      if (seen.has(value.behaviorVersion)) expect(value).toEqual(seen.get(value.behaviorVersion));
      seen.set(value.behaviorVersion, value);
    }
    expect(first).toMatchObject({ activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 });
    expect([...seen.values()].map(v => v.activeDurationMs)).toEqual([1000, 1500, 2000]);
    expect([...seen.keys()]).toEqual([1, 2, 3]);
  });
  it('does not recount milliseconds after backwards clock values', () => {
    collector.status(1000);
    collector.status(500);
    collector.foreground(null, 800);
    collector.foreground(1, 900);
    collector.status(1500);
    expect(behavior(1)).toEqual({ activeDurationMs: 1500, tabSwitchCount: 0, behaviorVersion: 2 });
  });
  it('restores counters, active boundaries and switch attribution across worker recreation', () => {
    open(2);
    collector.foreground(null, 1200);
    const saved = structuredClone(collector.state);
    collector = new Collector(saved);
    collector.foreground(2, 2000);
    expect(behavior(1)).toEqual({ activeDurationMs: 1200, tabSwitchCount: 1, behaviorVersion: 2 });
    collector.status(3000);
    const expected = collector.status(3000);
    collector = new Collector(structuredClone(collector.state));
    expect(collector.status(3000)).toEqual(expected);
  });
  it('migrates old unmeasured fields without changing IDs, duration or sequence', () => {
    collector.status(1000);
    const legacy: any = structuredClone(collector.state);
    const originalId = legacy.candidates[0].visitId;
    delete legacy.lastActiveTabId;
    delete legacy.lastActiveVisitId;
    for (const field of ['tabSwitchCount', 'behaviorVersion', 'activeTimeCursor']) delete legacy.candidates[0][field];
    collector = new Collector(legacy);
    expect(collector.current(1)).toMatchObject({ visitId: originalId, sequence: null, activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 });
    collector.foreground(2, 1000);
    expect(behavior(1).tabSwitchCount).toBe(1);
  });
  it('preserves checkpointed time and resumes fresh when the same tab is focused after recovery', () => {
    collector.status(1000);
    collector = new Collector(structuredClone(collector.state));
    collector.reconcileForeground(1, 5000);
    expect(behavior(1).activeDurationMs).toBe(1000);
    collector.status(6000);
    expect(behavior(1).activeDurationMs).toBe(2000);
  });
  it('does not invent time in an unknown gap when recovery finds a different foreground', () => {
    collector.status(1000);
    collector = new Collector(structuredClone(collector.state));
    collector.reconcileForeground(null, 10000);
    expect(behavior(1).activeDurationMs).toBe(1000);
    collector.foreground(1, 11000);
    collector.stop(12000);
    expect(behavior(1).activeDurationMs).toBe(2000);
  });
  it('retains the last actually viewed visit when its tab navigates while Chrome is unfocused', () => {
    collector.foreground(null, 1200);
    const viewed = collector.state.candidates[0];
    collector.navigate(1, 'background-redirect', 'redirect', 'new', 2000);
    collector.foreground(2, 3000);
    expect(viewed).toMatchObject({ activeDurationMs: 1200, tabSwitchCount: 1 });
    expect(behavior(1)).toMatchObject({ activeDurationMs: 0, tabSwitchCount: 0, behaviorVersion: 0 });
  });
  it('does not infer uninterrupted activity from matching foreground endpoints after recovery', () => {
    collector.status(1000);
    collector = new Collector(structuredClone(collector.state));
    // The worker can die before blur/return has been checkpointed; endpoints alone are insufficient.
    collector.reconcileForeground(1, 10000);
    expect(behavior(1)).toEqual({ activeDurationMs: 1000, tabSwitchCount: 0, behaviorVersion: 1 });
    collector.stop(11000);
    expect(behavior(1)).toEqual({ activeDurationMs: 2000, tabSwitchCount: 0, behaviorVersion: 2 });
  });
  it('settles the last interval on stop and freezes all final snapshots across late events', () => {
    collector.status(1000);
    collector.stop(1500);
    const final = collector.status(1500);
    expect(final.readyVisits[0]).toMatchObject({ activeDurationMs: 1500, tabSwitchCount: 0, behaviorVersion: 2 });
    collector.foreground(2, 5000);
    collector.leave(1, 'doc1', 6000);
    collector.removeTab(1, 7000);
    collector.stop(8000);
    expect(collector.status(9000)).toEqual(final);
  });
});

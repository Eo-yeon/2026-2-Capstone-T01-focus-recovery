import type { PageVisit } from '../src/shared/types';
import { SERVER_SESSION_ID } from './session-fixture';
export function pageVisit(sequence = 1): PageVisit {
  return { visitId: crypto.randomUUID(), sessionId: SERVER_SESSION_ID, sequence, browserTabKey: crypto.randomUUID(),
    normalizedUrl: `https://example.com/docs/${sequence}`, domain: 'example.com', title: '공개 테스트 문서', content: '공개 합성 본문입니다. '.repeat(10),
    searchQuery: null, isSearchResultPage: false, visitedAt: '2026-10-18T01:23:45.678Z', activeDurationMs: 1500, tabSwitchCount: 0, behaviorVersion: 1 };
}

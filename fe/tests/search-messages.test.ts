import { describe, expect, it } from 'vitest';
import { isContentMessage } from '../src/shared/messages';
const snapshot = { normalizedUrl: 'https://www.google.com/search', domain: 'www.google.com', identity: 'a'.repeat(64), title: '검색', content: '검색어: JWT\n\n검색 결과 1\n제목: 인증', isSearchResultPage: true, searchQuery: 'JWT', organicResultCount: 1 };
const message = (fields = {}) => ({ type: 'snapshot', sessionId: 'session', snapshot: { ...snapshot, ...fields } });
describe('search message boundary', () => {
  it('accepts a bounded verified search snapshot', () => expect(isContentMessage(message())).toBe(true));
  it.each([null, undefined, '', '   ', 123, 'x'.repeat(501), 'JWT\nsecret'])('rejects invalid searchQuery: %s', searchQuery => expect(isContentMessage(message({ searchQuery }))).toBe(false));
  it.each([undefined, 0, -1, 1.5, 101, '1'])('rejects invalid organic result evidence: %s', organicResultCount => expect(isContentMessage(message({ organicResultCount }))).toBe(false));
  it.each([{ normalizedUrl: 'https://bing.com/search', domain: 'bing.com' }, { isSearchResultPage: false }, { domain: 'evil.example' }, { normalizedUrl: 'https://www.google.com/search?q=PRIVATE' }, { content: '' }])('rejects inconsistent search snapshot: %s', fields => expect(isContentMessage(message(fields))).toBe(false));
});

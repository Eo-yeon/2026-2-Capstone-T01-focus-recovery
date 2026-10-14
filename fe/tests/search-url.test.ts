import { describe, expect, it } from 'vitest';
import { describeUrl, inspectUrl, MAX_SEARCH_QUERY } from '../src/shared/url';

describe('search URL extraction', () => {
  it.each([
    ['https://www.google.com/search?q=Spring+Boot+JWT', 'Spring Boot JWT'],
    ['https://search.naver.com/search.naver?query=Spring+Boot+JWT', 'Spring Boot JWT'],
    ['https://www.google.co.kr/search?q=%ED%95%9C%EA%B8%80+%EC%9D%B8%EC%A6%9D', '한글 인증'],
    ['https://m.search.naver.com/search.naver?query=C%2B%2B%20%ED%95%9C%EA%B8%80&other=ignored#private', 'C++ 한글'],
    ['https://www.google.com/search?q=%20%20Spring%09Boot%20', 'Spring Boot'],
  ])('extracts only the decoded engine parameter from %s', async (raw, query) => {
    const result = await describeUrl(raw);
    expect(result?.searchQuery).toBe(query);
    expect(result?.isSearchResultPage).toBe(true);
    expect(result?.normalizedUrl).not.toMatch(/[?#]/);
    expect(JSON.stringify(result)).not.toContain('other=ignored');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each(['https://www.google.com/search', 'https://www.google.com/search?q=+++', 'https://search.naver.com/search.naver?query=', 'https://www.google.com/search?q=a&q=b', `https://www.google.com/search?q=${'x'.repeat(MAX_SEARCH_QUERY + 1)}`, 'https://www.google.com/search?q=%00'])('does not invent or truncate invalid queries: %s', raw => {
    expect(inspectUrl(raw)).toMatchObject({ isSearchResultPage: true, searchQuery: null });
  });
  it.each(['https://bing.com/search?q=test', 'https://example.com/search?q=test', 'https://www.google.com/maps?q=test', 'https://google.com.example.com/search?q=test', 'https://search.naver.com/other/search.naver?query=test'])('does not treat unsupported searches as supported search pages: %s', raw => {
    expect(inspectUrl(raw)).toMatchObject({ isSearchResultPage: false, searchQuery: null });
  });
  it.each(['https://www.google.com/search?q=test&access_token=private', 'https://search.naver.com/search.naver?query=test&email=private', 'https://user:password@www.google.com/search?q=test', 'https://www.google.com/search?q=test#id_token=private'])('applies sensitive URL policy before search extraction: %s', raw => expect(inspectUrl(raw)).toBeNull());
});

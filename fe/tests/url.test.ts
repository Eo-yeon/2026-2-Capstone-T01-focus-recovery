import { describeUrl, inspectUrl, normalizeUrl } from '../src/shared/url';
import { describe, expect, it } from 'vitest';
describe('URL policy', () => {
  it('normalizes scheme, host, default port, query and fragment while preserving path case', () => {
    expect(normalizeUrl('https://Example.com:443/docs/JWT?ref=home#intro')).toBe('https://example.com/docs/JWT');
    expect(normalizeUrl('http://Example.com:80/a%2Fb//C/')).toBe('http://example.com/a%2Fb//C/');
    expect(normalizeUrl('https://example.com:8443/A')).toBe('https://example.com:8443/A');
  });
  it.each(['chrome://newtab', 'chrome-extension://id/x', 'file:///x', 'data:text/html,x', 'blob:https://x/id', 'javascript:alert(1)', 'https://user:pass@example.com/docs', 'not a url'])('rejects %s', raw => expect(normalizeUrl(raw)).toBeNull());
  it.each(['/login', '/signup', '/password/reset', '/oauth/callback', '/payment', '/account', '/wallet', '/file.pdf', '/clip.mp4', '/%6cogin', '/bad%'])('excludes sensitive and non-HTML paths: %s', path => expect(normalizeUrl(`https://example.com${path}`)).toBeNull());
  it.each(['?access_token=secret', '?code=secret', '?email=private', '#id_token=secret'])('rejects sensitive URL fields %s', suffix => expect(normalizeUrl(`https://example.com/docs${suffix}`)).toBeNull());
  it('retains query distinction as a hash without storing raw query', async () => {
    const a = await describeUrl('https://example.com/post?id=100#top');
    const b = await describeUrl('https://example.com/post?id=200');
    expect(a?.normalizedUrl).toBe(b?.normalizedUrl);
    expect(a?.identity).not.toBe(b?.identity);
    expect(a?.identity).toBe((await describeUrl('https://example.com/post?id=100#other'))?.identity);
    expect(JSON.stringify(a)).not.toContain('id=100');
  });
  it.each(['https://www.google.com/search?q=test', 'https://www.google.co.kr/search', 'https://search.naver.com/search.naver?query=test', 'https://m.search.naver.com/search.naver'])('recognizes search even without a query: %s', raw => expect(inspectUrl(raw)?.isSearchResultPage).toBe(true));
  it('does not recognize deceptive search hosts', () => expect(inspectUrl('https://google.com.example.com/search?q=test')?.isSearchResultPage).toBe(false));
  it.each(['https://www.youtube.com/watch?v=id', 'https://open.spotify.com/episode/id'])('excludes media services: %s', raw => expect(normalizeUrl(raw)).toBeNull());
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { extractSearchContent } from '../src/content/search';
import { inspectUrl, normalizeUrl } from '../src/shared/url';

const fixture = readFileSync('tests/fixtures/naver-20261019.html', 'utf8');
const url = 'https://search.naver.com/search.naver?query=JWT';
beforeEach(() => { document.documentElement.innerHTML = fixture; });
function card(title = '공개 인증 문서', description = '공개 검색 설명입니다.', target = 'https://example.com/docs') {
  return document.querySelector('.fds-web-normal-doc-root')!.outerHTML
    .replaceAll('공개 인증 문서', title).replaceAll('공개 검색 설명입니다.', description).replaceAll('https://example.com/docs', target);
}
function render(cards: string) {
  document.body.innerHTML = `<div id="main_pack"><div class="fds-web-root"><div class="fds-web-list-root">${cards}</div></div></div>`;
}
describe('observed Naver ordinary web result cards (#60)', () => {
  it.each(['Spring Boot JWT', '스프링 부트 인증'])('collects ordinary web results for %s', query => {
    const raw = `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}&where=nexearch#results`;
    expect(inspectUrl(raw)).toMatchObject({ searchQuery: query, isSearchResultPage: true });
    expect(normalizeUrl(raw)).toBe('https://search.naver.com/search.naver');
    expect(extractSearchContent(document, raw)).toEqual({
      content: `검색어: ${query}\n\n검색 결과 1\n제목: 공개 인증 문서\n설명: 공개 검색 설명입니다.`,
      organicResultCount: 1,
    });
  });
  it('pairs distinct sibling cards with only their own title and description', () => {
    render(card('인증 문서', '토큰 설명', 'https://example.com/security-guide') + card('우주 문서', '행성 설명', 'https://example.com/space'));
    expect(extractSearchContent(document, url)).toEqual({
      content: '검색어: JWT\n\n검색 결과 1\n제목: 인증 문서\n설명: 토큰 설명\n\n검색 결과 2\n제목: 우주 문서\n설명: 행성 설명', organicResultCount: 2,
    });
  });
  it.each(['ai-briefing/sample', 'aipick/sample', 'related/sample', 'recommend/sample', 'account/sample', 'ad/sample'])('excludes a normal-looking card in a non-web section: %s', block => {
    const html = card('PRIVATE_SECTION');
    render(`<section data-block-id="${block}"><div data-block-id="">${html}</div></section>`);
    expect(extractSearchContent(document, url)).toBeNull();
  });
  it.each(['data-ad', 'data-text-ad', 'data-sponsored', 'aria-label="Sponsored"'])('excludes marked sponsor cards: %s', attribute => {
    render(card('PRIVATE_AD').replace('class="fds-web-doc-root', `${attribute} class="fds-web-doc-root`) + card());
    expect(extractSearchContent(document, url)?.organicResultCount).toBe(1);
    expect(extractSearchContent(document, url)?.content).not.toContain('PRIVATE_AD');
  });
  it('excludes sponsor labels, AI pick templates, navigation and unrelated common UI', () => {
    const html = card('PRIVATE_UI');
    render(`<nav>${html}</nav><header>${html}</header><div data-template-id="aipickItem">${html}</div>${html.replace('공개 검색 설명입니다.', '<span>광고</span>')}`);
    expect(extractSearchContent(document, url)).toBeNull();
  });
  it('requires web/list/normal-card boundaries rather than a headline alone', () => {
    document.body.innerHTML = fixture.replaceAll('fds-web-normal-doc-root', 'fds-web-recommend-doc-root');
    expect(extractSearchContent(document, url)).toBeNull();
    document.body.innerHTML = fixture.replaceAll('fds-web-list-root', 'unknown-list');
    expect(extractSearchContent(document, url)).toBeNull();
    document.body.innerHTML = fixture.replaceAll('fds-web-root', 'unknown-root');
    expect(extractSearchContent(document, url)).toBeNull();
  });
  it.each(['https://adcr.naver.com/ad', 'https://ader.naver.com/ad', 'https://ads.naver.com/ad', 'https://search.naver.com/search.naver?query=other', 'javascript:alert(1)'])('excludes advertising/search/unsafe title destinations: %s', target => {
    render(card('PRIVATE_LINK', 'PRIVATE_DESCRIPTION', target));
    expect(extractSearchContent(document, url)).toBeNull();
  });
  it('does not borrow a description from a different destination or another card', () => {
    document.querySelector('.sds-comps-text-type-body1')!.closest('a')!.setAttribute('href', 'https://example.com/other');
    const result = extractSearchContent(document, url)!;
    expect(result.organicResultCount).toBe(1);
    expect(result.content).not.toContain('설명:');
  });
  it('rejects ambiguous multi-title and multi-description cards instead of mixing results', () => {
    const heading = document.querySelector('.sds-comps-text-type-headline1')!.closest('a')!.outerHTML;
    const snippet = document.querySelector('.sds-comps-text-type-body1')!.closest('a')!.outerHTML;
    const html = card();
    render(html.replace('</div>', `${heading}</div>`));
    expect(extractSearchContent(document, url)).toBeNull();
    render(html.replace('</div>', `${snippet}</div>`));
    expect(extractSearchContent(document, url)).toBeNull();
  });
  it('deduplicates nested legacy and modern boundaries without dropping sibling results', () => {
    const html = card('인증 문서', '설명 A') + card('우주 문서', '설명 B', 'https://example.com/space');
    render(html);
    document.querySelector('.fds-web-root')!.setAttribute('data-block-id', 'web/sample');
    expect(extractSearchContent(document, url)?.organicResultCount).toBe(2);
  });
  it('reads the changed query and replacement DOM instead of caching the previous result', () => {
    expect(extractSearchContent(document, url)?.content).toContain('검색어: JWT');
    render(card('우주 문서', '행성 설명', 'https://example.com/space'));
    const changed = extractSearchContent(document, 'https://search.naver.com/search.naver?query=우주')!;
    expect(changed.content).toBe('검색어: 우주\n\n검색 결과 1\n제목: 우주 문서\n설명: 행성 설명');
    render('');
    expect(extractSearchContent(document, url)).toBeNull();
  });
  it('retains the shared 5,000-code-point limit for new Naver cards', () => {
    render(card('공개 문서', '한😀'.repeat(4000)));
    const result = extractSearchContent(document, url)!;
    expect([...result.content]).toHaveLength(5000);
    expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(result.organicResultCount).toBe(1);
  });
});

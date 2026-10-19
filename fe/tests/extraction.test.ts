// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanText, extractMainContent, isExcludedDocument } from '../src/content/extraction';
beforeEach(() => { document.title = '공개 문서'; document.body.innerHTML = ''; });
describe('main content extraction', () => {
  it('preserves Korean, English and code symbols while omitting clutter and input values', () => {
    document.body.innerHTML = `<nav>MENU</nav><article><h1>JWT 기술 문서</h1><p>한국어 English <code>if (a &lt; b) { x += 1; }</code></p><script>SECRET_SCRIPT</script><style>.SECRET_STYLE{}</style><div class="ad">ADVERTISEMENT</div><aside>RELATED</aside><footer>FOOTER</footer><div hidden>HIDDEN</div><div style="display:none">CSS_HIDDEN</div><div style="visibility:hidden">INVISIBLE</div><div style="opacity:0">TRANSPARENT</div><input value="PRIVATE_INPUT"><textarea>PRIVATE_TEXTAREA</textarea><select><option>PRIVATE_OPTION</option></select></article>`;
    expect(extractMainContent(document)).toBe('JWT 기술 문서\n한국어 English if (a < b) { x += 1; }');
  });
  it('ignores a root with hidden ancestors', () => {
    document.body.innerHTML = '<div style="display:none"><article>HIDDEN</article></div>';
    expect(extractMainContent(document)).toBeNull();
  });
  it('uses a coherent fallback section, never entire body', () => {
    document.body.innerHTML = '<div>GLOBAL TEXT</div><section><p>paragraph one</p><p>paragraph two</p></section>';
    expect(extractMainContent(document)).toBe('paragraph one\nparagraph two');
    document.body.innerHTML = '<div>UNKNOWN LAYOUT</div>';
    expect(extractMainContent(document)).toBeNull();
  });
  it('limits Unicode code points to 5,000 without splitting surrogate pairs', () => {
    document.body.innerHTML = `<article>${'한🙂'.repeat(3000)}</article>`;
    const result = extractMainContent(document)!;
    expect([...result]).toHaveLength(5000);
    expect(result.endsWith('🙂')).toBe(true);
  });
  it.each([
    ['가'.repeat(5000), '가'.repeat(5000)],
    ['a'.repeat(5000), 'a'.repeat(5000)],
    ['😀'.repeat(2500), '😀'.repeat(2500)],
    ['😀'.repeat(2501), '😀'.repeat(2501)],
    ['😀'.repeat(5000), '😀'.repeat(5000)],
    ['😀'.repeat(5001), '😀'.repeat(5000)],
    ['한a😀𐐀'.repeat(1250), '한a😀𐐀'.repeat(1250)],
    ['a'.repeat(4999) + '😀𐐀', 'a'.repeat(4999) + '😀'],
  ])('preserves the exact Unicode prefix at boundary case %#', (content, expected) => {
    document.body.innerHTML = `<article>${content}</article>`;
    const result = extractMainContent(document)!;
    expect(result).toBe(expected);
    expect([...result].length).toBeLessThanOrEqual(5000);
  });
  it.each(['<form><input value="secret"></form>', '<input type="password" value="secret" hidden>', '<input type="email" value="secret">', '<input autocomplete="cc-number" value="secret">', '<input name="token" value="secret">', '<div contenteditable="true">private</div>'])('fails closed on sensitive or form-centered documents: %s', element => {
    document.body.innerHTML = `<article>${'public '.repeat(30)}</article>${element}`;
    expect(isExcludedDocument(document)).toBe(true);
    expect(extractMainContent(document)).toBeNull();
  });
  it('excludes error pages and non-HTML documents', () => {
    document.title = '404 Page not found';
    expect(isExcludedDocument(document)).toBe(true);
    const xml = new DOMParser().parseFromString('<root>content</root>', 'application/xml');
    expect(isExcludedDocument(xml)).toBe(true);
  });
  it('excludes error headings even under an ordinary page title', () => {
    document.body.innerHTML = `<main><h1>Page not found</h1><p>${'body '.repeat(20)}</p></main>`;
    expect(extractMainContent(document)).toBeNull();
  });
  it('normalizes whitespace without removing meaningful symbols', () => expect(cleanText(' A\t B\n\n한글\r\n x => y; ')).toBe('A B\n한글\nx => y;'));
});

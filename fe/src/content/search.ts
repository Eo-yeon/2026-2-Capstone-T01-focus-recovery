import { inspectUrl, normalizeUrl, searchEngine } from '../shared/url';
import { cleanText, isExcludedDocument, isVisible, textFrom } from './extraction';

const UNSAFE = 'form,input,textarea,select,[contenteditable],nav,header,footer,aside,[role="navigation"],[role="menu"],[role="dialog"],[data-ad],[data-text-ad],[data-sponsored],.ad,.ads,.advertisement,#tads,#tadsb,#bottomads,.commercial-unit-desktop-top,.ad_section,#power_link,[data-block-id^="ad/"]';
const AD_LABEL = /^(?:광고|스폰서|스폰서 제공|sponsored|ads?|advertisement|promoted)$/i;
function safe(element: Element): boolean {
  return !element.closest(UNSAFE) && isVisible(element);
}
function organic(container: Element): boolean {
  if (!safe(container) || container.querySelector('form,input[type="password"],[contenteditable]')) return false;
  // Inspect labels, never the whole result text: an article about ads is still organic.
  const scope = container.closest('.MjjYud,[data-block-id]') ?? container;
  return ![scope, ...scope.querySelectorAll('span,button,[aria-label]')].some(label => isVisible(label) && (AD_LABEL.test(cleanText(label.textContent ?? '')) || AD_LABEL.test(label.getAttribute('aria-label') ?? '')));
}
function result(container: Element, titleElement: Element | null, snippetElement: Element | null, base: URL) {
  if (!titleElement || !organic(container) || !safe(titleElement)) return null;
  const link = titleElement.closest('a[href]');
  if (!link || !container.contains(link)) return null;
  let target: string | null;
  try { target = normalizeUrl(new URL(link.getAttribute('href')!, base).href); }
  catch { return null; }
  if (!target || searchEngine(new URL(target)) || /(?:^|\.)(?:googleadservices\.com|doubleclick\.net|adcr\.naver\.com|ads\.naver\.com)$/.test(new URL(target).hostname)) return null;
  const title = cleanText(textFrom(titleElement));
  if (!title) return null;
  const description = snippetElement && safe(snippetElement) ? cleanText(textFrom(snippetElement)) : '';
  return { title, description };
}
function googleResults(doc: Document, base: URL) {
  // shortcut: Google live DOM was blocked during verification; validate these conservative structures manually before broadening support.
  const titles = new Set<Element>();
  return [...doc.querySelectorAll('#search #rso .MjjYud, #search #rso .g')].flatMap(container => {
    const title = container.querySelector('a[href] h3');
    if (!title || titles.has(title)) return [];
    titles.add(title);
    const entry = result(container, title, container.querySelector('[data-sncf],.VwiC3b,.IsZvec'), base);
    return entry ? [entry] : [];
  });
}
function naverResults(doc: Document, base: URL) {
  // Live desktop sample (2026-10-14): web blocks and searchBasic UGC cards.
  return [...doc.querySelectorAll('#main_pack [data-block-id^="web/"], #main_pack [data-template-id="ugcItem"][data-template-type="searchBasic"]')].flatMap(container => {
    const title = container.querySelector('a[href] [class*="sds-comps-text-type-headline"]');
    const description = [...container.querySelectorAll('a[href] [class~="sds-comps-text-type-body1"]')].find(element => !element.closest('[data-template-id="reply"],[data-template-id="articleSource"]')) ?? null;
    const entry = result(container, title, description, base);
    return entry ? [entry] : [];
  });
}
export function extractSearchContent(doc: Document, raw: string): { content: string; organicResultCount: number } | null {
  const inspected = inspectUrl(raw);
  if (!inspected?.isSearchResultPage || !inspected.searchQuery || isExcludedDocument(doc, inspected.url)) return null;
  const entries = searchEngine(inspected.url) === 'google' ? googleResults(doc, inspected.url) : naverResults(doc, inspected.url);
  const seen = new Set<string>();
  const blocks: string[] = [];
  let length = [...`검색어: ${inspected.searchQuery}`].length;
  for (const entry of entries) {
    const key = `${entry.title}\n${entry.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const heading = `\n\n검색 결과 ${blocks.length + 1}\n제목: ${entry.title}`;
    // A result must retain its complete title; never count one beyond the content bound.
    if (length + [...heading].length > 5000) break;
    const block = [...`${heading}${entry.description ? `\n설명: ${entry.description}` : ''}`].slice(0, 5000 - length).join('');
    blocks.push(block);
    length += [...block].length;
    if (blocks.length === 100 || length === 5000) break;
  }
  return blocks.length ? { content: `검색어: ${inspected.searchQuery}${blocks.join('')}`, organicResultCount: blocks.length } : null;
}

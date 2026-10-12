const OMIT = 'script,style,noscript,nav,header,footer,aside,form,input,textarea,select,button,option,iframe,canvas,svg,video,audio,[contenteditable],[hidden],[inert],[aria-hidden="true"],[role="navigation"],[role="menu"],[role="dialog"],[role="alert"],[role="banner"],[role="contentinfo"],[role="complementary"],.ad,.ads,.advertisement,[data-ad],[id*="google_ads"],.comments,.comment-list,.social-share,.menu,.navigation,.navbar,.sidebar,.cookie-banner,.sr-only';
const PRIVATE_INPUT = 'input[type="password"],input[type="email"],input[type="tel"],input[autocomplete^="cc-"],input[autocomplete="street-address"],input[autocomplete="one-time-code"],input[autocomplete="given-name"],input[autocomplete="family-name"],input[name*="password" i],input[name*="token" i],input[name*="ssn" i],input[name*="card" i]';
export function isVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView!.getComputedStyle(current);
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
  }
  return true;
}
export function isExcludedDocument(doc: Document): boolean {
  if (doc.contentType !== 'text/html') return true;
  // Even hidden auth inputs indicate an unsafe document. Never inspect their values.
  if (doc.querySelector(PRIVATE_INPUT)) return true;
  if ([...doc.querySelectorAll('form,[contenteditable="true"],[role="textbox"]')].some(isVisible)) return true;
  const errorHeading = /^(?:error|404|403|500|access denied|page not found|not found|오류|접근 거부|페이지를 찾을 수)/i;
  if (errorHeading.test(doc.title.trim()) || [...doc.querySelectorAll('h1')].some(heading => isVisible(heading) && errorHeading.test(heading.textContent?.trim() ?? ''))) return true;
  return false;
}
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[\t\u00a0 ]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}
function textFrom(element: Element): string {
  if (element.matches(OMIT) || !isVisible(element)) return '';
  const pieces: string[] = [];
  for (const node of element.childNodes) {
    if (node.nodeType === 3) pieces.push(node.textContent ?? '');
    else if (node.nodeType === 1) {
      const child = node as Element;
      const text = textFrom(child);
      const block = /^(P|DIV|SECTION|ARTICLE|MAIN|H[1-6]|LI|PRE|BR|TR)$/.test(child.tagName);
      pieces.push(block ? `\n${text}\n` : text);
    }
  }
  return pieces.join('');
}
export function extractMainContent(doc: Document): string | null {
  if (isExcludedDocument(doc)) return null;
  const explicit = [...doc.querySelectorAll('article,main,[role="main"],.post-content,.entry-content,.article-body')];
  // Unknown layouts fail closed; only a coherent section can serve as fallback.
  const roots = explicit.length ? explicit : [...doc.querySelectorAll('section')].filter(el => el.querySelectorAll('p,pre').length >= 2);
  const texts = roots.map(textFrom).map(cleanText).filter(Boolean);
  if (!texts.length) return null;
  return [...texts.sort((a, b) => b.length - a.length)[0]].slice(0, 5000).join('');
}

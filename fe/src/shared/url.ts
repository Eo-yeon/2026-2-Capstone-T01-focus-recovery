const sensitivePath = /(?:^|[\/_.-])(login|logon|signin|sign-in|signup|sign-up|register|registration|password|reset-password|auth|oauth|callback|sso|checkout|payment|billing|banking|bank|wallet|account|profile|settings|myaccount|finance|financial|pay|verify|verification)(?:[\/_.-]|$)/i;
const sensitiveQuery = /^(?:.*token.*|code|password|passwd|secret|authorization|credential|session|sessionid|sid|email|phone|address|ssn|card.*)$/i;
const sensitiveHost = /(?:^|[.-])(bank|banking|paypal|stripe|accounts|login|auth|finance|wallet)(?:[.-]|$)/i;

// Only this transient stage sees query parameters. FE-007 can inspect q/query here.
export function inspectUrl(raw: string): { url: URL; isSearchResultPage: boolean } | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const path = decodeURIComponent(url.pathname);
    if (sensitivePath.test(path) || sensitiveHost.test(url.hostname) || /\.(pdf|mp4|webm|mp3|wav|ogg|m4a)$/i.test(path)) return null;
    if ([...url.searchParams.keys()].some(key => sensitiveQuery.test(key))) return null;
    if (/^(?:www\.|m\.)?(?:youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|soundcloud\.com|open\.spotify\.com)$/i.test(url.hostname)) return null;
    // Catch token-style fragments before discarding them.
    if (/(?:access_token|id_token|password|authorization|code)=/i.test(url.hash)) return null;
    const google = /^(?:www\.)?google\.(?:com|co\.kr|co\.uk|co\.jp|[a-z]{2})$/i.test(url.hostname) && url.pathname === '/search';
    const naver = /^(?:search|m\.search)\.naver\.com$/i.test(url.hostname) && /\/search\.naver$/.test(url.pathname);
    return { url, isSearchResultPage: google || naver };
  } catch { return null; }
}
export function normalizeUrl(raw: string): string | null {
  const inspected = inspectUrl(raw);
  if (!inspected) return null;
  const { url } = inspected;
  url.search = '';
  url.hash = '';
  return url.href;
}
export async function describeUrl(raw: string) {
  const inspected = inspectUrl(raw);
  if (!inspected) return null;
  const { url, isSearchResultPage } = inspected;
  url.hash = '';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
  const identity = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { normalizedUrl: normalizeUrl(raw)!, domain: url.hostname, identity, isSearchResultPage };
}

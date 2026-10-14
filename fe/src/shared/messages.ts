import type { ContentMessage, PopupMessage } from './types';
const reasons = new Set(['url-policy', 'dom-policy', 'search-pending', 'short-content', 'short-duration', 'unavailable-content']);
export function isContentMessage(value: unknown): value is ContentMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'context') return true;
  if (typeof v.sessionId !== 'string' || v.sessionId.length > 100) return false;
  if (v.type === 'leave') return true;
  if (v.type !== 'snapshot' || (v.reason !== undefined && !reasons.has(v.reason as string))) return false;
  if (v.snapshot === null) return true;
  if (!v.snapshot || typeof v.snapshot !== 'object') return false;
  const s = v.snapshot as Record<string, unknown>;
  return typeof s.normalizedUrl === 'string' && s.normalizedUrl.length <= 8192 && typeof s.domain === 'string' && s.domain.length <= 253 && typeof s.identity === 'string' && /^[a-f0-9]{64}$/.test(s.identity) && typeof s.title === 'string' && [...s.title].length <= 500 && typeof s.content === 'string' && [...s.content].length <= 5000 && typeof s.isSearchResultPage === 'boolean';
}
export function isPopupMessage(value: unknown): value is PopupMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['status', 'stop', 'clear', 'sync-permissions'].includes(v.type as string) || (v.type === 'start' && typeof v.goalText === 'string' && v.goalText.length <= 150);
}

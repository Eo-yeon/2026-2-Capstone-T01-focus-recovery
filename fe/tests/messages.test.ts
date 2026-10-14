import { describe, expect, it } from 'vitest';
import { isContentMessage, isPopupMessage } from '../src/shared/messages';
describe('message boundary', () => {
  it('accepts only supported typed commands', () => {
    expect(isPopupMessage({ type: 'start', goalText: '공개 문서 찾기' })).toBe(true);
    expect(isPopupMessage({ type: 'start', goalText: 123 })).toBe(false);
    expect(isPopupMessage({ type: 'start', goalText: 'x'.repeat(151) })).toBe(false);
    expect(isContentMessage({ type: 'context' })).toBe(true);
    expect(isContentMessage({ type: 'snapshot', sessionId: 'local', snapshot: null, reason: 'dom-policy' })).toBe(true);
    expect(isContentMessage({ type: 'snapshot', sessionId: 'local', snapshot: null, reason: 'unknown' })).toBe(false);
    expect(isContentMessage({ type: 'start', goalText: '공개 문서 찾기' })).toBe(false);
  });
  it('rejects malformed/oversized payloads', () => {
    const snapshot = { normalizedUrl: 'https://example.com/', domain: 'example.com', identity: 'a'.repeat(64), title: '문서', content: 'x'.repeat(50), isSearchResultPage: false };
    const message = { type: 'snapshot', sessionId: 'local', snapshot };
    expect(isContentMessage(message)).toBe(true);
    expect(isContentMessage({ ...message, snapshot: { ...snapshot, content: 'x'.repeat(5001) } })).toBe(false);
    expect(isContentMessage({ ...message, snapshot: { ...snapshot, title: 'x'.repeat(501) } })).toBe(false);
    expect(isContentMessage({ ...message, snapshot: { ...snapshot, identity: 'raw-url' } })).toBe(false);
    expect(isContentMessage({ ...message, snapshot: { ...snapshot, isSearchResultPage: undefined } })).toBe(false);
  });
});

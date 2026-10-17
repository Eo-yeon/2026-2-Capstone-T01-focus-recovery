import type { WorkSessionResponse } from '../src/api/types';
import { normalizeGoal } from '../src/shared/goal';
export const SERVER_SESSION_ID = '1ba72f77-c166-4e06-88c7-1d6ed919cd9b';
export function serverSession(goalText = '공개 문서 조사하기', now = 0): WorkSessionResponse {
  return { sessionId: crypto.randomUUID(), goalText: normalizeGoal(goalText), startedAt: new Date(now).toISOString(), status: 'ACTIVE', endedAt: null };
}

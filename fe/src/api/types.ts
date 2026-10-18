export interface CreateWorkSessionRequest { goalText: string }
export interface WorkSessionResponse {
  sessionId: string;
  goalText: string;
  startedAt: string;
  status: 'ACTIVE' | 'ENDED';
  endedAt: string | null;
}

export type CreatePageVisitRequest = Omit<import('../shared/types').PageVisit, 'sessionId'>;
export type PageVisitResponse = import('../shared/types').PageVisit & { updatedAt: string | null };

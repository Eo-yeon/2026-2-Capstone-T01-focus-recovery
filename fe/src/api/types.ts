export interface CreateWorkSessionRequest { goalText: string }
export interface WorkSessionResponse {
  sessionId: string;
  goalText: string;
  startedAt: string;
  status: 'ACTIVE' | 'ENDED';
  endedAt: string | null;
}

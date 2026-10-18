export const MAX_DELIVERY_ATTEMPTS = 3;

export function stopExhaustedDelivery(entry: {
  attempts: number; phase: string; error?: string; retryable?: boolean; nextRetryAt?: number;
}): boolean {
  if (entry.attempts < MAX_DELIVERY_ATTEMPTS) return false;
  entry.phase = 'failed';
  entry.retryable = true;
  entry.error = '자동 전송 시도 3회를 소진했습니다. 마지막 요청은 서버에 반영되었을 수 있습니다. 같은 요청을 명시적으로 재시도하거나 서버 상태를 확인해 주세요.';
  delete entry.nextRetryAt;
  return true;
}

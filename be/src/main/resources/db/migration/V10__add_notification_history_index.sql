-- 알림 이력 조회(session_id 조건, created_at DESC·alert_id DESC 정렬)를 인덱스 순서로 읽어 정렬(filesort) 없이 페이지를 자른다.
-- uq_notification_session_scheduled(session_id, scheduled_at)는 고정 주기 회차 중복 방지용이라 함께 유지한다
CREATE INDEX idx_notification_session_created ON notification (session_id, created_at DESC, alert_id DESC);

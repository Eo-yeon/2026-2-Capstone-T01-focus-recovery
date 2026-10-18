-- 고정 주기 후보의 예정 회차 시각(startedAt + interval × n). 실제 생성 시각(created_at)·표시 시각(shown_at)과 구분한다.
-- 같은 세션·같은 회차 후보는 하나(AI 후보와 V8 이전 고정 주기 후보는 NULL이라 제약에서 제외된다)
ALTER TABLE notification ADD COLUMN scheduled_at DATETIME(3) NULL;
ALTER TABLE notification ADD CONSTRAINT uq_notification_session_scheduled UNIQUE (session_id, scheduled_at);

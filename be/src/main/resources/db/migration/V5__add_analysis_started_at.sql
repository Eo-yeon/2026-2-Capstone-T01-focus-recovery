-- RUNNING 전환 시각: 미완료 분석 복구에서 RUNNING의 경과 시간을 재는 기준(PENDING은 requested_at 기준)
ALTER TABLE analysis_result ADD COLUMN started_at DATETIME(3) NULL;

-- COMPLETED·DRIFT 분석마다 AI 알림 후보 처리 작업 하나. 분석 결과 저장과 같은 트랜잭션에서 만들어 누락을 막는다
CREATE TABLE alert_candidate_task (
    analysis_id     CHAR(36)     NOT NULL,
    session_id      CHAR(36)     NOT NULL,
    status          VARCHAR(20)  NOT NULL,
    skip_reason     VARCHAR(50)  NULL,
    error_code      VARCHAR(100) NULL,
    attempts        INT          NOT NULL,
    alert_id        CHAR(36)     NULL,
    created_at      DATETIME(3)  NOT NULL,
    next_attempt_at DATETIME(3)  NOT NULL,
    started_at      DATETIME(3)  NULL,
    completed_at    DATETIME(3)  NULL,
    PRIMARY KEY (analysis_id),
    CONSTRAINT fk_alert_candidate_task_analysis FOREIGN KEY (analysis_id) REFERENCES analysis_result (analysis_id),
    CONSTRAINT fk_alert_candidate_task_session FOREIGN KEY (session_id) REFERENCES work_session (session_id),
    CONSTRAINT fk_alert_candidate_task_alert FOREIGN KEY (alert_id) REFERENCES notification (alert_id)
);

CREATE INDEX idx_alert_candidate_task_due ON alert_candidate_task (status, next_attempt_at);

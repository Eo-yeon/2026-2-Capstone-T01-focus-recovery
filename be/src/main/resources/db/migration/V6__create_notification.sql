CREATE TABLE notification (
    alert_id    CHAR(36)    NOT NULL,
    session_id  CHAR(36)    NOT NULL,
    analysis_id CHAR(36)    NULL,
    alert_type  VARCHAR(30) NOT NULL,
    message     TEXT        NOT NULL,
    created_at  DATETIME(3) NOT NULL,
    shown_at    DATETIME(3) NULL,
    PRIMARY KEY (alert_id),
    -- ERD에 추가: 분석 하나에 AI 알림 후보는 하나(고정 주기 후보는 analysis_id가 NULL이라 제외된다)
    CONSTRAINT uq_notification_analysis UNIQUE (analysis_id),
    CONSTRAINT fk_notification_session FOREIGN KEY (session_id) REFERENCES work_session (session_id),
    CONSTRAINT fk_notification_analysis FOREIGN KEY (analysis_id) REFERENCES analysis_result (analysis_id)
);

-- 알림당 최초 사용자 선택 1개(uq_notification_response_alert). ERD의 notification_response 기준
CREATE TABLE notification_response (
    feedback_id CHAR(36)    NOT NULL,
    alert_id    CHAR(36)    NOT NULL,
    action      VARCHAR(30) NOT NULL,
    selected_at DATETIME(3) NOT NULL,
    PRIMARY KEY (feedback_id),
    CONSTRAINT uq_notification_response_alert UNIQUE (alert_id),
    CONSTRAINT fk_notification_response_alert FOREIGN KEY (alert_id) REFERENCES notification (alert_id)
);

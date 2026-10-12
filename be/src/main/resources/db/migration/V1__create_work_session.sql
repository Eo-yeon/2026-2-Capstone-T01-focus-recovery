-- 인덱스 이름은 기존 DB에 Hibernate가 생성한 이름을 그대로 사용한다
CREATE TABLE work_session (
    session_id      CHAR(36)                 NOT NULL,
    ended_at        DATETIME(3)              NULL,
    goal_text       TEXT                     NOT NULL,
    started_at      DATETIME(3)              NOT NULL,
    status          ENUM('ACTIVE', 'ENDED')  NOT NULL,
    idempotency_key VARCHAR(255)             NULL,
    PRIMARY KEY (session_id),
    CONSTRAINT UKeqk3gjvidox79xnbqdxg8hlrc UNIQUE (idempotency_key)
);

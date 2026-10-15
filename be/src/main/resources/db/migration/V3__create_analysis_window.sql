CREATE TABLE analysis_window (
    window_id      CHAR(36)    NOT NULL,
    session_id     CHAR(36)    NOT NULL,
    window_index   INT         NOT NULL,
    window_size    INT         NOT NULL DEFAULT 5,
    start_visit_id CHAR(36)    NOT NULL,
    end_visit_id   CHAR(36)    NOT NULL,
    created_at     DATETIME(3) NOT NULL,
    PRIMARY KEY (window_id),
    CONSTRAINT uk_analysis_window_session_index UNIQUE (session_id, window_index),
    CONSTRAINT uk_analysis_window_session_size_end UNIQUE (session_id, window_size, end_visit_id),
    CONSTRAINT fk_analysis_window_session FOREIGN KEY (session_id) REFERENCES work_session (session_id),
    CONSTRAINT fk_analysis_window_start_visit FOREIGN KEY (start_visit_id) REFERENCES page_visit (visit_id),
    CONSTRAINT fk_analysis_window_end_visit FOREIGN KEY (end_visit_id) REFERENCES page_visit (visit_id)
);

CREATE TABLE window_visit (
    window_id CHAR(36) NOT NULL,
    visit_id  CHAR(36) NOT NULL,
    position  INT      NOT NULL,
    PRIMARY KEY (window_id, visit_id),
    CONSTRAINT uk_window_visit_window_position UNIQUE (window_id, position),
    CONSTRAINT fk_window_visit_window FOREIGN KEY (window_id) REFERENCES analysis_window (window_id),
    CONSTRAINT fk_window_visit_visit FOREIGN KEY (visit_id) REFERENCES page_visit (visit_id)
);

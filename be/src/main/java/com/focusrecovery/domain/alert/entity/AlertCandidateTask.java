package com.focusrecovery.domain.alert.entity;

import java.time.Instant;
import java.util.UUID;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import org.springframework.data.domain.Persistable;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PostLoad;
import jakarta.persistence.PostPersist;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;

// AI 알림 후보 처리 작업. 분석 결과(analysis_result)는 바꾸지 않고 후보 처리 상태만 기록한다
@Entity
@Table(name = "alert_candidate_task")
public class AlertCandidateTask implements Persistable<UUID> {

	@Id
	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "analysis_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID analysisId;

	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "session_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID sessionId;

	@Enumerated(EnumType.STRING)
	@Column(name = "status", length = 20, nullable = false)
	private AlertTaskStatus status;

	@Column(name = "skip_reason", length = 50)
	private String skipReason;

	@Column(name = "error_code", length = 100)
	private String errorCode;

	@Column(name = "attempts", nullable = false)
	private int attempts;

	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "alert_id", columnDefinition = "CHAR(36)")
	private UUID alertId;

	@Column(name = "created_at", columnDefinition = "DATETIME(3)", nullable = false, updatable = false)
	private Instant createdAt;

	@Column(name = "next_attempt_at", columnDefinition = "DATETIME(3)", nullable = false)
	private Instant nextAttemptAt;

	@Column(name = "started_at", columnDefinition = "DATETIME(3)")
	private Instant startedAt;

	@Column(name = "completed_at", columnDefinition = "DATETIME(3)")
	private Instant completedAt;

	@Transient
	private boolean isNew = true;

	protected AlertCandidateTask() {
	}

	public static AlertCandidateTask pending(UUID analysisId, UUID sessionId, Instant now) {
		AlertCandidateTask task = new AlertCandidateTask();
		task.analysisId = analysisId;
		task.sessionId = sessionId;
		task.status = AlertTaskStatus.PENDING;
		task.createdAt = now;
		task.nextAttemptAt = now;
		return task;
	}

	public void start(Instant now) {
		status = AlertTaskStatus.RUNNING;
		attempts++;
		startedAt = now;
	}

	@PostLoad
	@PostPersist
	void markNotNew() {
		isNew = false;
	}

	@Override
	public UUID getId() {
		return analysisId;
	}

	@Override
	public boolean isNew() {
		return isNew;
	}

	public UUID getAnalysisId() {
		return analysisId;
	}

	public UUID getSessionId() {
		return sessionId;
	}

	public AlertTaskStatus getStatus() {
		return status;
	}

	public String getSkipReason() {
		return skipReason;
	}

	public String getErrorCode() {
		return errorCode;
	}

	public int getAttempts() {
		return attempts;
	}

	public UUID getAlertId() {
		return alertId;
	}

	public Instant getCreatedAt() {
		return createdAt;
	}

	public Instant getNextAttemptAt() {
		return nextAttemptAt;
	}

	public Instant getStartedAt() {
		return startedAt;
	}

	public Instant getCompletedAt() {
		return completedAt;
	}
}

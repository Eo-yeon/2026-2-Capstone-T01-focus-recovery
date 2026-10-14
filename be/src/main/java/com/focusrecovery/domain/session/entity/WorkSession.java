package com.focusrecovery.domain.session.entity;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "work_session")
public class WorkSession {

	@Id
	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "session_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID sessionId;

	@Column(name = "goal_text", columnDefinition = "TEXT", nullable = false)
	private String goalText;

	@Enumerated(EnumType.STRING)
	@Column(name = "status", length = 20, nullable = false)
	private WorkSessionStatus status;

	@Column(name = "started_at", columnDefinition = "DATETIME(3)", nullable = false, updatable = false)
	private Instant startedAt;

	@Column(name = "ended_at", columnDefinition = "DATETIME(3)")
	private Instant endedAt;

	@Column(name = "idempotency_key", unique = true, updatable = false)
	private String idempotencyKey;

	protected WorkSession() {
	}

	public static WorkSession start(String goalText, String idempotencyKey) {
		WorkSession session = new WorkSession();
		session.sessionId = UUID.randomUUID();
		session.goalText = goalText;
		session.idempotencyKey = idempotencyKey;
		session.status = WorkSessionStatus.ACTIVE;
		// DATETIME(3) 정밀도에 맞춰 저장 값과 응답 값을 일치시킨다
		session.startedAt = Instant.now().truncatedTo(ChronoUnit.MILLIS);
		return session;
	}

	// 이미 종료된 세션은 최초 종료 시각을 유지한다
	public void end(Instant endedAt) {
		if (status == WorkSessionStatus.ENDED) {
			return;
		}
		this.status = WorkSessionStatus.ENDED;
		this.endedAt = endedAt;
	}

	public UUID getSessionId() {
		return sessionId;
	}

	public String getGoalText() {
		return goalText;
	}

	public WorkSessionStatus getStatus() {
		return status;
	}

	public Instant getStartedAt() {
		return startedAt;
	}

	public Instant getEndedAt() {
		return endedAt;
	}

	public String getIdempotencyKey() {
		return idempotencyKey;
	}
}

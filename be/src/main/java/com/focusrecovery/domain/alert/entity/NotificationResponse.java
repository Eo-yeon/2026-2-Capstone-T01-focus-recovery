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

// 알림에 대한 사용자 최초 선택. 저장 후 변경하지 않는다
@Entity
@Table(name = "notification_response")
public class NotificationResponse implements Persistable<UUID> {

	@Id
	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "feedback_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID feedbackId;

	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "alert_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID alertId;

	@Enumerated(EnumType.STRING)
	@Column(name = "action", length = 30, nullable = false, updatable = false)
	private ResponseAction action;

	@Column(name = "selected_at", columnDefinition = "DATETIME(3)", nullable = false, updatable = false)
	private Instant selectedAt;

	@Transient
	private boolean isNew = true;

	protected NotificationResponse() {
	}

	public static NotificationResponse of(UUID alertId, ResponseAction action, Instant selectedAt) {
		NotificationResponse response = new NotificationResponse();
		response.feedbackId = UUID.randomUUID();
		response.alertId = alertId;
		response.action = action;
		response.selectedAt = selectedAt;
		return response;
	}

	public boolean isSameSelection(ResponseAction action, Instant selectedAt) {
		return this.action == action && this.selectedAt.equals(selectedAt);
	}

	@PostLoad
	@PostPersist
	void markNotNew() {
		isNew = false;
	}

	@Override
	public UUID getId() {
		return feedbackId;
	}

	@Override
	public boolean isNew() {
		return isNew;
	}

	public UUID getFeedbackId() {
		return feedbackId;
	}

	public UUID getAlertId() {
		return alertId;
	}

	public ResponseAction getAction() {
		return action;
	}

	public Instant getSelectedAt() {
		return selectedAt;
	}
}

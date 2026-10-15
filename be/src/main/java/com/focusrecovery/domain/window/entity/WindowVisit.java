package com.focusrecovery.domain.window.entity;

import java.util.UUID;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

@Embeddable
public record WindowVisit(
	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "visit_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	UUID visitId,

	@Column(name = "position", nullable = false, updatable = false)
	int position
) {
}

package com.focusrecovery.domain.session.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.entity.WorkSessionStatus;

@JsonInclude(JsonInclude.Include.ALWAYS)
public record WorkSessionResponse(
	UUID sessionId,
	String goalText,
	WorkSessionStatus status,
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
	Instant startedAt,
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
	Instant endedAt
) {

	public static WorkSessionResponse from(WorkSession session) {
		return new WorkSessionResponse(
			session.getSessionId(),
			session.getGoalText(),
			session.getStatus(),
			session.getStartedAt(),
			session.getEndedAt()
		);
	}
}

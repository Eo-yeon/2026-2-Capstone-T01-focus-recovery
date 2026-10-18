package com.focusrecovery.domain.alert.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.focusrecovery.domain.alert.entity.NotificationResponse;
import com.focusrecovery.domain.alert.entity.ResponseAction;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "사용자 선택 결과 (NotificationResponse)")
public record NotificationResponseResponse(
	@Schema(description = "BE가 발급한 사용자 선택 결과 ID") UUID feedbackId,
	@Schema(description = "응답 대상 알림 ID") UUID alertId,
	@Schema(description = "사용자 선택", example = "RETURN_TO_GOAL") ResponseAction action,
	@Schema(description = "FE에서 측정한 사용자 선택 시각 (UTC)", type = "string", format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC") Instant selectedAt
) {

	public static NotificationResponseResponse from(NotificationResponse response) {
		return new NotificationResponseResponse(response.getFeedbackId(), response.getAlertId(), response.getAction(),
			response.getSelectedAt());
	}
}

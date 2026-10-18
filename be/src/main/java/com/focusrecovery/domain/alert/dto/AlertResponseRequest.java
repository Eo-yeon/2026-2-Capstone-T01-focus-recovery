package com.focusrecovery.domain.alert.dto;

import java.time.Instant;

import com.focusrecovery.domain.alert.entity.ResponseAction;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;

@Schema(description = "알림 사용자 선택 저장 요청")
public record AlertResponseRequest(
	@Schema(description = "사용자 선택", example = "RETURN_TO_GOAL", requiredMode = Schema.RequiredMode.REQUIRED)
	@NotNull(message = "선택을 입력해 주세요.")
	ResponseAction action,

	@Schema(description = "사용자 선택 시각 (UTC ISO 8601, 밀리초까지만 허용·더 세밀하면 400. 보정하지 않고 그대로 저장). shownAt보다 앞설 수 없음", type = "string",
		format = "date-time", example = "2026-10-18T01:10:09.000Z", requiredMode = Schema.RequiredMode.REQUIRED)
	@NotNull(message = "선택 시각을 입력해 주세요.")
	Instant selectedAt,

	@Schema(description = "실제 표시 시각 (UTC ISO 8601, 밀리초까지만 허용·더 세밀하면 400). 표시 확인이 아직 저장되지 않았으면 필수, 저장된 값이 있으면 생략하거나 같은 값만 허용",
		types = {"string", "null"}, format = "date-time", example = "2026-10-18T01:10:02.345Z")
	Instant shownAt
) {

}

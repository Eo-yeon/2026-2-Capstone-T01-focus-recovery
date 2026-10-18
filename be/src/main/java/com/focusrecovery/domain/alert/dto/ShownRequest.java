package com.focusrecovery.domain.alert.dto;

import java.time.Instant;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;

@Schema(description = "실제 알림 표시 확인 요청")
public record ShownRequest(
	@Schema(description = "실제로 화면에 표시한 시각 (UTC ISO 8601, 밀리초까지만 허용·더 세밀하면 400. 보정하지 않고 그대로 저장). 재전송에도 같은 값 유지", type = "string",
		format = "date-time", example = "2026-10-18T01:10:02.345Z", requiredMode = Schema.RequiredMode.REQUIRED)
	@NotNull(message = "표시 시각을 입력해 주세요.")
	Instant shownAt
) {

}

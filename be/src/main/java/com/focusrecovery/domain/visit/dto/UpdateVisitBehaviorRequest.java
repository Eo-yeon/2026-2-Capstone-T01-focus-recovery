package com.focusrecovery.domain.visit.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

@Schema(description = "행동 정보 갱신 요청 (모두 누적값)")
public record UpdateVisitBehaviorRequest(
	@Schema(description = "누적 활성 체류시간(ms)", example = "15000", minimum = "0", requiredMode = Schema.RequiredMode.REQUIRED)
	@NotNull(message = "체류시간을 입력해 주세요.")
	@Min(value = 0, message = "체류시간은 0 이상이어야 합니다.")
	Long activeDurationMs,

	@Schema(description = "누적 탭 전환 횟수", example = "2", minimum = "0", requiredMode = Schema.RequiredMode.REQUIRED)
	@NotNull(message = "탭 전환 횟수를 입력해 주세요.")
	@Min(value = 0, message = "탭 전환 횟수는 0 이상이어야 합니다.")
	Integer tabSwitchCount,

	@Schema(description = "행동 갱신 버전. 갱신마다 증가시켜 보냄", example = "3", minimum = "0",
		requiredMode = Schema.RequiredMode.REQUIRED)
	@NotNull(message = "행동 갱신 버전을 입력해 주세요.")
	@Min(value = 0, message = "행동 갱신 버전은 0 이상이어야 합니다.")
	Long behaviorVersion
) {
}

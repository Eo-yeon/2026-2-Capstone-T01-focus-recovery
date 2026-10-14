package com.focusrecovery.domain.session.dto;

import java.util.List;

import com.focusrecovery.global.util.Uuids;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

@Schema(description = "작업 세션 종료 요청 (본문 생략 가능)")
public record EndWorkSessionRequest(
	@Schema(description = "종료 직전 방문별 마지막 행동 정보 (선택). 생략·null·빈 배열이면 종료만 처리합니다.")
	List<@NotNull(message = "최종 행동 정보 항목을 입력해 주세요.") @Valid FinalBehavior> finalBehaviors
) {

	@Schema(description = "방문의 마지막 행동 정보 (모두 누적값, PATCH 행동 정보 갱신과 같은 규칙)")
	public record FinalBehavior(
		@Schema(description = "방문 ID (UUID)", example = "7d3f8a2e-1c4b-4f6a-9e2d-5b8c0a1f3e47",
			requiredMode = Schema.RequiredMode.REQUIRED)
		@NotNull(message = "방문 ID를 입력해 주세요.")
		@Pattern(regexp = Uuids.REGEX, message = "방문 ID가 올바른 UUID 형식이 아닙니다.")
		String visitId,

		@Schema(description = "누적 활성 체류시간(ms)", example = "15000", minimum = "0", requiredMode = Schema.RequiredMode.REQUIRED)
		@NotNull(message = "체류시간을 입력해 주세요.")
		@Min(value = 0, message = "체류시간은 0 이상이어야 합니다.")
		Long activeDurationMs,

		@Schema(description = "누적 탭 전환 횟수", example = "2", minimum = "0", requiredMode = Schema.RequiredMode.REQUIRED)
		@NotNull(message = "탭 전환 횟수를 입력해 주세요.")
		@Min(value = 0, message = "탭 전환 횟수는 0 이상이어야 합니다.")
		Integer tabSwitchCount,

		@Schema(description = "행동 갱신 버전", example = "3", minimum = "0", requiredMode = Schema.RequiredMode.REQUIRED)
		@NotNull(message = "행동 갱신 버전을 입력해 주세요.")
		@Min(value = 0, message = "행동 갱신 버전은 0 이상이어야 합니다.")
		Long behaviorVersion
	) {
	}
}

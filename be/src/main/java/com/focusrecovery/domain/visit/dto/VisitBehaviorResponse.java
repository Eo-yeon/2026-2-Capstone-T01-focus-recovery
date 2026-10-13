package com.focusrecovery.domain.visit.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.focusrecovery.domain.visit.entity.PageVisit;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "행동 정보 갱신 결과 (서버에 저장된 현재 값)")
@JsonInclude(JsonInclude.Include.ALWAYS)
public record VisitBehaviorResponse(
	@Schema(description = "방문 ID", example = "7d3f8a2e-1c4b-4f6a-9e2d-5b8c0a1f3e47")
	UUID visitId,
	@Schema(description = "누적 활성 체류시간(ms)", example = "15000")
	long activeDurationMs,
	@Schema(description = "누적 탭 전환 횟수", example = "2")
	int tabSwitchCount,
	@Schema(description = "행동 갱신 버전", example = "3")
	long behaviorVersion,
	@Schema(description = "BE에서 기록한 마지막 행동 갱신 시각 (UTC). 갱신 전이면 null", types = {"string", "null"}, format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
	Instant updatedAt,
	@Schema(description = "이번 요청이 반영되었는지 여부. 낮은 버전이거나 같은 버전·같은 값이면 false", example = "true")
	boolean applied
) {

	public static VisitBehaviorResponse of(PageVisit visit, boolean applied) {
		return new VisitBehaviorResponse(visit.getVisitId(), visit.getActiveDurationMs(), visit.getTabSwitchCount(),
			visit.getBehaviorVersion(), visit.getUpdatedAt(), applied);
	}
}

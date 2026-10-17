package com.focusrecovery.domain.analysis.dto;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.focusrecovery.domain.session.entity.WorkSessionStatus;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "최신 분석 상태")
@JsonInclude(JsonInclude.Include.ALWAYS)
public record AnalysisStatusResponse(
	@Schema(description = "작업 세션 ID", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
	UUID sessionId,
	@Schema(description = "세션 상태", example = "ACTIVE")
	WorkSessionStatus sessionStatus,
	@Schema(description = "windowIndex가 가장 큰 분석(처리 상태 무관). 분석이 없으면 null", nullable = true)
	AnalysisSummaryResponse latestAnalysis,
	@Schema(description = "COMPLETED 중 windowIndex가 가장 큰 분석. 없으면 null", nullable = true)
	AnalysisSummaryResponse latestCompletedAnalysis,
	@Schema(description = "알림 후보. 알림 기능은 아직 구현되지 않아 항상 null", types = {"object", "null"})
	Object alert
) {
}

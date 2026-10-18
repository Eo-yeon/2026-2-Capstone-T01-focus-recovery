package com.focusrecovery.domain.analysis.dto;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.focusrecovery.domain.alert.dto.AlertResponse;
import com.focusrecovery.domain.session.entity.WorkSessionStatus;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "최신 분석 상태")
@JsonInclude(JsonInclude.Include.ALWAYS)
public record AnalysisStatusResponse(
	@Schema(description = "작업 세션 ID", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
	UUID sessionId,
	@Schema(description = "세션 상태", example = "ACTIVE")
	WorkSessionStatus sessionStatus,
	@Schema(description = "저장된 분석 중 windowIndex가 가장 큰 분석(처리 상태 무관). 분석이 없으면 null", nullable = true)
	AnalysisSummaryResponse latestAnalysis,
	@Schema(description = "COMPLETED 중 windowIndex가 가장 큰 참고 결과. 현재 탐색 상태나 알림 표시 허용을 의미하지 않는다. "
		+ "latestAnalysis와 windowIndex가 다르면 이전 구간의 결과이며, 같아도 그것만으로 알림을 허용하지 않는다. 없으면 null",
		nullable = true)
	AnalysisSummaryResponse latestCompletedAnalysis,
	@Schema(description = "실제 표시할 수 있는 알림 후보. 실제 알림 표시는 이 값을 기준으로 하며 FE는 표시 직전에 ACTIVE 세션·alertId 중복을 확인한다. "
		+ "현재 활성화된 방식(서버 설정 AI 또는 FIXED_INTERVAL)의 미표시 후보만 반환한다. AI 후보는 실제 최신 구간의 DRIFT 분석에 연결된 것만 반환하며, "
		+ "없거나 세션이 종료됐으면 null", nullable = true)
	AlertResponse alert
) {
}

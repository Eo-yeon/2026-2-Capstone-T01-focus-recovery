package com.focusrecovery.domain.analysis.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.focusrecovery.domain.analysis.entity.AnalysisStatus;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "분석 요약 (AnalysisSummary). 완료 전·실패 시 result와 확률은 null이며 NORMAL로 대체하지 않는다")
@JsonInclude(JsonInclude.Include.ALWAYS)
public record AnalysisSummaryResponse(
	@Schema(description = "분석 ID", example = "5b1f0c2e-8d3a-4c7e-9f21-6a4d2b8e1c90")
	UUID analysisId,
	@Schema(description = "분석 대상 탐색 구간 ID", example = "3c9e7a14-2b5d-4f8a-8e61-0d7f2c4b9a35")
	UUID windowId,
	@Schema(description = "세션 내 탐색 구간 순서 (1부터)", example = "3")
	int windowIndex,
	@Schema(description = "처리 상태", example = "COMPLETED")
	AnalysisStatus processingStatus,
	@Schema(description = "판정. COMPLETED일 때만 값이 있음", types = {"string", "null"},
		allowableValues = {"NORMAL", "TRANSITION", "DRIFT"}, example = "TRANSITION")
	String result,
	@Schema(description = "정상 탐색 확률. COMPLETED일 때만 값이 있음", types = {"number", "null"}, example = "0.3")
	@JsonProperty("pNormal")
	Double pNormal,
	@Schema(description = "전이 상태 확률. COMPLETED일 때만 값이 있음", types = {"number", "null"}, example = "0.5")
	@JsonProperty("pTransition")
	Double pTransition,
	@Schema(description = "목표 이탈 확률. COMPLETED일 때만 값이 있음", types = {"number", "null"}, example = "0.2")
	@JsonProperty("pDrift")
	Double pDrift,
	@Schema(description = "BE의 분석 요청 기록 시각 (UTC)", type = "string", format = "date-time", example = "2026-10-16T01:00:00.000Z")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
	Instant requestedAt,
	@Schema(description = "AI가 반환한 분석 완료 시각 (UTC). 완료 전·실패 시 null", types = {"string", "null"}, format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
	Instant analyzedAt,
	@Schema(description = "BE에서 COMPLETED 또는 FAILED로 처리한 시각 (UTC). 처리 중이면 null", types = {"string", "null"}, format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
	Instant completedAt,
	@Schema(description = "FAILED인 경우 실패 코드 (AI_TIMEOUT, AI_UNAVAILABLE, AI_INVALID_RESPONSE, AI 오류 코드, "
		+ "ANALYSIS_NOT_STARTED, ANALYSIS_INTERRUPTED, ANALYSIS_QUEUE_FULL, ANALYSIS_INTERNAL_ERROR). 그 외 null",
		types = {"string", "null"}, example = "AI_TIMEOUT")
	String errorCode
) {
}

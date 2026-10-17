package com.focusrecovery.domain.analysis.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;
import com.focusrecovery.domain.analysis.entity.AnalysisResult;
import com.focusrecovery.domain.analysis.entity.AnalysisStatus;
import com.focusrecovery.domain.window.entity.AnalysisWindow;

import io.swagger.v3.oas.annotations.media.Schema;

// JSON 컬럼은 DB에 저장된 JSON 텍스트를 그대로 내보낸다(@JsonRawValue): 문자열로 다시 감싸지 않고 객체 또는 null이 된다
@Schema(description = "분석 결과 상세 (AnalysisSummary 필드 + 구간·입력·모델 정보)")
@JsonInclude(JsonInclude.Include.ALWAYS)
public record AnalysisDetailResponse(
	@Schema(description = "분석 ID") UUID analysisId,
	@Schema(description = "분석 대상 탐색 구간 ID") UUID windowId,
	@Schema(description = "세션 내 탐색 구간 순서", example = "3") int windowIndex,
	@Schema(description = "처리 상태", example = "COMPLETED") AnalysisStatus processingStatus,
	@Schema(description = "판정. COMPLETED일 때만 값이 있음", types = {"string", "null"},
		allowableValues = {"NORMAL", "TRANSITION", "DRIFT"}) String result,
	@Schema(description = "정상 탐색 확률", types = {"number", "null"}) @JsonProperty("pNormal") Double pNormal,
	@Schema(description = "전이 상태 확률", types = {"number", "null"}) @JsonProperty("pTransition") Double pTransition,
	@Schema(description = "목표 이탈 확률", types = {"number", "null"}) @JsonProperty("pDrift") Double pDrift,
	@Schema(description = "BE의 분석 요청 기록 시각 (UTC)", type = "string", format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC") Instant requestedAt,
	@Schema(description = "AI가 반환한 분석 완료 시각 (UTC)", types = {"string", "null"}, format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC") Instant analyzedAt,
	@Schema(description = "BE에서 COMPLETED 또는 FAILED로 처리한 시각 (UTC)", types = {"string", "null"}, format = "date-time")
	@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC") Instant completedAt,
	@Schema(description = "FAILED인 경우 실패 코드. 그 외 null", types = {"string", "null"}) String errorCode,
	@Schema(description = "작업 세션 ID") UUID sessionId,
	@Schema(description = "구간 크기", example = "5") int windowSize,
	@Schema(description = "구간의 첫 방문 ID") UUID startVisitId,
	@Schema(description = "구간의 마지막 방문 ID") UUID endVisitId,
	@Schema(description = "구간 구성 방문 (position 오름차순 5개). 분석 당시 페이지·행동 값은 inputSnapshot에서 확인")
	List<Visit> visits,
	@Schema(description = "맥락 모델 실행 여부. 완료 전·실패 시 null", types = {"boolean", "null"}) Boolean contextUsed,
	@Schema(description = "구조화된 탐색 맥락 분석 결과", types = {"object", "null"}) @JsonRawValue String contextResult,
	@Schema(description = "BE가 분석 요청 전에 고정한 목표·방문·행동 입력. 이후 행동 갱신으로 바뀌지 않음", types = {"object", "null"})
	@JsonRawValue String inputSnapshot,
	@Schema(description = "모델에 입력한 특징값", types = {"object", "null"}) @JsonRawValue String featureSnapshot,
	@Schema(description = "분석 모델별 버전", types = {"object", "null"}) @JsonRawValue String modelVersions
) {

	public record Visit(
		@Schema(description = "구간 내 순서 (1~5)", example = "1") int position,
		@Schema(description = "방문 ID") UUID visitId,
		@Schema(description = "세션 내 방문 순서", example = "3") int sequence
	) {
	}

	public static AnalysisDetailResponse of(AnalysisResult analysis, AnalysisWindow window, List<Visit> visits) {
		return new AnalysisDetailResponse(analysis.getAnalysisId(), analysis.getWindowId(), window.getWindowIndex(),
			analysis.getProcessingStatus(), analysis.getResult(), analysis.getPNormal(), analysis.getPTransition(),
			analysis.getPDrift(), analysis.getRequestedAt(), analysis.getAnalyzedAt(), analysis.getCompletedAt(),
			analysis.getErrorCode(), window.getSessionId(), window.getWindowSize(), window.getStartVisitId(),
			window.getEndVisitId(), visits, analysis.getContextUsed(), analysis.getContextResult(),
			analysis.getInputSnapshot(), analysis.getFeatureSnapshot(), analysis.getModelVersions());
	}
}

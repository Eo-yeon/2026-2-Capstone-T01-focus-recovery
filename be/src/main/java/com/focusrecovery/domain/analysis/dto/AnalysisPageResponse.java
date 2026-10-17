package com.focusrecovery.domain.analysis.dto;

import java.util.List;

import org.springframework.data.domain.Page;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "분석 결과 목록 (windowIndex 내림차순, 모든 처리 상태 포함)")
public record AnalysisPageResponse(
	@Schema(description = "분석 목록. 없으면 빈 배열")
	List<AnalysisSummaryResponse> items,
	@Schema(description = "현재 페이지 번호 (0부터)", example = "0")
	int page,
	@Schema(description = "페이지 크기", example = "20")
	int size,
	@Schema(description = "세션의 전체 분석 수", example = "7")
	long totalElements,
	@Schema(description = "다음 페이지 존재 여부", example = "false")
	boolean hasNext
) {

	public static AnalysisPageResponse from(Page<AnalysisSummaryResponse> page) {
		return new AnalysisPageResponse(
			page.getContent(), page.getNumber(), page.getSize(), page.getTotalElements(), page.hasNext());
	}
}

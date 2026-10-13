package com.focusrecovery.domain.visit.dto;

import java.util.List;

import org.springframework.data.domain.Page;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "방문 기록 목록 (sequence 오름차순)")
public record PageVisitPageResponse(
	@Schema(description = "방문 기록 목록. 기록이 없으면 빈 배열")
	List<PageVisitSummaryResponse> items,
	@Schema(description = "현재 페이지 번호 (0부터)", example = "0")
	int page,
	@Schema(description = "페이지 크기", example = "20")
	int size,
	@Schema(description = "세션의 전체 방문 기록 수", example = "42")
	long totalElements,
	@Schema(description = "다음 페이지 존재 여부", example = "true")
	boolean hasNext
) {

	public static PageVisitPageResponse from(Page<PageVisitSummaryResponse> page) {
		return new PageVisitPageResponse(
			page.getContent(), page.getNumber(), page.getSize(), page.getTotalElements(), page.hasNext());
	}
}

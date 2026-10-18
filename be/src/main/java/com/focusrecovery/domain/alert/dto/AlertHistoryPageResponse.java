package com.focusrecovery.domain.alert.dto;

import java.util.List;

import org.springframework.data.domain.Page;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "알림·사용자 선택 이력 (createdAt 내림차순, 동률은 alertId 내림차순)")
public record AlertHistoryPageResponse(
	@Schema(description = "알림 이력. 없으면 빈 배열") List<AlertHistoryItem> items,
	@Schema(description = "현재 페이지 번호 (0부터)", example = "0") int page,
	@Schema(description = "페이지 크기", example = "20") int size,
	@Schema(description = "세션의 전체 알림 수", example = "3") long totalElements,
	@Schema(description = "다음 페이지 존재 여부", example = "false") boolean hasNext
) {

	public static AlertHistoryPageResponse from(Page<AlertHistoryItem> page) {
		return new AlertHistoryPageResponse(page.getContent(), page.getNumber(), page.getSize(), page.getTotalElements(),
			page.hasNext());
	}
}

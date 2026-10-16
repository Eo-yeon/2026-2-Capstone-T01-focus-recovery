package com.focusrecovery.domain.analysis.client;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

// AI-API-01 요청 본문이자 analysis_result.input_snapshot에 그대로 저장하는 값
@JsonInclude(JsonInclude.Include.ALWAYS)
public record AiAnalysisRequest(
	UUID analysisId,
	UUID sessionId,
	UUID windowId,
	int windowIndex,
	String goalText,
	List<Visit> visits
) {

	// PageVisit에서 sessionId·updatedAt을 뺀 필드 + position(1~5)
	@JsonInclude(JsonInclude.Include.ALWAYS)
	public record Visit(
		int position,
		UUID visitId,
		int sequence,
		String browserTabKey,
		String normalizedUrl,
		String domain,
		String title,
		String content,
		String searchQuery,
		@JsonProperty("isSearchResultPage")
		boolean isSearchResultPage,
		@JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
		Instant visitedAt,
		long activeDurationMs,
		int tabSwitchCount,
		long behaviorVersion
	) {
	}
}

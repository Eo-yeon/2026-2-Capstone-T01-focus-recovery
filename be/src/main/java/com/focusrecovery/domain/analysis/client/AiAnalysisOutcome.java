package com.focusrecovery.domain.analysis.client;

import java.time.Instant;

// errorCode가 있으면 실패이며 나머지 값은 모두 null이다
public record AiAnalysisOutcome(
	String errorCode,
	String result,
	Double pNormal,
	Double pTransition,
	Double pDrift,
	Boolean contextUsed,
	String contextResult,
	String featureSnapshot,
	String modelVersions,
	Instant analyzedAt
) {

	public static AiAnalysisOutcome failed(String errorCode) {
		return new AiAnalysisOutcome(errorCode, null, null, null, null, null, null, null, null, null);
	}
}

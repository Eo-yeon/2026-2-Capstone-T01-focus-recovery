package com.focusrecovery.domain.analysis.exception;

public class AnalysisNotFoundException extends RuntimeException {

	public AnalysisNotFoundException() {
		super("해당 세션에서 분석 결과를 찾을 수 없습니다.");
	}
}

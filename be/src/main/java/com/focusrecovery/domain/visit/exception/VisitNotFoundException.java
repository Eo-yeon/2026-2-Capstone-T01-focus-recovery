package com.focusrecovery.domain.visit.exception;

public class VisitNotFoundException extends RuntimeException {

	public VisitNotFoundException() {
		super("해당 세션에서 방문 기록을 찾을 수 없습니다.");
	}
}

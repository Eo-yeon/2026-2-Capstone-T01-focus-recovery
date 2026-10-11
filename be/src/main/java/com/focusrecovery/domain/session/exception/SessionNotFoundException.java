package com.focusrecovery.domain.session.exception;

public class SessionNotFoundException extends RuntimeException {

	public SessionNotFoundException() {
		super("작업 세션을 찾을 수 없습니다.");
	}
}

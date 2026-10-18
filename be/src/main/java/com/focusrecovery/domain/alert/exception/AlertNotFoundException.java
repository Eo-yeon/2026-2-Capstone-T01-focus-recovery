package com.focusrecovery.domain.alert.exception;

public class AlertNotFoundException extends RuntimeException {

	public AlertNotFoundException() {
		super("해당 세션에서 알림을 찾을 수 없습니다.");
	}
}

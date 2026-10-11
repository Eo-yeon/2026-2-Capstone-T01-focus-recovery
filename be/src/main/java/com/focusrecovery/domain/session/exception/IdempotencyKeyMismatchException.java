package com.focusrecovery.domain.session.exception;

public class IdempotencyKeyMismatchException extends RuntimeException {

	public IdempotencyKeyMismatchException() {
		super("같은 Idempotency-Key로 다른 요청 내용이 전달되었습니다.");
	}
}

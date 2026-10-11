package com.focusrecovery.global.exception;

import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import com.focusrecovery.domain.session.exception.IdempotencyKeyMismatchException;
import com.focusrecovery.domain.session.exception.SessionNotFoundException;

@RestControllerAdvice
public class GlobalExceptionHandler {

	private static final String INVALID_REQUEST = "INVALID_REQUEST";

	@ExceptionHandler(MethodArgumentNotValidException.class)
	@ResponseStatus(HttpStatus.BAD_REQUEST)
	public ErrorResponse handleValidation(MethodArgumentNotValidException e) {
		return new ErrorResponse(
			INVALID_REQUEST,
			"요청 값이 올바르지 않습니다.",
			e.getBindingResult().getFieldErrors().stream()
				.map(error -> new ErrorResponse.FieldError(error.getField(), error.getDefaultMessage()))
				.toList()
		);
	}

	@ExceptionHandler(HttpMessageNotReadableException.class)
	@ResponseStatus(HttpStatus.BAD_REQUEST)
	public ErrorResponse handleUnreadable(HttpMessageNotReadableException e) {
		return ErrorResponse.of(INVALID_REQUEST, "요청 본문을 읽을 수 없습니다.");
	}

	@ExceptionHandler(InvalidRequestException.class)
	@ResponseStatus(HttpStatus.BAD_REQUEST)
	public ErrorResponse handleInvalidRequest(InvalidRequestException e) {
		return ErrorResponse.of(INVALID_REQUEST, e.getMessage());
	}

	@ExceptionHandler(SessionNotFoundException.class)
	@ResponseStatus(HttpStatus.NOT_FOUND)
	public ErrorResponse handleSessionNotFound(SessionNotFoundException e) {
		return ErrorResponse.of("SESSION_NOT_FOUND", e.getMessage());
	}

	@ExceptionHandler(IdempotencyKeyMismatchException.class)
	@ResponseStatus(HttpStatus.UNPROCESSABLE_CONTENT)
	public ErrorResponse handleIdempotencyKeyMismatch(IdempotencyKeyMismatchException e) {
		return ErrorResponse.of("IDEMPOTENCY_KEY_MISMATCH", e.getMessage());
	}
}

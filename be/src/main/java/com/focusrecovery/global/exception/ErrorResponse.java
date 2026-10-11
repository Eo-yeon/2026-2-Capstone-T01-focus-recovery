package com.focusrecovery.global.exception;

import java.util.List;

public record ErrorResponse(String code, String message, List<FieldError> fieldErrors) {

	public record FieldError(String field, String message) {
	}

	public static ErrorResponse of(String code, String message) {
		return new ErrorResponse(code, message, List.of());
	}
}

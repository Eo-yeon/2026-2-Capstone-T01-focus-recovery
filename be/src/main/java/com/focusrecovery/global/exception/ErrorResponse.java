package com.focusrecovery.global.exception;

import java.util.List;

import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "오류 응답")
public record ErrorResponse(
	@Schema(description = "오류 코드 (INVALID_REQUEST, SESSION_NOT_FOUND, VISIT_NOT_FOUND, IDEMPOTENCY_KEY_MISMATCH, "
		+ "SESSION_ENDED, VISIT_ID_CONFLICT, VISIT_SEQUENCE_CONFLICT, BEHAVIOR_VERSION_CONFLICT, BEHAVIOR_COUNTER_DECREASED)", example = "INVALID_REQUEST")
	String code,
	@Schema(description = "오류 메시지", example = "요청 값이 올바르지 않습니다.")
	String message,
	@Schema(description = "필드별 검증 오류. 필드 검증 오류가 아니면 빈 배열")
	List<FieldError> fieldErrors
) {

	@Schema(description = "필드 검증 오류")
	public record FieldError(
		@Schema(description = "오류가 난 필드", example = "goalText") String field,
		@Schema(description = "필드 오류 메시지", example = "작업 목표는 5자 이상 150자 이하로 입력해 주세요.") String message
	) {
	}

	public static ErrorResponse of(String code, String message) {
		return new ErrorResponse(code, message, List.of());
	}
}

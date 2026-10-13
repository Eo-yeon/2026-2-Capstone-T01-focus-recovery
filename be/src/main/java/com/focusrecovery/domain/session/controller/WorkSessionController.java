package com.focusrecovery.domain.session.controller;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.focusrecovery.domain.session.dto.CreateWorkSessionRequest;
import com.focusrecovery.domain.session.dto.WorkSessionResponse;
import com.focusrecovery.domain.session.service.WorkSessionService;
import com.focusrecovery.global.exception.InvalidRequestException;
import com.focusrecovery.global.util.Uuids;

import com.focusrecovery.global.exception.ErrorResponse;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.ExampleObject;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;

@Tag(name = "작업 세션", description = "작업 세션 생성·조회 API")
@RestController
@RequestMapping("/api/sessions")
public class WorkSessionController {

	private final WorkSessionService workSessionService;

	public WorkSessionController(WorkSessionService workSessionService) {
		this.workSessionService = workSessionService;
	}

	@Operation(
		summary = "작업 세션 생성",
		description = """
			작업 목표(goalText)로 새 작업 세션을 시작합니다. 목표의 앞뒤 공백은 제거되어 저장됩니다.

			**Idempotency-Key (선택)**
			- 헤더가 없으면 요청마다 새 세션을 생성합니다. 같은 목표라도 서로 다른 세션이 됩니다.
			- 네트워크 재시도로 인한 중복 생성을 막으려면 "작업 시작" 동작마다 새 키(예: UUID)를 만들고, 재시도할 때는 같은 키를 다시 보냅니다.
			- 같은 키 + 같은 목표로 다시 요청하면 새로 저장하지 않고 기존 세션을 201로 그대로 반환합니다(동시 요청 포함).
			- 같은 키로 다른 목표를 보내면 422를 반환합니다.
			""")
	@ApiResponse(responseCode = "201", description = "세션 생성 성공 (같은 키 재요청 시 기존 세션 반환)")
	@ApiResponse(responseCode = "400", description = "goalText 누락·공백·길이(5~150자) 위반, 요청 본문 오류, Idempotency-Key 형식 오류",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "목표 길이 위반", value = """
				{"code": "INVALID_REQUEST", "message": "요청 값이 올바르지 않습니다.",
				 "fieldErrors": [{"field": "goalText", "message": "작업 목표는 5자 이상 150자 이하로 입력해 주세요."}]}"""),
			@ExampleObject(name = "Idempotency-Key 형식 오류", value = """
				{"code": "INVALID_REQUEST", "message": "Idempotency-Key는 1~255자여야 합니다.", "fieldErrors": []}""")
		}))
	@ApiResponse(responseCode = "422", description = "같은 Idempotency-Key로 다른 goalText를 보냄",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "IDEMPOTENCY_KEY_MISMATCH", "message": "같은 Idempotency-Key로 다른 요청 내용이 전달되었습니다.", "fieldErrors": []}""")))
	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	public WorkSessionResponse create(
		@Parameter(description = "중복 생성 방지용 키 (선택, 1~255자). 재시도 시 같은 값을 보냅니다.",
			example = "3f1c2a9e-7b4d-4e8a-9c1f-2d6b5a8e0f13")
		@RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
		@Valid @RequestBody CreateWorkSessionRequest request
	) {
		if (idempotencyKey != null && (idempotencyKey.isBlank() || idempotencyKey.length() > 255)) {
			throw new InvalidRequestException("Idempotency-Key는 1~255자여야 합니다.");
		}
		return workSessionService.create(request.goalText(), idempotencyKey);
	}

	@Operation(summary = "작업 세션 조회", description = "세션 ID로 작업 세션 하나를 조회합니다.")
	@ApiResponse(responseCode = "200", description = "조회 성공")
	@ApiResponse(responseCode = "400", description = "세션 ID가 UUID 형식(8-4-4-4-12)이 아님",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "세션 ID가 올바른 UUID 형식이 아닙니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "404", description = "세션이 존재하지 않음",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@GetMapping("/{sessionId}")
	public WorkSessionResponse get(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId
	) {
		return workSessionService.get(Uuids.parse(sessionId, "세션 ID가 올바른 UUID 형식이 아닙니다."));
	}
}

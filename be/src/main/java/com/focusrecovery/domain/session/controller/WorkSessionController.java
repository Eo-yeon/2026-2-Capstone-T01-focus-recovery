package com.focusrecovery.domain.session.controller;

import java.util.UUID;
import java.util.regex.Pattern;

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

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/sessions")
public class WorkSessionController {

	// UUID.fromString은 "1-1-1-1-1" 같은 비표준 형식도 허용하므로 8-4-4-4-12 형식을 직접 검사한다
	private static final Pattern UUID_PATTERN =
		Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

	private final WorkSessionService workSessionService;

	public WorkSessionController(WorkSessionService workSessionService) {
		this.workSessionService = workSessionService;
	}

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	public WorkSessionResponse create(
		@RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
		@Valid @RequestBody CreateWorkSessionRequest request
	) {
		if (idempotencyKey != null && (idempotencyKey.isBlank() || idempotencyKey.length() > 255)) {
			throw new InvalidRequestException("Idempotency-Key는 1~255자여야 합니다.");
		}
		return workSessionService.create(request.goalText(), idempotencyKey);
	}

	@GetMapping("/{sessionId}")
	public WorkSessionResponse get(@PathVariable String sessionId) {
		if (!UUID_PATTERN.matcher(sessionId).matches()) {
			throw new InvalidRequestException("세션 ID가 올바른 UUID 형식이 아닙니다.");
		}
		return workSessionService.get(UUID.fromString(sessionId));
	}
}

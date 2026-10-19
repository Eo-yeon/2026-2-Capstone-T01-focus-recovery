package com.focusrecovery.global.health;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;

// HTTP 서버가 요청을 처리할 수 있는지만 확인한다. DB 조회·AI 호출·모델 준비 확인·알림/분석 작업을 하지 않는다
@Tag(name = "서버 상태", description = "백엔드 실행 상태 확인 API")
@RestController
public class HealthController {

	private static final HealthResponse UP = new HealthResponse("UP");

	@Schema(description = "백엔드 실행 상태")
	public record HealthResponse(
		@Schema(description = "HTTP 서버가 요청을 처리할 수 있으면 UP", allowableValues = "UP", example = "UP")
		String status
	) {
	}

	@Operation(
		summary = "백엔드 실행 상태 확인",
		description = """
			Spring Boot HTTP 서버가 요청을 받아 응답할 수 있는지 확인합니다. 요청 본문과 query는 없습니다.

			- 확인 범위는 HTTP 서버의 응답 가능 여부뿐입니다. DB 연결, AI 서버·모델 준비 상태, 분석·알림 작업 상태는 확인하지 않으며 이 API를 호출해도 실행되지 않습니다.
			- 따라서 UP이어도 DB나 AI가 정상이라는 뜻은 아닙니다. AI 준비 상태는 AI 서버의 GET /api/ai/health가 담당합니다.
			- 서버에 연결할 수 없으면 HTTP 응답 자체를 받지 못할 수 있습니다.
			""")
	@ApiResponse(responseCode = "200", description = "HTTP 서버가 응답 가능")
	@GetMapping("/api/health")
	public HealthResponse health() {
		return UP;
	}
}

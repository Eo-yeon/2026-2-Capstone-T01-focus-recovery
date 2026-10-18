package com.focusrecovery.domain.alert.controller;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.focusrecovery.domain.alert.dto.AlertResponse;
import com.focusrecovery.domain.alert.service.AlertService;
import com.focusrecovery.global.exception.ErrorResponse;
import com.focusrecovery.global.util.Uuids;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.ExampleObject;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;

@Tag(name = "목표 복귀 알림", description = "알림 후보 생성 API")
@RestController
@RequestMapping("/api/sessions/{sessionId}/alerts")
public class AlertController {

	private final AlertService alertService;

	public AlertController(AlertService alertService) {
		this.alertService = alertService;
	}

	@Operation(
		summary = "고정 주기 알림 후보 생성",
		description = """
			고정 주기 방식이 활성화된 ACTIVE 세션에 목표 재제시 알림 후보를 만듭니다. 요청 본문은 없거나 {}입니다.

			- 방식은 서버 전체 설정(focus-recovery.alert.mode, 기본 AI)으로 하나만 활성화하는 잠정 구현이며 세션별 방식 선택은 아직 지원하지 않습니다.
			  AI 모드에서는 409 FIXED_INTERVAL_DISABLED입니다. 모드 전환은 진행 중인 세션을 모두 종료한 뒤 서버를 재시작하는 운영을 전제로 합니다.
			- 간격(focus-recovery.alert.fixed-interval.interval, 잠정 10분): 첫 후보는 세션 startedAt, 이후는 마지막 고정 주기 알림의 shownAt부터 계산합니다.
			  간격이 지나지 않았으면 409 ALERT_INTERVAL_NOT_REACHED입니다(경과 시간이 간격과 같으면 생성).
			- 아직 표시되지 않은 고정 주기 후보가 있으면 새로 만들지 않고 같은 alertId를 200으로 반환합니다. 동시 요청에도 후보는 하나입니다.
			- analysisId·windowIndex는 null이며 실제 표시 확인 전에는 shownAt이 null입니다. 후보 생성은 실제 표시가 아닙니다.
			""")
	@ApiResponse(responseCode = "201", description = "새 후보 생성")
	@ApiResponse(responseCode = "200", description = "기존 미표시 후보 반환 (같은 alertId)")
	@ApiResponse(responseCode = "400", description = "세션 ID가 UUID 형식이 아니거나 요청 본문이 JSON 객체가 아님",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "세션 ID가 올바른 UUID 형식이 아닙니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "404", description = "세션이 존재하지 않음",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "409", description = "FIXED_INTERVAL_DISABLED: 고정 주기 방식 비활성 / SESSION_ENDED: 종료된 세션 / "
		+ "ALERT_INTERVAL_NOT_REACHED: 간격 미도달",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "FIXED_INTERVAL_DISABLED", value = """
				{"code": "FIXED_INTERVAL_DISABLED", "message": "고정 주기 알림이 활성화되어 있지 않습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "SESSION_ENDED", value = """
				{"code": "SESSION_ENDED", "message": "종료된 작업 세션입니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "ALERT_INTERVAL_NOT_REACHED", value = """
				{"code": "ALERT_INTERVAL_NOT_REACHED", "message": "고정 주기 알림 간격이 아직 지나지 않았습니다.", "fieldErrors": []}""")
		}))
	@PostMapping("/fixed-interval")
	public ResponseEntity<AlertResponse> createFixedInterval(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@io.swagger.v3.oas.annotations.parameters.RequestBody(description = "없거나 {}. 내용은 사용하지 않음", required = false)
		@RequestBody(required = false) Map<String, Object> ignored
	) {
		AlertService.FixedIntervalResult result = alertService.requestFixedInterval(
			Uuids.parse(sessionId, "세션 ID가 올바른 UUID 형식이 아닙니다."));
		return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result.alert());
	}
}

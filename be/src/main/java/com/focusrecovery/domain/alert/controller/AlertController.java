package com.focusrecovery.domain.alert.controller;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.focusrecovery.domain.alert.dto.AlertHistoryPageResponse;
import com.focusrecovery.domain.alert.dto.AlertResponse;
import com.focusrecovery.domain.alert.dto.AlertResponseRequest;
import com.focusrecovery.domain.alert.dto.NotificationResponseResponse;
import com.focusrecovery.domain.alert.dto.ShownRequest;
import com.focusrecovery.domain.alert.service.AlertDisplayService;
import com.focusrecovery.domain.alert.service.AlertHistoryService;
import com.focusrecovery.domain.alert.service.AlertService;
import com.focusrecovery.global.exception.ErrorResponse;
import com.focusrecovery.global.util.Pages;
import com.focusrecovery.global.util.Uuids;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.ExampleObject;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;

@Tag(name = "목표 복귀 알림", description = "알림 후보 생성·실제 표시 확인·사용자 선택 저장·이력 조회 API")
@RestController
@RequestMapping("/api/sessions/{sessionId}/alerts")
public class AlertController {

	private static final String INVALID_SESSION_ID = "세션 ID가 올바른 UUID 형식이 아닙니다.";
	private static final String INVALID_ALERT_ID = "알림 ID가 올바른 UUID 형식이 아닙니다.";
	private static final String REPEAT_LIMIT_BASIS = """
		- AI 반복 알림 제한 기준(의도된 정책): 연속 DRIFT는 표시된 AI 알림 중 최대 windowIndex, 최소 간격은 표시된 AI 알림 중 최대 shownAt을 기준으로 합니다.
		  두 값은 서로 다른 알림에서 나올 수 있습니다. 확인 요청의 도착 순서·시각은 쓰지 않으므로, 작은 구간의 확인이 늦게 도착해도 연속 DRIFT 기준이 뒤로 돌아가지 않고,
		  같은 shownAt 재전송이나 늦은 확인은 최소 간격의 시작 시각을 바꾸지 않습니다.
		""";
	private static final String TIME_RULES = """

		**시각 입력 형식**
		- UTC ISO 8601이며 밀리초(소수점 3자리)까지만 허용합니다. 예) 2026-10-18T01:10:02.345Z. 밀리초보다 세밀한 값(예: .345678Z)은 400 INVALID_REQUEST입니다.
		- 전달한 시각은 보정하거나 잘라내지 않고 그대로 저장합니다.

		**시각 검증 (구현 정책)**
		- 이번 작업에서 확정한 구현 정책: 후보 생성 시각보다 이른 표시·서버 현재 시각보다 미래인 표시는 409 ALERT_NOT_DISPLAYABLE,
		  selectedAt이 shownAt보다 이르거나 서버 현재 시각보다 미래면 400 INVALID_REQUEST입니다. selectedAt과 shownAt 비교에는 허용치를 쓰지 않습니다(같은 클라이언트 시계).
		- 시계 오차 허용치(focus-recovery.alert.clock-skew-tolerance)는 최종 합의 전 잠정 설정 5초입니다. 클라이언트 시각과 서버 시각(후보 생성·세션 종료·현재 시각)을 비교할 때만 적용합니다.
		- 요청 도착 지연과는 무관하므로 종료 전에 표시된 알림의 확인은 언제 도착해도 저장합니다. 한계: 종료 후 최대 5초 안의 표시는 허용 범위에 들어올 수 있습니다.
		""";

	private final AlertService alertService;
	private final AlertDisplayService alertDisplayService;
	private final AlertHistoryService alertHistoryService;

	public AlertController(AlertService alertService, AlertDisplayService alertDisplayService,
		AlertHistoryService alertHistoryService) {
		this.alertService = alertService;
		this.alertDisplayService = alertDisplayService;
		this.alertHistoryService = alertHistoryService;
	}

	@Operation(
		summary = "알림·사용자 선택 이력 조회",
		description = """
			세션의 알림 후보와 사용자 선택을 함께 조회합니다. 종료된 세션도 조회할 수 있습니다.

			- 각 항목은 Alert의 모든 필드에 response(사용자 선택: feedbackId, alertId, action, selectedAt)를 더한 형태입니다. 선택이 없으면 response는 null입니다.
			- 정렬: createdAt 내림차순, 같으면 alertId 내림차순입니다.
			- AI·FIXED_INTERVAL 알림을 모두 포함합니다. 미표시 후보도 포함하며 shownAt=null로 구분합니다. 표시됐지만 선택이 없으면 response=null입니다.
			- 현재 후보 여부·서버 알림 모드·표시 가능 조건으로 이력을 제외하지 않습니다. 해당 세션의 알림과 그 알림에 연결된 선택만 반환합니다.
			- 조회만 하며 AI 호출·후보 생성·shownAt 기록·복구 처리를 하지 않습니다.
			""")
	@ApiResponse(responseCode = "200", description = "조회 성공")
	@ApiResponse(responseCode = "400", description = "잘못된 UUID 또는 페이지네이션 값(page 0 이상, size 1~100, page × size가 int 범위 이내)",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "size는 1 이상 100 이하여야 합니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "404", description = "세션이 존재하지 않음",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@GetMapping
	public AlertHistoryPageResponse history(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@Parameter(description = "페이지 번호 (0부터)", example = "0")
		@RequestParam(defaultValue = "0") int page,
		@Parameter(description = "페이지 크기 (1~100)", example = "20")
		@RequestParam(defaultValue = "20") int size
	) {
		Pages.validate(page, size);
		return alertHistoryService.history(Uuids.parse(sessionId, INVALID_SESSION_ID), page, size);
	}

	@Operation(
		summary = "고정 주기 알림 후보 생성",
		description = """
			고정 주기 방식이 활성화된 ACTIVE 세션에 목표 재제시 알림 후보를 만듭니다. 요청 본문은 없거나 {}입니다.

			- 방식은 서버 전체 설정(focus-recovery.alert.mode, 기본 AI)으로 하나만 활성화하는 잠정 구현이며 세션별 방식 선택은 아직 지원하지 않습니다.
			  AI 모드에서는 409 FIXED_INTERVAL_DISABLED입니다. 모드 전환은 진행 중인 세션을 모두 종료한 뒤 서버를 재시작하는 운영을 전제로 합니다.
			- 예정 시각(잠정 정책): 세션 startedAt + 간격 × n(n = 1, 2, 3…)으로 세션 시작 시각에 고정합니다. 간격(focus-recovery.alert.fixed-interval.interval)은 잠정값 10분입니다.
			  예) 10분·20분·30분. 실제 표시 시각(shownAt)으로 다음 예정 시각을 다시 계산하지 않으므로, 첫 알림이 12분에 표시돼도 다음 예정 시각은 20분입니다.
			- 현재 시각까지 도래한 가장 최근 회차만 생성 대상입니다. 놓친 이전 회차는 소급 생성하지 않습니다(예: 35분 첫 요청 → 30분 회차 후보 하나).
			- 현재 회차의 미표시 후보가 있으면 같은 alertId를 200으로 반환합니다. 같은 회차 후보는 동시 요청에도 하나입니다.
			- 첫 회차 전이거나 현재 회차가 이미 표시됐으면 다음 예정 시각까지 409 ALERT_INTERVAL_NOT_REACHED입니다(경계 시각 정각이면 해당 회차).
			- 이전 회차의 미표시 후보는 기록으로 남지만 이후 회차에서는 반환하지 않습니다. createdAt은 실제 후보 생성 시각이며 예정 시각과 다를 수 있습니다.
			- analysisId·windowIndex는 null이며 실제 표시 확인 전에는 shownAt이 null입니다. 후보 생성은 실제 표시가 아닙니다.
			""")
	@ApiResponse(responseCode = "201", description = "현재 회차의 새 후보 생성")
	@ApiResponse(responseCode = "200", description = "현재 회차의 기존 미표시 후보 반환 (같은 alertId)")
	@ApiResponse(responseCode = "400", description = "세션 ID가 UUID 형식이 아니거나 요청 본문이 JSON 객체가 아님",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "세션 ID가 올바른 UUID 형식이 아닙니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "404", description = "세션이 존재하지 않음",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "409", description = "FIXED_INTERVAL_DISABLED: 고정 주기 방식 비활성 / SESSION_ENDED: 종료된 세션 / "
		+ "ALERT_INTERVAL_NOT_REACHED: 첫 예정 시각 전이거나 현재 회차가 이미 표시됨",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "FIXED_INTERVAL_DISABLED", value = """
				{"code": "FIXED_INTERVAL_DISABLED", "message": "고정 주기 알림이 활성화되어 있지 않습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "SESSION_ENDED", value = """
				{"code": "SESSION_ENDED", "message": "종료된 작업 세션입니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "ALERT_INTERVAL_NOT_REACHED", value = """
				{"code": "ALERT_INTERVAL_NOT_REACHED", "message": "다음 고정 주기 알림 예정 시각이 아직 되지 않았습니다.", "fieldErrors": []}""")
		}))
	@PostMapping("/fixed-interval")
	public ResponseEntity<AlertResponse> createFixedInterval(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@io.swagger.v3.oas.annotations.parameters.RequestBody(description = "없거나 {}. 내용은 사용하지 않음", required = false)
		@RequestBody(required = false) Map<String, Object> ignored
	) {
		AlertService.FixedIntervalResult result = alertService.requestFixedInterval(
			Uuids.parse(sessionId, INVALID_SESSION_ID));
		return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result.alert());
	}

	@Operation(
		summary = "실제 알림 표시 확인",
		description = """
			FE가 알림을 실제 화면에 표시한 시각(shownAt)을 기록합니다. 후보 생성·조회만으로는 기록되지 않으며 실제 알림 횟수는 shownAt이 있는 알림만 집계합니다.

			- 최초 표시 시각만 유지합니다. 같은 shownAt 재전송은 200으로 기존 결과를, 다른 시각은 409 ALERT_SHOWN_AT_CONFLICT입니다.
			- 표시할 수 없었던 시각이면 409 ALERT_NOT_DISPLAYABLE입니다: 후보 생성 시각 − 허용치보다 이른 표시, 서버 현재 시각 + 허용치보다 미래, 세션 종료 시각 + 허용치보다 늦은 표시(종료 후 표시).
			- 종료 전에 표시된 알림의 늦은 확인은 세션 종료 후에도 저장합니다. 요청 시점의 최신 구간·현재 후보 여부로 거절하지 않습니다.
			- 기록된 shownAt은 AI 반복 알림 제한에 반영됩니다. 고정 주기 예정 시각(startedAt + 간격 × n)은 shownAt으로 바뀌지 않습니다.
			""" + REPEAT_LIMIT_BASIS + """
			""" + TIME_RULES)
	@ApiResponse(responseCode = "200", description = "표시 시각 기록 또는 같은 값 재전송 (Alert 객체)")
	@ApiResponse(responseCode = "400", description = "잘못된 UUID, shownAt 누락·형식 오류·밀리초 미만 정밀도",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "요청 값이 올바르지 않습니다.", "fieldErrors": [{"field": "shownAt", "message": "표시 시각을 입력해 주세요."}]}""")))
	@ApiResponse(responseCode = "404", description = "SESSION_NOT_FOUND: 세션 없음 / ALERT_NOT_FOUND: 알림이 없거나 다른 세션 소속",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "SESSION_NOT_FOUND", value = """
				{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "ALERT_NOT_FOUND", value = """
				{"code": "ALERT_NOT_FOUND", "message": "해당 세션에서 알림을 찾을 수 없습니다.", "fieldErrors": []}""")
		}))
	@ApiResponse(responseCode = "409", description = "ALERT_SHOWN_AT_CONFLICT: 기록된 표시 시각과 다름 / ALERT_NOT_DISPLAYABLE: 표시될 수 없는 시각",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "ALERT_SHOWN_AT_CONFLICT", value = """
				{"code": "ALERT_SHOWN_AT_CONFLICT", "message": "이미 기록된 표시 시각과 다릅니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "ALERT_NOT_DISPLAYABLE", value = """
				{"code": "ALERT_NOT_DISPLAYABLE", "message": "해당 시각에 표시될 수 없는 알림입니다.", "fieldErrors": []}""")
		}))
	@PatchMapping("/{alertId}/shown")
	public AlertResponse markShown(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@Parameter(description = "알림 ID (UUID)", example = "9d2c4e71-3a8b-4f05-b6e2-1c7a9f3d5b80")
		@PathVariable String alertId,
		@Valid @RequestBody ShownRequest request
	) {
		return alertDisplayService.markShown(Uuids.parse(sessionId, INVALID_SESSION_ID),
			Uuids.parse(alertId, INVALID_ALERT_ID), request.shownAt());
	}

	@Operation(
		summary = "알림 사용자 선택 저장",
		description = """
			실제 표시된 알림에 대한 사용자 선택(RETURN_TO_GOAL 또는 CONTINUE_BROWSING)을 alertId에 연결해 저장합니다.

			- 알림당 최초 선택 1개만 유지합니다(DB UNIQUE). 최초 저장 201, 같은 action·selectedAt 재전송 200(기존 객체), 다른 선택은 409 RESPONSE_ALREADY_RECORDED입니다.
			- 표시 확인이 아직 저장되지 않았으면 요청의 shownAt이 필요하며 shownAt과 선택을 한 트랜잭션으로 저장합니다(선택 저장이 실패하면 shownAt도 남지 않음).
			  shownAt도 없으면 409 ALERT_NOT_SHOWN, 표시될 수 없는 시각이면 409 ALERT_NOT_DISPLAYABLE입니다.
			- 이미 shownAt이 저장돼 있으면 생략할 수 있고, 다른 값을 보내면 409 ALERT_SHOWN_AT_CONFLICT입니다.
			- selectedAt은 shownAt보다 앞설 수 없습니다(같은 클라이언트 시계라 허용치 없이 비교, 400). 서버 현재 시각 + 허용치보다 미래인 selectedAt도 400입니다.
			- 종료 전에 표시된 알림의 선택은 세션 종료 후에도 저장할 수 있으며, 종료 시각 뒤에 선택했더라도 저장합니다.
			- 이 요청으로 처음 기록된 shownAt도 표시 확인과 같은 기준으로 AI 반복 알림 제한에 반영됩니다.
			""" + REPEAT_LIMIT_BASIS + TIME_RULES)
	@ApiResponse(responseCode = "201", description = "최초 선택 저장")
	@ApiResponse(responseCode = "200", description = "같은 선택 재전송: 기존 객체")
	@ApiResponse(responseCode = "400", description = "잘못된 UUID, action·selectedAt 누락·형식 오류, 밀리초 미만 정밀도, selectedAt < shownAt, 미래 selectedAt",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "selectedAt은 shownAt보다 앞설 수 없습니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "404", description = "SESSION_NOT_FOUND: 세션 없음 / ALERT_NOT_FOUND: 알림이 없거나 다른 세션 소속",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "ALERT_NOT_FOUND", "message": "해당 세션에서 알림을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "409", description = "ALERT_NOT_SHOWN / RESPONSE_ALREADY_RECORDED / ALERT_SHOWN_AT_CONFLICT / ALERT_NOT_DISPLAYABLE",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "ALERT_NOT_SHOWN", value = """
				{"code": "ALERT_NOT_SHOWN", "message": "표시 시각을 확인할 수 없는 알림입니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "RESPONSE_ALREADY_RECORDED", value = """
				{"code": "RESPONSE_ALREADY_RECORDED", "message": "이 알림의 사용자 선택이 이미 저장되었습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "ALERT_SHOWN_AT_CONFLICT", value = """
				{"code": "ALERT_SHOWN_AT_CONFLICT", "message": "이미 기록된 표시 시각과 다릅니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "ALERT_NOT_DISPLAYABLE", value = """
				{"code": "ALERT_NOT_DISPLAYABLE", "message": "해당 시각에 표시될 수 없는 알림입니다.", "fieldErrors": []}""")
		}))
	@PostMapping("/{alertId}/responses")
	public ResponseEntity<NotificationResponseResponse> respond(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@Parameter(description = "알림 ID (UUID)", example = "9d2c4e71-3a8b-4f05-b6e2-1c7a9f3d5b80")
		@PathVariable String alertId,
		@Valid @RequestBody AlertResponseRequest request
	) {
		AlertDisplayService.ResponseResult result = alertDisplayService.respond(Uuids.parse(sessionId, INVALID_SESSION_ID),
			Uuids.parse(alertId, INVALID_ALERT_ID), request);
		return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result.response());
	}
}

package com.focusrecovery.domain.visit.controller;

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

import com.focusrecovery.domain.visit.dto.CreatePageVisitRequest;
import com.focusrecovery.domain.visit.dto.PageVisitPageResponse;
import com.focusrecovery.domain.visit.dto.PageVisitResponse;
import com.focusrecovery.domain.visit.dto.UpdateVisitBehaviorRequest;
import com.focusrecovery.domain.visit.dto.VisitBehaviorResponse;
import com.focusrecovery.domain.visit.service.PageVisitService;
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

@Tag(name = "페이지 방문 기록", description = "작업 세션의 페이지 방문 저장·행동 정보 갱신·목록 조회 API")
@RestController
@RequestMapping("/api/sessions/{sessionId}/visits")
public class PageVisitController {

	private static final String INVALID_SESSION_ID = "세션 ID가 올바른 UUID 형식이 아닙니다.";

	private final PageVisitService pageVisitService;

	public PageVisitController(PageVisitService pageVisitService) {
		this.pageVisitService = pageVisitService;
	}

	@Operation(
		summary = "방문 기록 저장",
		description = """
			페이지 방문 하나를 저장합니다. visitId는 FE가 발급하며 재전송 시 같은 값을 보냅니다.

			- 새 방문은 ACTIVE 세션에만 저장되며 201을 반환합니다.
			- 같은 visitId + 같은 원본 정보(sessionId, sequence, browserTabKey, normalizedUrl, domain, title, content, searchQuery, isSearchResultPage, visitedAt)로 재전송하면 저장된 방문을 200으로 반환합니다.
			  이때 이미 갱신된 행동 정보와 updatedAt은 바뀌지 않습니다. 종료된 세션에서도 재전송 응답은 그대로 반환합니다.
			- normalizedUrl은 FE가 정규화한 주소여야 합니다: http/https 스킴(대소문자 무관), 소문자 호스트, 기본 포트(http:80, https:443)·인증정보·Query·Fragment 없음.
			  예) 원본 `https://Example.com:443/docs/JWT?ref=home#intro` → `https://example.com/docs/JWT`. 서버는 변환하지 않고 검증만 하며, 정규화되지 않은 주소는 400입니다.
			- domain은 normalizedUrl의 전체 호스트명(서브도메인 포함, 포트 제외)과 같아야 합니다. 예) `https://docs.spring.io:8443/a` → `docs.spring.io`. 다르면 400입니다.
			- title, content, searchQuery는 생략하거나 null로 보낼 수 있습니다. isSearchResultPage 생략 시 false, tabSwitchCount·behaviorVersion 생략 시 0입니다.
			- activeDurationMs는 필수이며 1000ms(1초) 이상이어야 합니다. 유효 방문 판정은 FE가 하고 서버는 최소 체류시간만 다시 검증합니다.
			- content는 FE가 추출한 본문이며 최대 5,000 Unicode code points입니다. 초과하면 서버가 자르지 않고 400을 반환합니다.
			- visitedAt은 밀리초까지 저장되며, 응답은 UTC ISO 8601(밀리초) 형식입니다.

			**탐색 구간 자동 생성 (응답 형식은 변경 없음)**
			- 새 방문이 저장(201)되면 같은 트랜잭션에서 분석 구간을 만듭니다. 구간은 같은 세션에 저장된 유효 방문을 sequence 오름차순으로 정렬해 5개씩 묶고 한 칸씩 이동합니다(Window Size=5, Stride=1).
			- sequence는 FE가 방문 후보 발생 순서로 매기는 번호이며, 제외된 후보의 번호는 비어 있는 것이 정상입니다. 서버는 숫자 연속성을 검사하지 않고 빠진 번호를 기다리지 않습니다.
			  예) 1,3,4,5,6 저장 시 구간 1=[1,3,4,5,6], 이후 8 저장 시 구간 2=[3,4,5,6,8]. 유효 방문 1~4개까지는 구간이 없습니다.
			- 구간 번호(windowIndex)는 sequence와 별개로 세션별 구간 생성 순서대로 1, 2, 3…입니다.
			- FE는 앞선 방문의 저장 성공(ACK)을 확인한 뒤 다음 방문을 보냅니다. 첫 구간이 생기기 전에는 도착 순서와 관계없이 sequence 순으로 정렬해 구간을 만듭니다.
			- 이미 만든 구간은 다시 구성하지 않습니다. 구간이 생긴 뒤 마지막 구간의 끝 방문보다 작은 sequence의 새 방문은 409 VISIT_SEQUENCE_OUT_OF_ORDER이며 방문과 구간 모두 저장·변경되지 않습니다.
			  예) 구간 [1,3,4,7,9] 생성 후 새 방문 5는 409, 10은 201(다음 구간 [3,4,7,9,10]). 이미 저장된 같은 방문의 재전송은 sequence와 관계없이 200입니다.
			- 오류 판정 순서: 같은 방문 재전송(200) → VISIT_ID_CONFLICT → VISIT_SEQUENCE_CONFLICT → SESSION_ENDED → VISIT_SEQUENCE_OUT_OF_ORDER.
			- 재전송(200), 409, 400 응답에서는 구간이 생성되거나 바뀌지 않습니다. 종료된 세션에는 구간이 생기지 않습니다.
			""")
	@ApiResponse(responseCode = "201", description = "새 방문 저장 (필요한 탐색 구간도 함께 생성)")
	@ApiResponse(responseCode = "200", description = "같은 방문 재전송: 저장된 방문 반환")
	@ApiResponse(responseCode = "400", description = "잘못된 UUID, 필수값 누락, 음수, activeDurationMs 누락·1000ms 미만, 본문(content) 5,000 Unicode code points 초과, "
		+ "정규화되지 않은 주소(http/https가 아닌 스킴, 호스트 없음·대문자, 기본 포트, 인증정보, Query·Fragment 포함, URL 문법 오류), "
		+ "domain과 normalizedUrl 호스트명 불일치",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "요청 값이 올바르지 않습니다.",
			 "fieldErrors": [{"field": "activeDurationMs", "message": "체류시간은 1000ms(1초) 이상이어야 합니다."}]}""")))
	@ApiResponse(responseCode = "404", description = "세션이 존재하지 않음",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "409", description = "SESSION_ENDED: 종료된 세션에 새 방문 저장 / "
		+ "VISIT_ID_CONFLICT: 같은 visitId에 다른 원본 정보 / VISIT_SEQUENCE_CONFLICT: 같은 세션의 sequence에 다른 visitId / "
		+ "VISIT_SEQUENCE_OUT_OF_ORDER: 마지막 탐색 구간의 끝 방문보다 작은 sequence의 새 방문",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "SESSION_ENDED", value = """
				{"code": "SESSION_ENDED", "message": "종료된 작업 세션입니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "VISIT_ID_CONFLICT", value = """
				{"code": "VISIT_ID_CONFLICT", "message": "같은 방문 ID로 다른 방문 정보가 전달되었습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "VISIT_SEQUENCE_CONFLICT", value = """
				{"code": "VISIT_SEQUENCE_CONFLICT", "message": "같은 세션의 방문 순서가 이미 다른 방문에 사용되었습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "VISIT_SEQUENCE_OUT_OF_ORDER", value = """
				{"code": "VISIT_SEQUENCE_OUT_OF_ORDER", "message": "마지막 탐색 구간보다 앞선 순서의 새 방문은 저장할 수 없습니다.", "fieldErrors": []}""")
		}))
	@PostMapping
	public ResponseEntity<PageVisitResponse> save(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@Valid @RequestBody CreatePageVisitRequest request
	) {
		PageVisitService.SaveResult result = pageVisitService.save(Uuids.parse(sessionId, INVALID_SESSION_ID), request);
		return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result.visit());
	}

	@Operation(
		summary = "방문 행동 정보 갱신",
		description = """
			방문의 누적 체류시간·탭 전환 횟수를 갱신합니다. 값은 모두 누적값이며 behaviorVersion을 갱신마다 증가시켜 보냅니다.

			- 높은 버전이고 누적값이 줄지 않으면 반영하고 applied=true를 반환합니다. updatedAt은 서버 시각으로 기록됩니다.
			- 낮은 버전은 무시하고 현재 값과 applied=false를 반환합니다.
			- 같은 버전·같은 값은 변경 없이 applied=false를 반환합니다.
			- 같은 버전·다른 값, 높은 버전에서 누적값 감소는 409입니다.
			- 동시에 여러 갱신이 와도 낮은 버전이 높은 버전의 값을 덮어쓰지 않습니다.
			""")
	@ApiResponse(responseCode = "200", description = "처리 결과와 서버에 저장된 현재 값")
	@ApiResponse(responseCode = "400", description = "잘못된 UUID, 필수값 누락, 음수",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "요청 값이 올바르지 않습니다.",
			 "fieldErrors": [{"field": "activeDurationMs", "message": "체류시간은 0 이상이어야 합니다."}]}""")))
	@ApiResponse(responseCode = "404", description = "SESSION_NOT_FOUND: 세션 없음 / VISIT_NOT_FOUND: 해당 세션에 없는 방문",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "SESSION_NOT_FOUND", value = """
				{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "VISIT_NOT_FOUND", value = """
				{"code": "VISIT_NOT_FOUND", "message": "해당 세션에서 방문 기록을 찾을 수 없습니다.", "fieldErrors": []}""")
		}))
	@ApiResponse(responseCode = "409", description = "SESSION_ENDED: 종료된 세션 / "
		+ "BEHAVIOR_VERSION_CONFLICT: 같은 버전에 다른 값 / BEHAVIOR_COUNTER_DECREASED: 높은 버전에서 누적값 감소",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = {
			@ExampleObject(name = "SESSION_ENDED", value = """
				{"code": "SESSION_ENDED", "message": "종료된 작업 세션입니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "BEHAVIOR_VERSION_CONFLICT", value = """
				{"code": "BEHAVIOR_VERSION_CONFLICT", "message": "같은 행동 갱신 버전에 다른 값이 전달되었습니다.", "fieldErrors": []}"""),
			@ExampleObject(name = "BEHAVIOR_COUNTER_DECREASED", value = """
				{"code": "BEHAVIOR_COUNTER_DECREASED", "message": "더 높은 버전에서 누적값이 감소했습니다.", "fieldErrors": []}""")
		}))
	@PatchMapping("/{visitId}/behavior")
	public VisitBehaviorResponse updateBehavior(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@Parameter(description = "방문 ID (UUID)", example = "7d3f8a2e-1c4b-4f6a-9e2d-5b8c0a1f3e47")
		@PathVariable String visitId,
		@Valid @RequestBody UpdateVisitBehaviorRequest request
	) {
		return pageVisitService.updateBehavior(
			Uuids.parse(sessionId, INVALID_SESSION_ID),
			Uuids.parse(visitId, "방문 ID가 올바른 UUID 형식이 아닙니다."),
			request);
	}

	@Operation(summary = "방문 기록 목록 조회",
		description = "세션의 방문 기록을 sequence 오름차순으로 조회합니다. 목록 항목에는 content가 포함되지 않습니다. 기록이 없으면 빈 목록을 반환합니다.")
	@ApiResponse(responseCode = "200", description = "조회 성공")
	@ApiResponse(responseCode = "400", description = "잘못된 UUID 또는 페이지네이션 값",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "INVALID_REQUEST", "message": "size는 1 이상 100 이하여야 합니다.", "fieldErrors": []}""")))
	@ApiResponse(responseCode = "404", description = "세션이 존재하지 않음",
		content = @Content(schema = @Schema(implementation = ErrorResponse.class), examples = @ExampleObject(value = """
			{"code": "SESSION_NOT_FOUND", "message": "작업 세션을 찾을 수 없습니다.", "fieldErrors": []}""")))
	@GetMapping
	public PageVisitPageResponse list(
		@Parameter(description = "작업 세션 ID (UUID)", example = "1ba72f77-c166-4e06-88c7-1d6ed919cd9b")
		@PathVariable String sessionId,
		@Parameter(description = "페이지 번호 (0부터)", example = "0")
		@RequestParam(defaultValue = "0") int page,
		@Parameter(description = "페이지 크기 (1~100)", example = "20")
		@RequestParam(defaultValue = "20") int size
	) {
		Pages.validate(page, size);
		return pageVisitService.list(Uuids.parse(sessionId, INVALID_SESSION_ID), page, size);
	}
}

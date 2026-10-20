package com.focusrecovery.domain.analysis.client;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.DateTimeException;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

// AI-API-01(POST /api/ai/analyses) 잠정 구현. AI 담당자와 합의한 최종 계약이 아니다
@Component
public class AiAnalysisClient {

	static final String UNAVAILABLE = "AI_UNAVAILABLE";
	static final String TIMEOUT = "AI_TIMEOUT";
	static final String INVALID_RESPONSE = "AI_INVALID_RESPONSE";
	// AI-API-01에 정의된 AI 서버 오류 코드: 오류 응답에 이 코드가 있으면 그대로 기록한다
	private static final Set<String> AI_ERROR_CODES = Set.of(
		"INVALID_REQUEST", "ANALYSIS_ID_CONFLICT", "ANALYSIS_IN_PROGRESS", "AI_ANALYSIS_FAILED", "AI_NOT_READY");
	private static final Set<String> RESULTS = Set.of("NORMAL", "TRANSITION", "DRIFT");
	private static final Pattern UTC_MILLIS = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z");

	private final AiProperties properties;
	private final JsonMapper jsonMapper;
	private final HttpClient httpClient;

	public AiAnalysisClient(AiProperties properties, JsonMapper jsonMapper) {
		this.properties = properties;
		this.jsonMapper = jsonMapper;
		// 기본값(HTTP_2)은 평문 http에서 h2c 업그레이드 헤더(Upgrade·HTTP2-Settings)를 보내 AI 서버(uvicorn)와 호환되지 않으므로 HTTP/1.1로 고정한다
		this.httpClient = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.connectTimeout(properties.connectTimeout())
			.build();
	}

	public AiAnalysisOutcome analyze(String requestBody, UUID analysisId, UUID sessionId, UUID windowId) {
		HttpRequest request = HttpRequest.newBuilder(properties.baseUrl().resolve("/api/ai/analyses"))
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(requestBody))
			.build();
		CompletableFuture<HttpResponse<String>> future = httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString());
		HttpResponse<String> response;
		try {
			// 응답 본문 수신까지 포함한 전체 대기 한도
			response = future.get(properties.responseTimeout().toMillis(), TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			future.cancel(true);
			return AiAnalysisOutcome.failed(TIMEOUT);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			return AiAnalysisOutcome.failed(UNAVAILABLE);
		} catch (ExecutionException e) {
			return AiAnalysisOutcome.failed(e.getCause() instanceof HttpTimeoutException ? TIMEOUT : UNAVAILABLE);
		}
		if (response.statusCode() != 200) {
			return AiAnalysisOutcome.failed(errorCodeOf(response.body()));
		}
		try {
			return validate(jsonMapper.readTree(response.body()), analysisId, sessionId, windowId);
		} catch (JacksonException | IllegalArgumentException | DateTimeException e) {
			// 잘못된 UUID(IllegalArgumentException), 형식은 맞지만 존재하지 않는 analyzedAt(DateTimeParseException)도 잘못된 응답이다
			return AiAnalysisOutcome.failed(INVALID_RESPONSE);
		}
	}

	private String errorCodeOf(String body) {
		try {
			JsonNode code = jsonMapper.readTree(body).get("code");
			if (code != null && code.isString() && AI_ERROR_CODES.contains(code.stringValue())) {
				return code.stringValue();
			}
		} catch (JacksonException e) {
			// 본문이 JSON이 아니면 아래에서 잘못된 응답으로 기록한다
		}
		return INVALID_RESPONSE;
	}

	// 확률 최댓값과 result의 일치는 검사하지 않는다: DRIFT는 임계값 τ로 판정하므로 BE가 재현할 수 없다
	private AiAnalysisOutcome validate(JsonNode body, UUID analysisId, UUID sessionId, UUID windowId) {
		if (!body.isObject()
			|| !sameId(body.get("analysisId"), analysisId)
			|| !sameId(body.get("sessionId"), sessionId)
			|| !sameId(body.get("windowId"), windowId)) {
			return AiAnalysisOutcome.failed(INVALID_RESPONSE);
		}
		JsonNode result = body.get("result");
		Double pNormal = probability(body.get("pNormal"));
		Double pTransition = probability(body.get("pTransition"));
		Double pDrift = probability(body.get("pDrift"));
		JsonNode contextUsed = body.get("contextUsed");
		JsonNode analyzedAt = body.get("analyzedAt");
		if (result == null || !result.isString() || !RESULTS.contains(result.stringValue())
			|| pNormal == null || pTransition == null || pDrift == null
			|| Math.abs(pNormal + pTransition + pDrift - 1.0) > properties.probabilitySumTolerance()
			|| contextUsed == null || !contextUsed.isBoolean()
			|| !objectOrNull(body.get("contextResult")) || !objectOrNull(body.get("featureSnapshot"))
			|| !validModelVersions(body.get("modelVersions"))
			|| analyzedAt == null || !analyzedAt.isString() || !UTC_MILLIS.matcher(analyzedAt.stringValue()).matches()) {
			return AiAnalysisOutcome.failed(INVALID_RESPONSE);
		}
		return new AiAnalysisOutcome(null, result.stringValue(), pNormal, pTransition, pDrift, contextUsed.booleanValue(),
			jsonOrNull(body.get("contextResult")), jsonOrNull(body.get("featureSnapshot")),
			jsonMapper.writeValueAsString(body.get("modelVersions")), Instant.parse(analyzedAt.stringValue()));
	}

	private static boolean sameId(JsonNode node, UUID expected) {
		return node != null && node.isString() && expected.equals(UUID.fromString(node.stringValue()));
	}

	private static Double probability(JsonNode node) {
		if (node == null || !node.isNumber()) {
			return null;
		}
		double value = node.doubleValue();
		return Double.isFinite(value) && value >= 0 && value <= 1 ? value : null;
	}

	private static boolean objectOrNull(JsonNode node) {
		return node == null || node.isNull() || node.isObject();
	}

	// 모델명과 버전 문자열을 가진 비어 있지 않은 객체
	private static boolean validModelVersions(JsonNode node) {
		if (node == null || !node.isObject() || node.isEmpty()) {
			return false;
		}
		for (Map.Entry<String, JsonNode> entry : node.properties()) {
			if (!entry.getValue().isString() || entry.getValue().stringValue().isBlank()) {
				return false;
			}
		}
		return true;
	}

	private String jsonOrNull(JsonNode node) {
		return node == null || node.isNull() ? null : jsonMapper.writeValueAsString(node);
	}
}

package com.focusrecovery.global.config;

import static org.hamcrest.Matchers.allOf;
import static org.hamcrest.Matchers.containsInAnyOrder;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class OpenApiDocsTest {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void OpenAPI_문서에_세션_API가_포함된다() throws Exception {
		mockMvc.perform(get("/v3/api-docs"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.info.title").value("Focus Recovery API"))
			.andExpect(jsonPath("$.paths['/api/sessions'].post.parameters[0].name").value("Idempotency-Key"))
			.andExpect(jsonPath("$.paths['/api/sessions'].post.responses['422']").exists())
			.andExpect(jsonPath("$.paths['/api/sessions'].post.responses['404']").doesNotExist())
			.andExpect(jsonPath("$.paths['/api/sessions/{sessionId}'].get.responses['404']").exists())
			.andExpect(jsonPath("$.paths['/api/sessions/{sessionId}'].get.responses['422']").doesNotExist());
	}

	// 분석 상태 조회는 최신 완료 결과를 알림 근거로 오해하지 않도록 사용 규칙을 문서에 담는다
	@Test
	void OpenAPI_문서에_분석_상태_조회의_알림_사용_규칙이_포함된다() throws Exception {
		mockMvc.perform(get("/v3/api-docs"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.paths['/api/sessions/{sessionId}/analysis-status'].get.description",
				allOf(containsString("참고 결과"), containsString("구간 3의 결과로 새 알림을 표시하면 안 됩니다"),
					containsString("windowIndex가 같다는 것만으로 알림을 허용하면 안 됩니다"),
					containsString("ACTIVE인지와 alertId 중복"), containsString("아직 표시되지 않은 후보만"),
					containsString("이전 구간의 후보는 반환하지 않습니다"))))
			.andExpect(jsonPath("$.components.schemas.AnalysisStatusResponse.properties.latestCompletedAnalysis.description",
				containsString("알림 표시 허용을 의미하지 않는다")))
			.andExpect(jsonPath("$.components.schemas.AnalysisStatusResponse.properties.alert.description",
				containsString("미표시 후보만")));
	}

	// 분석 상세의 JSON 필드는 문자열이 아니라 객체 또는 null로 문서화되고, JsonNode 내부 구조가 노출되지 않아야 한다
	@Test
	void OpenAPI_문서의_분석_상세_JSON_필드는_객체_또는_null_타입이다() throws Exception {
		String base = "$.components.schemas.AnalysisDetailResponse.properties.";
		var result = mockMvc.perform(get("/v3/api-docs")).andExpect(status().isOk());
		for (String field : new String[] {"contextResult", "inputSnapshot", "featureSnapshot", "modelVersions"}) {
			result.andExpect(jsonPath(base + field + ".type", containsInAnyOrder("object", "null")))
				.andExpect(jsonPath(base + field + ".$ref").doesNotExist())
				.andExpect(jsonPath(base + field + ".properties").doesNotExist());
		}
		result.andExpect(jsonPath("$.components.schemas.JsonNode").doesNotExist());
	}
}

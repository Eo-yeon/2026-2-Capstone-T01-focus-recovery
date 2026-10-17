package com.focusrecovery.domain.analysis.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import com.focusrecovery.global.exception.StoredDataException;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

// DB(MySQL·H2 JSON 컬럼)는 문법이 깨진 JSON을 저장하지 않으므로 그 경우는 파서 단위에서 검증한다
class StoredJsonReaderTest {

	private final JsonMapper jsonMapper = JsonMapper.builder().build();
	private final StoredJsonReader reader = new StoredJsonReader(jsonMapper);
	private final UUID analysisId = UUID.randomUUID();

	@Test
	void 객체는_내용을_그대로_반환하고_null은_null을_반환한다() {
		String stored = "{\"a\":{\"b\":[1,{\"c\":null}],\"d\":\"{\\\"x\\\":1}\"},\"e\":0.10}";

		JsonNode node = reader.objectOrNull(stored, analysisId, "contextResult");

		assertThat(node).isEqualTo(jsonMapper.readTree(stored));
		assertThat(node.get("a").get("d").isString()).isTrue();
		assertThat(reader.objectOrNull(null, analysisId, "contextResult")).isNull();
		assertThat(reader.objectOrNull("null", analysisId, "contextResult")).isNull();
		assertThat(reader.objectOrNull("{}", analysisId, "contextResult")).isEqualTo(jsonMapper.createObjectNode());
	}

	@ParameterizedTest
	@ValueSource(strings = {"{\"secret\":\"RAW-VALUE\"", "{RAW-VALUE}", "RAW-VALUE", "", "   ", "{\"a\":1} trailing"})
	void 문법이_깨진_JSON은_저장_원문_없이_저장_데이터_오류로_처리한다(String stored) {
		assertThatThrownBy(() -> reader.objectOrNull(stored, analysisId, "featureSnapshot"))
			.isInstanceOf(StoredDataException.class)
			.hasMessageContaining(analysisId.toString())
			.hasMessageContaining("featureSnapshot")
			.hasNoCause()
			.satisfies(e -> assertThat(e.getMessage()).doesNotContain("RAW-VALUE").doesNotContain("secret"));
	}

	@ParameterizedTest
	@ValueSource(strings = {"[\"RAW-VALUE\"]", "\"RAW-VALUE\"", "42", "true", "0.5"})
	void 최상위_값이_객체가_아니면_저장_데이터_오류로_처리한다(String stored) {
		assertThatThrownBy(() -> reader.objectOrNull(stored, analysisId, "modelVersions"))
			.isInstanceOf(StoredDataException.class)
			.hasMessageContaining("객체가 아닙니다")
			.satisfies(e -> assertThat(e.getMessage()).doesNotContain("RAW-VALUE"));
	}
}

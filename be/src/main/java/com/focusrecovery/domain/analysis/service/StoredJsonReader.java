package com.focusrecovery.domain.analysis.service;

import java.util.UUID;

import org.springframework.stereotype.Component;

import com.focusrecovery.global.exception.StoredDataException;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

// 분석 JSON 컬럼을 응답용으로 읽는다. API 계약은 최상위 값이 객체 또는 null인 것까지만 정하고,
// AI 세부 출력 구조는 협의 중이라 내부 구조는 검사하지 않는다. 읽기만 하며 DB에 다시 저장하지 않는다
@Component
public class StoredJsonReader {

	private final JsonMapper jsonMapper;

	public StoredJsonReader(JsonMapper jsonMapper) {
		this.jsonMapper = jsonMapper;
	}

	public JsonNode objectOrNull(String stored, UUID analysisId, String field) {
		if (stored == null) {
			return null;
		}
		JsonNode node;
		try {
			node = jsonMapper.readTree(stored);
		} catch (JacksonException e) {
			// 예외 원문에는 저장 값 일부가 담길 수 있어 원인으로 붙이지 않는다
			throw new StoredDataException("분석 JSON을 읽을 수 없습니다. analysisId=" + analysisId + " field=" + field);
		}
		if (node == null || node.isMissingNode()) {
			throw new StoredDataException("분석 JSON이 비어 있습니다. analysisId=" + analysisId + " field=" + field);
		}
		if (node.isNull()) {
			return null;
		}
		if (!node.isObject()) {
			throw new StoredDataException("분석 JSON 최상위 값이 객체가 아닙니다(" + node.getNodeType() + "). analysisId="
				+ analysisId + " field=" + field);
		}
		return node;
	}
}

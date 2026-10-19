package com.focusrecovery.global.validation;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import jakarta.validation.Validation;

class CodePointLengthTest {

	private record Input(@CodePointLength(max = 2) String content) {
	}

	@ParameterizedTest
	@NullAndEmptySource
	@ValueSource(strings = {"a", "한😀", "😀𐐀"})
	void 설정한_code_point_한도와_null을_허용한다(String content) {
		try (var factory = Validation.buildDefaultValidatorFactory()) {
			assertThat(factory.getValidator().validate(new Input(content))).isEmpty();
		}
	}

	@Test
	void 한도를_넘으면_필드와_설정한_길이를_반환한다() {
		try (var factory = Validation.buildDefaultValidatorFactory()) {
			var violations = factory.getValidator().validate(new Input("한😀𐐀"));
			assertThat(violations).singleElement().satisfies(violation -> {
				assertThat(violation.getPropertyPath().toString()).isEqualTo("content");
				assertThat(violation.getMessage()).isEqualTo("Unicode code points는 2개 이하여야 합니다.");
			});
		}
	}
}

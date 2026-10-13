package com.focusrecovery.global.validation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;

/**
 * docs/data-collection-spec.md의 URL 정규화 규칙을 따른 주소인지 검사만 한다(값을 변환하지 않는다). null은 다른 제약에 맡긴다.
 * http/https 스킴(대소문자 무관), 소문자 호스트, 기본 포트·인증정보·Query·Fragment 없음.
 */
@Target({ElementType.FIELD, ElementType.RECORD_COMPONENT, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = NormalizedUrl.Validator.class)
public @interface NormalizedUrl {

	String message() default "정규화된 HTTP/HTTPS 주소가 아닙니다.";

	Class<?>[] groups() default {};

	Class<? extends Payload>[] payload() default {};

	class Validator implements ConstraintValidator<NormalizedUrl, String> {

		@Override
		public boolean isValid(String value, ConstraintValidatorContext context) {
			if (value == null) {
				return true;
			}
			String violation = findViolation(value);
			if (violation == null) {
				return true;
			}
			context.disableDefaultConstraintViolation();
			context.buildConstraintViolationWithTemplate(violation).addConstraintViolation();
			return false;
		}

		static String findViolation(String value) {
			URI uri;
			try {
				uri = new URI(value);
			} catch (URISyntaxException e) {
				return "페이지 주소의 형식이 올바르지 않습니다.";
			}
			String scheme = uri.getScheme();
			boolean http = "http".equalsIgnoreCase(scheme);
			boolean https = "https".equalsIgnoreCase(scheme);
			// getHost()는 호스트가 없거나(https:///path) 호스트 형식이 잘못되면 null이다
			if (!(http || https) || uri.getHost() == null) {
				return "페이지 주소는 호스트가 있는 http 또는 https 주소여야 합니다.";
			}
			if (uri.getRawUserInfo() != null) {
				return "페이지 주소에 인증정보를 포함할 수 없습니다.";
			}
			if (!uri.getHost().equals(uri.getHost().toLowerCase(Locale.ROOT))) {
				return "페이지 주소의 호스트는 소문자여야 합니다.";
			}
			// "host:"처럼 비어 있는 포트 표기도 정규화되지 않은 형태다
			if ((http && uri.getPort() == 80) || (https && uri.getPort() == 443) || uri.getRawAuthority().endsWith(":")) {
				return "페이지 주소에서 기본 포트를 제거해야 합니다.";
			}
			// 빈 Query("?")·빈 Fragment("#")도 제거 대상이다
			if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
				return "페이지 주소에서 Query와 Fragment를 제거해야 합니다.";
			}
			return null;
		}
	}
}

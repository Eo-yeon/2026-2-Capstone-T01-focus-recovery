package com.focusrecovery.global.validation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.net.URI;
import java.net.URISyntaxException;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;

/**
 * 스킴이 http/https(대소문자 무관)이고 호스트가 있는 절대 URL인지 검사한다. null은 다른 제약에 맡긴다.
 */
@Target({ElementType.FIELD, ElementType.RECORD_COMPONENT, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = HttpUrl.Validator.class)
public @interface HttpUrl {

	String message() default "올바른 HTTP/HTTPS 주소가 아닙니다.";

	Class<?>[] groups() default {};

	Class<? extends Payload>[] payload() default {};

	class Validator implements ConstraintValidator<HttpUrl, String> {

		@Override
		public boolean isValid(String value, ConstraintValidatorContext context) {
			if (value == null) {
				return true;
			}
			try {
				URI uri = new URI(value);
				String scheme = uri.getScheme();
				// getHost()는 호스트가 없거나(https:///path) 호스트 형식이 잘못되면 null이다
				return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) && uri.getHost() != null;
			} catch (URISyntaxException e) {
				return false;
			}
		}
	}
}

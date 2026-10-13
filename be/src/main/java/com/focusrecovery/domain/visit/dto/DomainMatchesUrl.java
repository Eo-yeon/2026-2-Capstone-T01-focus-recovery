package com.focusrecovery.domain.visit.dto;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.net.URI;

import com.focusrecovery.global.validation.NormalizedUrl;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;

/**
 * domain이 normalizedUrl의 전체 호스트명(서브도메인 포함, 포트 제외)과 같은지 검사한다. FE의 URL.hostname과 같은 값이다.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = DomainMatchesUrl.Validator.class)
public @interface DomainMatchesUrl {

	String message() default "도메인은 페이지 주소의 호스트명과 같아야 합니다.";

	Class<?>[] groups() default {};

	Class<? extends Payload>[] payload() default {};

	class Validator implements ConstraintValidator<DomainMatchesUrl, CreatePageVisitRequest> {

		@Override
		public boolean isValid(CreatePageVisitRequest request, ConstraintValidatorContext context) {
			String url = request.normalizedUrl();
			String domain = request.domain();
			// 주소나 도메인 자체가 잘못된 경우는 각 필드 검증의 오류만 보여준다
			if (url == null || NormalizedUrl.Validator.findViolation(url) != null
				|| domain == null || domain.isBlank() || domain.length() > 255) {
				return true;
			}
			if (domain.equals(URI.create(url).getHost())) {
				return true;
			}
			context.disableDefaultConstraintViolation();
			context.buildConstraintViolationWithTemplate(context.getDefaultConstraintMessageTemplate())
				.addPropertyNode("domain")
				.addConstraintViolation();
			return false;
		}
	}
}

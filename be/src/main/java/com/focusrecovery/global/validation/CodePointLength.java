package com.focusrecovery.global.validation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;

/** UTF-16 code units가 아닌 Unicode code points의 최대 개수를 검사한다. null은 다른 제약에 맡긴다. */
@Target({ElementType.FIELD, ElementType.RECORD_COMPONENT, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = CodePointLength.Validator.class)
public @interface CodePointLength {

	int max();

	String message() default "Unicode code points는 {max}개 이하여야 합니다.";

	Class<?>[] groups() default {};

	Class<? extends Payload>[] payload() default {};

	class Validator implements ConstraintValidator<CodePointLength, String> {

		private int max;

		@Override
		public void initialize(CodePointLength constraint) {
			max = constraint.max();
		}

		@Override
		public boolean isValid(String value, ConstraintValidatorContext context) {
			return value == null || value.codePointCount(0, value.length()) <= max;
		}
	}
}

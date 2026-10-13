package com.focusrecovery.global.util;

import java.util.UUID;
import java.util.regex.Pattern;

import com.focusrecovery.global.exception.InvalidRequestException;

public final class Uuids {

	// UUID.fromString은 "1-1-1-1-1" 같은 비표준 형식도 허용하므로 8-4-4-4-12 형식을 직접 검사한다
	public static final String REGEX =
		"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

	private static final Pattern PATTERN = Pattern.compile(REGEX);

	private Uuids() {
	}

	public static UUID parse(String value, String message) {
		if (!PATTERN.matcher(value).matches()) {
			throw new InvalidRequestException(message);
		}
		return UUID.fromString(value);
	}
}

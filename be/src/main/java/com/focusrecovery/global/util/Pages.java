package com.focusrecovery.global.util;

import com.focusrecovery.global.exception.InvalidRequestException;

public final class Pages {

	private Pages() {
	}

	// 목록 API 공통 page·size 검증 (page 0 이상, size 1~100)
	public static void validate(int page, int size) {
		if (page < 0) {
			throw new InvalidRequestException("page는 0 이상이어야 합니다.");
		}
		if (size < 1 || size > 100) {
			throw new InvalidRequestException("size는 1 이상 100 이하여야 합니다.");
		}
		// 조회 offset(page * size)이 int 범위를 넘으면 DB 조회에서 오류가 나므로 미리 거절한다
		if ((long) page * size > Integer.MAX_VALUE) {
			throw new InvalidRequestException("page가 너무 큽니다.");
		}
	}
}

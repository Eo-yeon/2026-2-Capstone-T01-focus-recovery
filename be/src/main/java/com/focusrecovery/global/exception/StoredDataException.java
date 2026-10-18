package com.focusrecovery.global.exception;

// 저장된 데이터가 API 계약과 맞지 않는 서버 측 오류. 메시지는 로그용이며 응답에는 내보내지 않는다
public class StoredDataException extends RuntimeException {

	public StoredDataException(String message) {
		super(message);
	}
}

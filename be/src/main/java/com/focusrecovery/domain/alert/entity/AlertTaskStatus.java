package com.focusrecovery.domain.alert.entity;

// PENDING: 처리 대기(재시도 대기 포함) / RUNNING: 처리 중 / CREATED: 후보 생성(또는 이미 존재) /
// SKIPPED: 정책 조건 미충족으로 건너뜀(오류 아님) / FAILED: 오류로 재시도를 모두 소진
public enum AlertTaskStatus {
	PENDING, RUNNING, CREATED, SKIPPED, FAILED
}

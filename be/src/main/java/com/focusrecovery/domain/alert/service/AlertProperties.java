package com.focusrecovery.domain.alert.service;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

import com.focusrecovery.domain.alert.entity.AlertType;

// 서버 전체 설정을 쓰는 잠정 구현이다. 세션별 방식 선택은 아직 지원하지 않는다.
// 실행 중에 바꾸지 않으며, 모드 전환은 진행 중인 세션을 모두 종료한 뒤 서버를 재시작하는 운영을 전제로 한다
@ConfigurationProperties("focus-recovery.alert")
public record AlertProperties(AlertType mode, Ai ai, FixedInterval fixedInterval, Task task) {

	// minInterval: 마지막으로 실제 표시된 AI 알림의 shownAt부터 새 AI 후보까지의 최소 간격(잠정)
	public record Ai(Duration minInterval) {
	}

	// interval: 고정 주기 예정 시각 startedAt + interval × n(n ≥ 1)의 간격(잠정). shownAt으로 다시 계산하지 않는다
	public record FixedInterval(Duration interval) {
	}

	// AI 후보 처리 작업 복구: interval마다 누락 작업 등록·멈춘 작업 복구·대기 작업 처리.
	// 오류는 maxAttempts회까지 initialDelay부터 두 배씩(최대 maxDelay) 늦춰 재시도한다. AI는 다시 호출하지 않는다
	public record Task(Duration interval, int maxAttempts, Duration initialDelay, Duration maxDelay,
		Duration runningTimeout) {
	}
}

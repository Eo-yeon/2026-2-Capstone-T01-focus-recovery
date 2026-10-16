package com.focusrecovery.domain.analysis.service;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("focus-recovery.analysis")
public record AnalysisProperties(Executor executor, Recovery recovery) {

	// 분석 전용 실행기: 동시에 AI를 호출하는 스레드 수와 대기 큐 크기
	public record Executor(int poolSize, int queueCapacity) {
	}

	// 미완료 분석 복구: interval마다 기준 시각에서 제한 시간을 넘긴 PENDING·RUNNING을 FAILED로 확정한다
	public record Recovery(Duration interval, Duration pendingTimeout, Duration runningTimeout) {
	}
}

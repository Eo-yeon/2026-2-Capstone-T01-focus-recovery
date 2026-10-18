package com.focusrecovery.domain.alert.service;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

import com.focusrecovery.domain.alert.entity.AlertType;

// 서버 전체 설정을 쓰는 잠정 구현이다. 세션별 방식 선택은 아직 지원하지 않는다.
// 실행 중에 바꾸지 않으며, 모드 전환은 진행 중인 세션을 모두 종료한 뒤 서버를 재시작하는 운영을 전제로 한다
@ConfigurationProperties("focus-recovery.alert")
public record AlertProperties(AlertType mode, Ai ai, FixedInterval fixedInterval) {

	// minInterval: 마지막으로 실제 표시된 AI 알림의 shownAt부터 새 AI 후보까지의 최소 간격(잠정)
	public record Ai(Duration minInterval) {
	}

	// interval: 첫 후보는 세션 startedAt, 이후는 마지막 고정 주기 알림의 shownAt부터의 간격(잠정)
	public record FixedInterval(Duration interval) {
	}
}

package com.focusrecovery.domain.analysis.client;

import java.net.URI;
import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

// 모두 잠정값이다: timeout·확률 합 허용 오차는 AI 담당자와 확정 전 (API 명세 6장 팀 확정 항목)
@ConfigurationProperties("focus-recovery.ai")
public record AiProperties(
	URI baseUrl,
	Duration connectTimeout,
	Duration responseTimeout,
	double probabilitySumTolerance
) {
}

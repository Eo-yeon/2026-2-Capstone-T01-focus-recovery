package com.focusrecovery.global.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import com.focusrecovery.domain.analysis.client.AiProperties;
import com.focusrecovery.domain.analysis.service.AnalysisProperties;

@Configuration
@EnableScheduling
@EnableConfigurationProperties({AiProperties.class, AnalysisProperties.class})
public class AsyncConfig {

	// 큐가 차면 TaskRejectedException(AbortPolicy)을 던진다. 요청 스레드에서 대신 실행하지 않는다(CallerRuns 미사용)
	@Bean
	public ThreadPoolTaskExecutor analysisTaskExecutor(AnalysisProperties properties) {
		ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
		executor.setCorePoolSize(properties.executor().poolSize());
		executor.setMaxPoolSize(properties.executor().poolSize());
		executor.setQueueCapacity(properties.executor().queueCapacity());
		executor.setThreadNamePrefix("analysis-");
		return executor;
	}
}

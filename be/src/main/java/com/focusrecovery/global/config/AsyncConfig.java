package com.focusrecovery.global.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;

import com.focusrecovery.domain.analysis.client.AiProperties;

@Configuration
@EnableAsync
@EnableConfigurationProperties(AiProperties.class)
public class AsyncConfig {
}

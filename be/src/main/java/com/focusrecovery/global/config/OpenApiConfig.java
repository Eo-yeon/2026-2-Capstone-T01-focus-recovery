package com.focusrecovery.global.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;

@Configuration
public class OpenApiConfig {

	@Bean
	public OpenAPI focusRecoveryOpenApi() {
		return new OpenAPI().info(new Info()
			.title("Focus Recovery API")
			.description("작업 중 집중이 끊겼을 때 다시 작업 흐름으로 돌아올 수 있도록 돕는 Focus Recovery 서비스의 백엔드 API입니다. "
				+ "모든 시각은 UTC 기준 ISO-8601 형식(밀리초 포함)으로 주고받습니다.")
			.version("v1"));
	}
}

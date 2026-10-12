package com.focusrecovery.global.config;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class OpenApiDocsTest {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void OpenAPI_문서에_세션_API가_포함된다() throws Exception {
		mockMvc.perform(get("/v3/api-docs"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.info.title").value("Focus Recovery API"))
			.andExpect(jsonPath("$.paths['/api/sessions'].post.parameters[0].name").value("Idempotency-Key"))
			.andExpect(jsonPath("$.paths['/api/sessions'].post.responses['422']").exists())
			.andExpect(jsonPath("$.paths['/api/sessions'].post.responses['404']").doesNotExist())
			.andExpect(jsonPath("$.paths['/api/sessions/{sessionId}'].get.responses['404']").exists())
			.andExpect(jsonPath("$.paths['/api/sessions/{sessionId}'].get.responses['422']").doesNotExist());
	}
}

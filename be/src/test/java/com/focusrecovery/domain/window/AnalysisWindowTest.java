package com.focusrecovery.domain.window;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.IntStream;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.repository.WorkSessionRepository;
import com.focusrecovery.domain.visit.repository.PageVisitRepository;
import com.focusrecovery.domain.window.repository.AnalysisWindowRepository;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AnalysisWindowTest {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private WorkSessionRepository workSessionRepository;

	@Autowired
	private PageVisitRepository pageVisitRepository;

	@Autowired
	private AnalysisWindowRepository analysisWindowRepository;

	private UUID sessionId;

	@BeforeEach
	void setUp() {
		analysisWindowRepository.deleteAll();
		pageVisitRepository.deleteAll();
		workSessionRepository.deleteAll();
		sessionId = newSession();
	}

	// 다른 테스트 클래스가 세션을 지울 때 외래키에 걸리지 않도록 구간과 방문 기록을 남기지 않는다
	@AfterEach
	void tearDown() {
		analysisWindowRepository.deleteAll();
		pageVisitRepository.deleteAll();
	}

	@Test
	void 방문_4개까지는_구간이_없고_5번째부터_한_칸씩_밀며_생성한다() throws Exception {
		for (int sequence = 1; sequence <= 4; sequence++) {
			saveVisit(sessionId, sequence).andExpect(status().isCreated());
		}
		assertThat(windows(sessionId)).isEmpty();

		saveVisit(sessionId, 5).andExpect(status().isCreated());
		assertThat(windows(sessionId)).isEqualTo(Map.of(1, List.of(1, 2, 3, 4, 5)));

		saveVisit(sessionId, 6).andExpect(status().isCreated());
		assertThat(windows(sessionId)).isEqualTo(Map.of(1, List.of(1, 2, 3, 4, 5), 2, List.of(2, 3, 4, 5, 6)));

		saveVisit(sessionId, 7).andExpect(status().isCreated());
		assertThat(windows(sessionId)).containsEntry(3, List.of(3, 4, 5, 6, 7)).hasSize(3);
	}

	@Test
	void 같은_방문을_재전송하면_200이고_구간은_추가되거나_바뀌지_않는다() throws Exception {
		List<String> visitIds = new ArrayList<>();
		for (int sequence = 1; sequence <= 6; sequence++) {
			String visitId = UUID.randomUUID().toString();
			visitIds.add(visitId);
			saveVisit(sessionId, visitId, sequence).andExpect(status().isCreated());
		}
		List<Map<String, Object>> before = windowRows(sessionId);

		saveVisit(sessionId, visitIds.get(5), 6).andExpect(status().isOk());
		saveVisit(sessionId, visitIds.get(2), 3).andExpect(status().isOk());

		assertThat(windowRows(sessionId)).isEqualTo(before);
	}

	@Test
	void 앞선_방문이_누락되면_보류했다가_도착하면_밀린_구간을_모두_생성한다() throws Exception {
		for (int sequence : new int[] {1, 2, 4, 5, 6}) {
			saveVisit(sessionId, sequence).andExpect(status().isCreated());
		}
		assertThat(windows(sessionId)).isEmpty();

		saveVisit(sessionId, 3).andExpect(status().isCreated());

		assertThat(windows(sessionId)).isEqualTo(Map.of(1, List.of(1, 2, 3, 4, 5), 2, List.of(2, 3, 4, 5, 6)));
	}

	@Test
	void 도착_순서와_무관하게_sequence_순서로_구성한다() throws Exception {
		for (int sequence : new int[] {8, 3, 6, 1, 7, 5, 2, 4}) {
			saveVisit(sessionId, sequence).andExpect(status().isCreated());
		}

		assertThat(windows(sessionId)).isEqualTo(expectedWindows(8));
	}

	@Test
	void 구간에는_같은_세션의_방문만_들어간다() throws Exception {
		UUID otherSessionId = newSession();
		for (int sequence = 1; sequence <= 6; sequence++) {
			saveVisit(sessionId, sequence).andExpect(status().isCreated());
			saveVisit(otherSessionId, sequence).andExpect(status().isCreated());
		}

		assertThat(windows(sessionId)).isEqualTo(expectedWindows(6));
		assertThat(windows(otherSessionId)).isEqualTo(expectedWindows(6));
	}

	@RepeatedTest(3)
	void 동시에_저장해도_구간이_누락_중복되거나_번호가_충돌하지_않는다() throws Exception {
		UUID otherSessionId = newSession();
		List<Integer> sequences = new ArrayList<>(IntStream.rangeClosed(1, 12).boxed().toList());
		Collections.shuffle(sequences);

		List<Integer> statuses = runConcurrently(24, i -> (i % 2 == 0
			? saveVisit(sessionId, sequences.get(i / 2))
			: saveVisit(otherSessionId, sequences.get(i / 2))).andReturn().getResponse().getStatus());

		assertThat(statuses).containsOnly(201);
		assertThat(windows(sessionId)).isEqualTo(expectedWindows(12));
		assertThat(windows(otherSessionId)).isEqualTo(expectedWindows(12));
	}

	@Test
	void 같은_방문을_동시에_재전송해도_구간은_한_번만_생성된다() throws Exception {
		for (int sequence = 1; sequence <= 4; sequence++) {
			saveVisit(sessionId, sequence).andExpect(status().isCreated());
		}
		String visitId = UUID.randomUUID().toString();

		List<Integer> statuses = runConcurrently(8,
			i -> saveVisit(sessionId, visitId, 5).andReturn().getResponse().getStatus());

		assertThat(statuses).containsOnlyOnce(201).filteredOn(s -> s != 201).containsOnly(200);
		assertThat(windows(sessionId)).isEqualTo(expectedWindows(5));
	}

	@Test
	void 종료된_세션에는_새_방문과_구간이_생성되지_않는다() throws Exception {
		for (int sequence = 1; sequence <= 4; sequence++) {
			saveVisit(sessionId, sequence).andExpect(status().isCreated());
		}
		mockMvc.perform(post("/api/sessions/{sessionId}/end", sessionId)).andExpect(status().isOk());

		saveVisit(sessionId, 5)
			.andExpect(status().isConflict())
			.andExpect(jsonPath("$.code").value("SESSION_ENDED"));

		assertThat(windows(sessionId)).isEmpty();
		assertThat(pageVisitRepository.count()).isEqualTo(4);
	}

	private static Map<Integer, List<Integer>> expectedWindows(int visitCount) {
		Map<Integer, List<Integer>> expected = new LinkedHashMap<>();
		for (int index = 1; index + 4 <= visitCount; index++) {
			expected.put(index, IntStream.rangeClosed(index, index + 4).boxed().toList());
		}
		return expected;
	}

	private List<Map<String, Object>> windowRows(UUID sessionId) {
		return jdbcTemplate.queryForList("""
			select w.window_id, w.window_index, w.window_size, w.start_visit_id, w.end_visit_id, w.created_at,
				w.session_id as window_session_id, wv.visit_id, wv.position, v.sequence, v.session_id as visit_session_id
			from analysis_window w
			join window_visit wv on wv.window_id = w.window_id
			join page_visit v on v.visit_id = wv.visit_id
			where w.session_id = ?
			order by w.window_index, wv.position""", sessionId.toString());
	}

	// 구간 번호 → 구간에 담긴 방문 sequence 목록. 모든 구간의 구조(크기·위치·시작/끝·세션 소속)도 함께 검증한다
	private Map<Integer, List<Integer>> windows(UUID sessionId) {
		Map<Integer, List<Integer>> windows = new LinkedHashMap<>();
		for (Map<String, Object> row : windowRows(sessionId)) {
			assertThat(row.get("window_size")).isEqualTo(5);
			assertThat(row.get("visit_session_id")).isEqualTo(sessionId.toString());
			assertThat(row.get("created_at")).isNotNull();
			int position = (Integer) row.get("position");
			if (position == 1) {
				assertThat(row.get("visit_id")).isEqualTo(row.get("start_visit_id"));
			}
			if (position == 5) {
				assertThat(row.get("visit_id")).isEqualTo(row.get("end_visit_id"));
			}
			List<Integer> sequences = windows.computeIfAbsent((Integer) row.get("window_index"), k -> new ArrayList<>());
			assertThat(position).isEqualTo(sequences.size() + 1);
			sequences.add((Integer) row.get("sequence"));
		}
		windows.values().forEach(sequences -> assertThat(sequences).hasSize(5));
		return windows;
	}

	private interface IndexedTask<T> {
		T run(int index) throws Exception;
	}

	private <T> List<T> runConcurrently(int count, IndexedTask<T> task) throws Exception {
		CountDownLatch ready = new CountDownLatch(1);
		ExecutorService executor = Executors.newFixedThreadPool(count);
		try {
			List<Future<T>> futures = new ArrayList<>();
			for (int i = 0; i < count; i++) {
				int index = i;
				Callable<T> callable = () -> {
					ready.await();
					return task.run(index);
				};
				futures.add(executor.submit(callable));
			}
			ready.countDown();
			List<T> results = new ArrayList<>();
			for (Future<T> future : futures) {
				results.add(future.get());
			}
			return results;
		} finally {
			executor.shutdown();
		}
	}

	private UUID newSession() {
		return workSessionRepository.save(WorkSession.start("구간 구성 테스트", null)).getSessionId();
	}

	private ResultActions saveVisit(UUID sessionId, int sequence) throws Exception {
		return saveVisit(sessionId, UUID.randomUUID().toString(), sequence);
	}

	private ResultActions saveVisit(UUID sessionId, String visitId, int sequence) throws Exception {
		return mockMvc.perform(post("/api/sessions/{sessionId}/visits", sessionId)
			.contentType(MediaType.APPLICATION_JSON)
			.content("""
				{"visitId": "%s", "sequence": %d, "browserTabKey": "tab-1", "normalizedUrl": "https://example.com/%d", \
				"domain": "example.com", "title": "제목", "content": "본문", "activeDurationMs": 1000, \
				"visitedAt": "2026-10-13T01:23:45.678Z"}""".formatted(visitId, sequence, sequence)));
	}
}

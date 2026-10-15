package com.focusrecovery.domain.window.service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.visit.repository.PageVisitRepository;
import com.focusrecovery.domain.window.entity.AnalysisWindow;
import com.focusrecovery.domain.window.repository.AnalysisWindowRepository;
import com.focusrecovery.global.exception.ConflictException;

@Service
public class AnalysisWindowService {

	static final int WINDOW_SIZE = 5;

	private final AnalysisWindowRepository analysisWindowRepository;
	private final PageVisitRepository pageVisitRepository;

	public AnalysisWindowService(AnalysisWindowRepository analysisWindowRepository,
		PageVisitRepository pageVisitRepository) {
		this.analysisWindowRepository = analysisWindowRepository;
		this.pageVisitRepository = pageVisitRepository;
	}

	// 새 방문 INSERT 전에 세션 쓰기 잠금 안에서 호출한다: 기존 구간을 다시 쓰지 않으려고 마지막 구간 끝보다 앞선 새 방문은 거절한다
	@Transactional(propagation = Propagation.MANDATORY)
	public void checkOrder(UUID sessionId, int sequence) {
		if (sequence < lastWindowEndSequence(analysisWindowRepository.findFirstBySessionIdOrderByWindowIndexDesc(sessionId))) {
			throw new ConflictException("VISIT_SEQUENCE_OUT_OF_ORDER", "마지막 탐색 구간보다 앞선 순서의 새 방문은 저장할 수 없습니다.");
		}
	}

	// 방문 저장 트랜잭션 안에서 세션 쓰기 잠금을 잡은 상태로만 호출한다: 같은 세션의 구간 생성이 직렬화된다
	// sequence는 방문 후보 발생 순서라 제외된 후보 번호가 비므로, 숫자 연속성은 보지 않고 저장된 방문의 sequence 순서만 쓴다.
	// 기존 구간은 다시 쓰지 않는다: 마지막 구간의 방문 5개 뒤에 그 끝보다 큰 sequence의 방문을 이어 붙여 한 칸씩 민다(checkOrder로 앞선 방문은 없음)
	@Transactional(propagation = Propagation.MANDATORY)
	public void createWindows(UUID sessionId, Instant now) {
		Optional<AnalysisWindow> last = analysisWindowRepository.findFirstBySessionIdOrderByWindowIndexDesc(sessionId);
		List<UUID> visitIds = new ArrayList<>(last.map(AnalysisWindow::getVisitIds).orElse(List.of()));
		int afterSequence = lastWindowEndSequence(last);
		pageVisitRepository.findBySessionIdAndSequenceGreaterThanOrderBySequence(sessionId, afterSequence)
			.forEach(visit -> visitIds.add(visit.getVisitId()));

		int nextIndex = last.map(AnalysisWindow::getWindowIndex).orElse(0) + 1;
		List<AnalysisWindow> windows = new ArrayList<>();
		for (int start = last.isPresent() ? 1 : 0; start + WINDOW_SIZE <= visitIds.size(); start++) {
			windows.add(AnalysisWindow.of(sessionId, nextIndex++, visitIds.subList(start, start + WINDOW_SIZE), now));
		}
		analysisWindowRepository.saveAllAndFlush(windows);
	}

	private int lastWindowEndSequence(Optional<AnalysisWindow> last) {
		return last.map(window -> pageVisitRepository.findByVisitId(window.getEndVisitId()).orElseThrow().getSequence())
			.orElse(0);
	}
}

package com.focusrecovery.domain.window.service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.visit.repository.PageVisitRepository;
import com.focusrecovery.domain.window.entity.AnalysisWindow;
import com.focusrecovery.domain.window.repository.AnalysisWindowRepository;

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

	// 방문 저장 트랜잭션 안에서 세션 쓰기 잠금을 잡은 상태로만 호출한다: 같은 세션의 구간 생성이 직렬화된다
	// 구간 k는 sequence k~k+4이며, sequence 1부터 끊기지 않은 방문까지만 만든다(누락이 있으면 그 뒤는 보류)
	@Transactional(propagation = Propagation.MANDATORY)
	public void createWindows(UUID sessionId, Instant now) {
		int nextIndex = analysisWindowRepository.findLastWindowIndex(sessionId) + 1;
		List<PageVisitRepository.VisitSequence> visits =
			pageVisitRepository.findBySessionIdAndSequenceGreaterThanEqualOrderBySequence(sessionId, nextIndex);
		List<UUID> contiguous = new ArrayList<>();
		for (PageVisitRepository.VisitSequence visit : visits) {
			if (visit.getSequence() != nextIndex + contiguous.size()) {
				break;
			}
			contiguous.add(visit.getVisitId());
		}
		List<AnalysisWindow> windows = new ArrayList<>();
		for (int start = 0; start + WINDOW_SIZE <= contiguous.size(); start++) {
			windows.add(AnalysisWindow.of(sessionId, nextIndex + start,
				contiguous.subList(start, start + WINDOW_SIZE), now));
		}
		analysisWindowRepository.saveAllAndFlush(windows);
	}
}

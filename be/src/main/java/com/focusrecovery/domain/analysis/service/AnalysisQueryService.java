package com.focusrecovery.domain.analysis.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.analysis.dto.AnalysisDetailResponse;
import com.focusrecovery.domain.analysis.dto.AnalysisPageResponse;
import com.focusrecovery.domain.analysis.dto.AnalysisStatusResponse;
import com.focusrecovery.domain.analysis.dto.AnalysisSummaryResponse;
import com.focusrecovery.domain.analysis.entity.AnalysisResult;
import com.focusrecovery.domain.analysis.entity.AnalysisStatus;
import com.focusrecovery.domain.analysis.exception.AnalysisNotFoundException;
import com.focusrecovery.domain.analysis.repository.AnalysisResultRepository;
import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.exception.SessionNotFoundException;
import com.focusrecovery.domain.session.repository.WorkSessionRepository;
import com.focusrecovery.domain.visit.repository.PageVisitRepository;
import com.focusrecovery.domain.window.entity.AnalysisWindow;
import com.focusrecovery.domain.window.repository.AnalysisWindowRepository;

// 조회 전용: 분석·알림을 만들거나 AI를 호출하거나 상태를 바꾸지 않는다
@Service
@Transactional(readOnly = true)
public class AnalysisQueryService {

	private static final PageRequest FIRST = PageRequest.of(0, 1);

	private final WorkSessionRepository workSessionRepository;
	private final AnalysisResultRepository analysisResultRepository;
	private final AnalysisWindowRepository analysisWindowRepository;
	private final PageVisitRepository pageVisitRepository;
	private final StoredJsonReader storedJsonReader;

	public AnalysisQueryService(WorkSessionRepository workSessionRepository,
		AnalysisResultRepository analysisResultRepository, AnalysisWindowRepository analysisWindowRepository,
		PageVisitRepository pageVisitRepository, StoredJsonReader storedJsonReader) {
		this.workSessionRepository = workSessionRepository;
		this.analysisResultRepository = analysisResultRepository;
		this.analysisWindowRepository = analysisWindowRepository;
		this.pageVisitRepository = pageVisitRepository;
		this.storedJsonReader = storedJsonReader;
	}

	// 최신 여부는 windowIndex로만 판단한다(완료 시각·응답 도착 순서 무관). 알림은 별도 기능이라 항상 null
	public AnalysisStatusResponse status(UUID sessionId) {
		WorkSession session = workSessionRepository.findById(sessionId).orElseThrow(SessionNotFoundException::new);
		AnalysisSummaryResponse latest = first(analysisResultRepository.findSummariesBySessionId(sessionId, FIRST).getContent());
		AnalysisSummaryResponse latestCompleted = first(
			analysisResultRepository.findSummariesBySessionIdAndStatus(sessionId, AnalysisStatus.COMPLETED, FIRST));
		return new AnalysisStatusResponse(sessionId, session.getStatus(), latest, latestCompleted, null);
	}

	public AnalysisPageResponse list(UUID sessionId, int page, int size) {
		if (!workSessionRepository.existsById(sessionId)) {
			throw new SessionNotFoundException();
		}
		return AnalysisPageResponse.from(
			analysisResultRepository.findSummariesBySessionId(sessionId, PageRequest.of(page, size)));
	}

	// 다른 세션의 분석은 이 세션에서 찾을 수 없는 리소스(404)로 처리한다
	public AnalysisDetailResponse detail(UUID sessionId, UUID analysisId) {
		if (!workSessionRepository.existsById(sessionId)) {
			throw new SessionNotFoundException();
		}
		AnalysisResult analysis = analysisResultRepository.findById(analysisId).orElseThrow(AnalysisNotFoundException::new);
		AnalysisWindow window = analysisWindowRepository.findById(analysis.getWindowId())
			.filter(found -> found.getSessionId().equals(sessionId))
			.orElseThrow(AnalysisNotFoundException::new);
		List<UUID> visitIds = window.getVisitIds();
		Map<UUID, Integer> sequences = pageVisitRepository.findByVisitIdIn(visitIds).stream()
			.collect(Collectors.toMap(PageVisitRepository.VisitSequence::getVisitId, PageVisitRepository.VisitSequence::getSequence));
		List<AnalysisDetailResponse.Visit> visits = new ArrayList<>();
		for (int i = 0; i < visitIds.size(); i++) {
			visits.add(new AnalysisDetailResponse.Visit(i + 1, visitIds.get(i), sequences.get(visitIds.get(i))));
		}
		return AnalysisDetailResponse.of(analysis, window, visits, storedJsonReader);
	}

	private static AnalysisSummaryResponse first(List<AnalysisSummaryResponse> summaries) {
		return summaries.isEmpty() ? null : summaries.getFirst();
	}
}

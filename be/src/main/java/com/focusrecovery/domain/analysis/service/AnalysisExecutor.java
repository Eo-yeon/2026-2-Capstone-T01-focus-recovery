package com.focusrecovery.domain.analysis.service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;

import com.focusrecovery.domain.analysis.client.AiAnalysisClient;
import com.focusrecovery.domain.analysis.client.AiAnalysisOutcome;
import com.focusrecovery.domain.analysis.entity.AnalysisStatus;
import com.focusrecovery.domain.analysis.repository.AnalysisResultRepository;
import com.focusrecovery.domain.window.repository.AnalysisWindowRepository;

// 요청을 만든 트랜잭션이 커밋된 뒤 별도 스레드에서 AI를 호출한다: 방문 저장·종료 응답이 AI를 기다리지 않고,
// AI 장애가 그 요청을 실패시키지 않는다. 잠금은 짧은 상태 전이 트랜잭션에서만 잡고 AI 응답을 기다리는 동안에는 잡지 않는다
@Service
public class AnalysisExecutor {

	private final AnalysisResultRepository analysisResultRepository;
	private final AnalysisWindowRepository analysisWindowRepository;
	private final AiAnalysisClient aiAnalysisClient;
	private final TransactionTemplate transactionTemplate;

	public AnalysisExecutor(AnalysisResultRepository analysisResultRepository,
		AnalysisWindowRepository analysisWindowRepository, AiAnalysisClient aiAnalysisClient,
		TransactionTemplate transactionTemplate) {
		this.analysisResultRepository = analysisResultRepository;
		this.analysisWindowRepository = analysisWindowRepository;
		this.aiAnalysisClient = aiAnalysisClient;
		this.transactionTemplate = transactionTemplate;
	}

	@Async
	@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
	public void onRequested(AnalysisRequestedEvent event) {
		event.analysisIds().forEach(this::run);
	}

	// PENDING인 분석만 RUNNING으로 가져가므로 같은 분석을 중복·동시에 실행해도 AI 호출은 한 번이다.
	// 완료·실패를 기록할 때도 RUNNING인지 확인하므로 끝난 결과를 덮어쓰지 않는다. BE 자동 재시도는 없다(잠정)
	public void run(UUID analysisId) {
		Claim claim = transactionTemplate.execute(status -> analysisResultRepository.findForUpdateByAnalysisId(analysisId)
			.filter(analysis -> analysis.getProcessingStatus() == AnalysisStatus.PENDING)
			.map(analysis -> {
				analysis.start();
				UUID sessionId = analysisWindowRepository.findById(analysis.getWindowId()).orElseThrow().getSessionId();
				return new Claim(analysis.getInputSnapshot(), sessionId, analysis.getWindowId());
			})
			.orElse(null));
		if (claim == null) {
			return;
		}
		AiAnalysisOutcome outcome = aiAnalysisClient.analyze(claim.inputSnapshot(), analysisId, claim.sessionId(),
			claim.windowId());
		transactionTemplate.executeWithoutResult(status -> analysisResultRepository.findForUpdateByAnalysisId(analysisId)
			.filter(analysis -> analysis.getProcessingStatus() == AnalysisStatus.RUNNING)
			.ifPresent(analysis -> analysis.finish(outcome, Instant.now().truncatedTo(ChronoUnit.MILLIS))));
	}

	private record Claim(String inputSnapshot, UUID sessionId, UUID windowId) {
	}
}

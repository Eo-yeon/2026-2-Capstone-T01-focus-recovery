package com.focusrecovery.domain.analysis.service;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.analysis.client.AiProperties;
import com.focusrecovery.domain.analysis.repository.AnalysisResultRepository;

// 미완료 분석 복구: AI를 다시 호출하지 않고, 제한 시간을 넘긴 작업을 FAILED로 확정한다.
// PENDING은 requested_at, RUNNING은 started_at 기준이다(started_at이 없는 V5 이전 RUNNING은 requested_at + pending + running 기준). 정상 진행 중인 작업을 잘라내지 않도록 시작 시 제한 시간을 검사한다
@Service
public class AnalysisRecovery {

	// BE 내부 실패 코드: 제한 시간 안에 실행되지 못함 / 실행 중 결과 기록 없이 제한 시간 초과(서버 재시작 등)
	static final String NOT_STARTED = "ANALYSIS_NOT_STARTED";
	static final String INTERRUPTED = "ANALYSIS_INTERRUPTED";

	private static final Logger log = LoggerFactory.getLogger(AnalysisRecovery.class);

	private final AnalysisResultRepository analysisResultRepository;
	private final AnalysisProperties.Recovery recovery;

	public AnalysisRecovery(AnalysisResultRepository analysisResultRepository, AnalysisProperties properties,
		AiProperties aiProperties) {
		validate(properties, aiProperties);
		this.analysisResultRepository = analysisResultRepository;
		this.recovery = properties.recovery();
	}

	// RUNNING의 최대 정상 시간은 AI 응답 대기 한도(response-timeout)다.
	// PENDING의 최대 정상 대기는 큐 끝에서 앞 작업들이 모두 끝날 때까지: (queue / pool + 1) × response-timeout
	public static void validate(AnalysisProperties properties, AiProperties aiProperties) {
		Duration response = aiProperties.responseTimeout();
		AnalysisProperties.Executor executor = properties.executor();
		Duration maxQueueWait = response.multipliedBy(
			(long) Math.ceil((double) executor.queueCapacity() / executor.poolSize()) + 1);
		if (properties.recovery().runningTimeout().compareTo(response) <= 0) {
			throw new IllegalStateException("running-timeout(" + properties.recovery().runningTimeout()
				+ ")은 AI response-timeout(" + response + ")보다 길어야 합니다.");
		}
		if (properties.recovery().pendingTimeout().compareTo(maxQueueWait) <= 0) {
			throw new IllegalStateException("pending-timeout(" + properties.recovery().pendingTimeout()
				+ ")은 최대 큐 대기 " + maxQueueWait + "보다 길어야 합니다.");
		}
	}

	// 같은 클래스 안의 호출은 트랜잭션 프록시를 거치지 않으므로 스케줄 진입점에도 트랜잭션을 건다
	@Scheduled(fixedDelayString = "${focus-recovery.analysis.recovery.interval}",
		initialDelayString = "${focus-recovery.analysis.recovery.interval}")
	@Transactional
	public void recoverStale() {
		recoverStale(Instant.now().truncatedTo(ChronoUnit.MILLIS));
	}

	@Transactional
	public void recoverStale(Instant now) {
		int pending = analysisResultRepository.failPendingRequestedBefore(
			now.minus(recovery.pendingTimeout()), NOT_STARTED, now);
		// started_at이 없는 기존 RUNNING: 요청 후 최대 큐 대기(< pending-timeout)를 거쳐 시작해 running-timeout 안에 끝나므로
		// requested_at + pending-timeout + running-timeout이 지나면 정상 진행 중일 수 없다
		int running = analysisResultRepository.failRunningStartedBefore(now.minus(recovery.runningTimeout()),
			now.minus(recovery.pendingTimeout()).minus(recovery.runningTimeout()), INTERRUPTED, now);
		if (pending + running > 0) {
			log.warn("미완료 분석을 실패로 확정했습니다. PENDING={} RUNNING={}", pending, running);
		}
	}
}

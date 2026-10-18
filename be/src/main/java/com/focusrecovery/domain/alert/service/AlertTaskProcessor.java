package com.focusrecovery.domain.alert.service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import com.focusrecovery.domain.alert.entity.AlertCandidateTask;
import com.focusrecovery.domain.alert.entity.AlertTaskStatus;
import com.focusrecovery.domain.alert.repository.AlertCandidateTaskRepository;

// AI 알림 후보 처리 작업 실행·복구. 후보 생성만 다시 시도하며 AI는 다시 호출하지 않는다.
// 각 단계는 짧은 트랜잭션이다: 가져가기(PENDING→RUNNING) → 판단·기록(세션 → 분석 행 → 작업 행 순서로 잠금) → 오류 기록
@Service
public class AlertTaskProcessor {

	static final String DB_ERROR = "ALERT_DB_ERROR";
	static final String INTERNAL_ERROR = "ALERT_INTERNAL_ERROR";
	static final String INTERRUPTED = "ALERT_TASK_INTERRUPTED";
	private static final int BATCH = 100;

	private static final Logger log = LoggerFactory.getLogger(AlertTaskProcessor.class);

	private final AlertCandidateTaskRepository taskRepository;
	private final AlertService alertService;
	private final TransactionTemplate transactionTemplate;
	private final Clock clock;
	private final AlertProperties.Task properties;

	public AlertTaskProcessor(AlertCandidateTaskRepository taskRepository, AlertService alertService,
		TransactionTemplate transactionTemplate, Clock clock, AlertProperties properties) {
		this.taskRepository = taskRepository;
		this.alertService = alertService;
		this.transactionTemplate = transactionTemplate;
		this.clock = clock;
		this.properties = properties.task();
	}

	// 스케줄 진입점: 트랜잭션은 각 단계가 TransactionTemplate으로 직접 연다(같은 클래스 내부 호출이어도 적용됨)
	@Scheduled(fixedDelayString = "${focus-recovery.alert.task.interval}",
		initialDelayString = "${focus-recovery.alert.task.interval}")
	public void recover() {
		registerMissing();
		recoverStaleRunning();
		for (UUID analysisId : transactionTemplate.execute(status ->
			taskRepository.findDueIds(now(), PageRequest.of(0, BATCH)))) {
			process(analysisId);
		}
	}

	// 분석을 DRIFT로 완료하는 트랜잭션 안에서 호출한다(결과 저장과 작업 등록이 함께 커밋됨). 시각은 처리와 같은 Clock 기준
	@Transactional(propagation = Propagation.MANDATORY)
	public void register(UUID analysisId, UUID sessionId) {
		taskRepository.save(AlertCandidateTask.pending(analysisId, sessionId, now()));
	}

	// 작업 행이 없는 COMPLETED·DRIFT 분석을 등록한다(V7 이전 데이터 등). 동시에 등록되면 PK로 하나만 남는다
	void registerMissing() {
		List<Object[]> missing = transactionTemplate.execute(status -> taskRepository.findMissing(PageRequest.of(0, BATCH)));
		for (Object[] row : missing) {
			try {
				transactionTemplate.executeWithoutResult(status ->
					taskRepository.save(AlertCandidateTask.pending((UUID) row[0], (UUID) row[1], now())));
			} catch (DataIntegrityViolationException e) {
				// 다른 경로에서 이미 등록됨
			}
		}
	}

	// started_at부터 running-timeout을 넘긴 RUNNING(서버 중단, 오류 기록 실패 등)을 다시 대기시키거나 소진 시 FAILED로 확정한다
	void recoverStaleRunning() {
		Instant now = now();
		Instant cutoff = now.minus(properties.runningTimeout());
		transactionTemplate.executeWithoutResult(status -> {
			taskRepository.requeueStaleRunning(cutoff, properties.maxAttempts(), INTERRUPTED, now);
			taskRepository.failStaleRunning(cutoff, properties.maxAttempts(), INTERRUPTED, now);
		});
	}

	// 가져간 작업: 판단 트랜잭션이 작업 엔티티를 미리 읽지 않도록 세션 ID와 시도 번호를 함께 넘긴다
	private record Claim(UUID sessionId, int attempt) {
	}

	// 다른 실행(멈춤 복구 후 재처리 등)이 같은 작업을 새 시도 번호로 가져간 경우
	static class OwnershipLostException extends RuntimeException {

		OwnershipLostException(UUID analysisId, int attempt) {
			super("작업 소유권을 잃었습니다. analysisId=" + analysisId + " attempt=" + attempt);
		}
	}

	// 대기 중인 작업 하나를 처리한다. 다른 실행이 이미 가져갔거나 아직 재시도 시각 전이면 아무것도 하지 않는다
	public void process(UUID analysisId) {
		Claim claim;
		try {
			claim = transactionTemplate.execute(status -> taskRepository.findForUpdateByAnalysisId(analysisId)
				.filter(task -> task.getStatus() == AlertTaskStatus.PENDING && !task.getNextAttemptAt().isAfter(now()))
				.map(task -> {
					task.start(now());
					return new Claim(task.getSessionId(), task.getAttempts());
				})
				.orElse(null));
		} catch (RuntimeException e) {
			log.error("알림 후보 작업 시작 실패 analysisId={}", analysisId, e);
			return;
		}
		if (claim == null) {
			return;
		}
		try {
			transactionTemplate.executeWithoutResult(status -> decideAndRecord(analysisId, claim));
		} catch (OwnershipLostException e) {
			// 후보 저장까지 롤백됐다. 작업은 새 소유자가 처리하므로 실패로 기록하지 않는다
			log.warn(e.getMessage());
		} catch (RuntimeException e) {
			log.error("알림 후보 생성 실패 analysisId={} attempt={}", analysisId, claim.attempt(), e);
			recordFailure(analysisId, claim.attempt(),
				e instanceof DataAccessException || e instanceof TransactionException ? DB_ERROR : INTERNAL_ERROR);
		}
	}

	// 판단(세션 → 분석 행 잠금)과 결과 기록(작업 행)을 한 트랜잭션에서 한다: 후보 저장과 작업 완료 기록이 함께 커밋된다.
	// 결과 기록은 DB의 현재 상태가 RUNNING이고 시도 번호가 이 실행의 것일 때만 반영되며, 아니면 예외로 후보 저장까지 롤백한다
	private void decideAndRecord(UUID analysisId, Claim claim) {
		AlertService.AiDecision decision = alertService.decideAiCandidate(claim.sessionId(), analysisId);
		int updated = decision.notification() != null
			? taskRepository.markCreated(analysisId, claim.attempt(), decision.notification().getAlertId(), now())
			: taskRepository.markSkipped(analysisId, claim.attempt(), decision.skipReason(), now());
		if (updated == 0) {
			throw new OwnershipLostException(analysisId, claim.attempt());
		}
	}

	// 실패 기록도 DB의 현재 상태·시도 번호 조건으로 갱신한다. 기록마저 못 하면 RUNNING으로 남고 recoverStaleRunning이 다시 찾는다
	private void recordFailure(UUID analysisId, int attempt, String errorCode) {
		try {
			transactionTemplate.executeWithoutResult(status -> {
				if (attempt >= properties.maxAttempts()) {
					taskRepository.markFailed(analysisId, attempt, errorCode, now());
				} else {
					taskRepository.markRetry(analysisId, attempt, errorCode, now().plus(retryDelay(attempt)));
				}
			});
		} catch (RuntimeException e) {
			log.error("알림 후보 작업 실패 기록 실패 analysisId={}", analysisId, e);
		}
	}

	// initialDelay × 2^(attempt-1), 최대 maxDelay
	Duration retryDelay(int attempt) {
		Duration delay = properties.initialDelay().multipliedBy(1L << Math.min(attempt - 1, 20));
		return delay.compareTo(properties.maxDelay()) > 0 ? properties.maxDelay() : delay;
	}

	private Instant now() {
		return clock.instant().truncatedTo(ChronoUnit.MILLIS);
	}
}

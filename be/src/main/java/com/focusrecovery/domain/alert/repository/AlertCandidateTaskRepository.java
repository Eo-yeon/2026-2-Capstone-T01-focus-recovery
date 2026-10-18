package com.focusrecovery.domain.alert.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.focusrecovery.domain.alert.entity.AlertCandidateTask;

import jakarta.persistence.LockModeType;

public interface AlertCandidateTaskRepository extends JpaRepository<AlertCandidateTask, UUID> {

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	Optional<AlertCandidateTask> findForUpdateByAnalysisId(UUID analysisId);

	@Query("""
		select t.analysisId from AlertCandidateTask t
		where t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.PENDING and t.nextAttemptAt <= :now
		order by t.nextAttemptAt""")
	List<UUID> findDueIds(Instant now, Pageable pageable);

	// 작업 행이 없는 COMPLETED·DRIFT 분석(V7 이전 데이터 등)과 그 세션
	@Query("""
		select r.analysisId, w.sessionId from AnalysisResult r join AnalysisWindow w on w.windowId = r.windowId
		where r.processingStatus = com.focusrecovery.domain.analysis.entity.AnalysisStatus.COMPLETED
			and r.result = 'DRIFT'
			and not exists (select 1 from AlertCandidateTask t where t.analysisId = r.analysisId)""")
	List<Object[]> findMissing(Pageable pageable);

	// 결과 기록은 실제 DB의 현재 상태·시도 번호를 조건으로 하는 갱신이다(영속성 컨텍스트의 이전 값을 쓰지 않음).
	// 0건이면 이 실행이 소유권을 잃은 것이다. 앞서 저장한 후보가 먼저 반영되도록 갱신 전에 flush한다
	@Modifying(flushAutomatically = true)
	@Query("""
		update AlertCandidateTask t set t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.CREATED,
			t.alertId = :alertId, t.completedAt = :now
		where t.analysisId = :analysisId and t.attempts = :attempt
			and t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.RUNNING""")
	int markCreated(UUID analysisId, int attempt, UUID alertId, Instant now);

	@Modifying(flushAutomatically = true)
	@Query("""
		update AlertCandidateTask t set t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.SKIPPED,
			t.skipReason = :reason, t.completedAt = :now
		where t.analysisId = :analysisId and t.attempts = :attempt
			and t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.RUNNING""")
	int markSkipped(UUID analysisId, int attempt, String reason, Instant now);

	@Modifying
	@Query("""
		update AlertCandidateTask t set t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.PENDING,
			t.errorCode = :errorCode, t.nextAttemptAt = :retryAt
		where t.analysisId = :analysisId and t.attempts = :attempt
			and t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.RUNNING""")
	int markRetry(UUID analysisId, int attempt, String errorCode, Instant retryAt);

	@Modifying
	@Query("""
		update AlertCandidateTask t set t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.FAILED,
			t.errorCode = :errorCode, t.completedAt = :now
		where t.analysisId = :analysisId and t.attempts = :attempt
			and t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.RUNNING""")
	int markFailed(UUID analysisId, int attempt, String errorCode, Instant now);

	// 처리 중 멈춘 작업: 재시도가 남았으면 즉시 다시 대기시키고, 소진했으면 FAILED로 확정한다(조건부 갱신)
	@Modifying
	@Query("""
		update AlertCandidateTask t set t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.PENDING,
			t.nextAttemptAt = :now, t.errorCode = :errorCode
		where t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.RUNNING
			and t.startedAt < :cutoff and t.attempts < :maxAttempts""")
	int requeueStaleRunning(Instant cutoff, int maxAttempts, String errorCode, Instant now);

	@Modifying
	@Query("""
		update AlertCandidateTask t set t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.FAILED,
			t.errorCode = :errorCode, t.completedAt = :now
		where t.status = com.focusrecovery.domain.alert.entity.AlertTaskStatus.RUNNING
			and t.startedAt < :cutoff and t.attempts >= :maxAttempts""")
	int failStaleRunning(Instant cutoff, int maxAttempts, String errorCode, Instant now);
}

package com.focusrecovery.domain.analysis.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.focusrecovery.domain.analysis.entity.AnalysisResult;

import jakarta.persistence.LockModeType;

public interface AnalysisResultRepository extends JpaRepository<AnalysisResult, UUID> {

	// 상태 전이(PENDING→RUNNING, RUNNING→완료/실패)를 분석 행 단위로 직렬화한다. AI 호출 중에는 잡지 않는다
	@Lock(LockModeType.PESSIMISTIC_WRITE)
	Optional<AnalysisResult> findForUpdateByAnalysisId(UUID analysisId);

	Optional<AnalysisResult> findByWindowId(UUID windowId);

	// 조건부 갱신이라 그사이 완료·실패로 바뀐 분석은 건드리지 않는다
	@Modifying
	@Query("""
		update AnalysisResult r set r.processingStatus = com.focusrecovery.domain.analysis.entity.AnalysisStatus.FAILED,
			r.errorCode = :errorCode, r.completedAt = :now
		where r.processingStatus = com.focusrecovery.domain.analysis.entity.AnalysisStatus.PENDING
			and r.requestedAt < :cutoff""")
	int failPendingRequestedBefore(Instant cutoff, String errorCode, Instant now);

	// started_at이 없는 RUNNING은 V5 이전에 시작된 행이다: 시작 시각을 모르므로 requested_at과 별도 기준(legacyCutoff)으로 판단한다
	@Modifying
	@Query("""
		update AnalysisResult r set r.processingStatus = com.focusrecovery.domain.analysis.entity.AnalysisStatus.FAILED,
			r.errorCode = :errorCode, r.completedAt = :now
		where r.processingStatus = com.focusrecovery.domain.analysis.entity.AnalysisStatus.RUNNING
			and (r.startedAt < :cutoff or (r.startedAt is null and r.requestedAt < :legacyCutoff))""")
	int failRunningStartedBefore(Instant cutoff, Instant legacyCutoff, String errorCode, Instant now);
}

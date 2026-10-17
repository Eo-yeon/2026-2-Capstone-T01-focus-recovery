package com.focusrecovery.domain.visit.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

import com.focusrecovery.domain.visit.dto.PageVisitSummaryResponse;
import com.focusrecovery.domain.visit.entity.PageVisit;

import jakarta.persistence.LockModeType;

public interface PageVisitRepository extends JpaRepository<PageVisit, UUID> {

	boolean existsBySessionIdAndSequence(UUID sessionId, int sequence);

	// 구간 구성에는 ID와 순서만 필요하므로 content 등 큰 컬럼을 읽지 않는다
	List<VisitSequence> findBySessionIdAndSequenceGreaterThanOrderBySequence(UUID sessionId, int sequence);

	Optional<VisitSequence> findByVisitId(UUID visitId);

	List<VisitSequence> findByVisitIdIn(List<UUID> visitIds);

	interface VisitSequence {
		UUID getVisitId();

		int getSequence();
	}

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	Optional<PageVisit> findForUpdateByVisitIdAndSessionId(UUID visitId, UUID sessionId);

	// 목록에는 content가 필요 없으므로 MEDIUMTEXT를 읽지 않도록 필요한 컬럼만 조회한다
	@Query(value = """
		select new com.focusrecovery.domain.visit.dto.PageVisitSummaryResponse(
			v.visitId, v.sessionId, v.sequence, v.browserTabKey, v.normalizedUrl, v.domain, v.title, v.searchQuery,
			v.searchResultPage, v.visitedAt, v.activeDurationMs, v.tabSwitchCount, v.behaviorVersion, v.updatedAt)
		from PageVisit v where v.sessionId = :sessionId order by v.sequence""",
		countQuery = "select count(v) from PageVisit v where v.sessionId = :sessionId")
	Page<PageVisitSummaryResponse> findSummariesBySessionId(UUID sessionId, Pageable pageable);
}

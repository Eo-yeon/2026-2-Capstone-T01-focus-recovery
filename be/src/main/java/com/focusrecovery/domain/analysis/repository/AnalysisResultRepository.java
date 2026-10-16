package com.focusrecovery.domain.analysis.repository;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import com.focusrecovery.domain.analysis.entity.AnalysisResult;

import jakarta.persistence.LockModeType;

public interface AnalysisResultRepository extends JpaRepository<AnalysisResult, UUID> {

	// 상태 전이(PENDING→RUNNING, RUNNING→완료/실패)를 분석 행 단위로 직렬화한다. AI 호출 중에는 잡지 않는다
	@Lock(LockModeType.PESSIMISTIC_WRITE)
	Optional<AnalysisResult> findForUpdateByAnalysisId(UUID analysisId);

	Optional<AnalysisResult> findByWindowId(UUID windowId);
}

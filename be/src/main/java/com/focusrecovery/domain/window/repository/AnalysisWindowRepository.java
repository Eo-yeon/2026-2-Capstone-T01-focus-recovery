package com.focusrecovery.domain.window.repository;

import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.focusrecovery.domain.window.entity.AnalysisWindow;

public interface AnalysisWindowRepository extends JpaRepository<AnalysisWindow, UUID> {

	@Query("select coalesce(max(w.windowIndex), 0) from AnalysisWindow w where w.sessionId = :sessionId")
	int findLastWindowIndex(UUID sessionId);
}

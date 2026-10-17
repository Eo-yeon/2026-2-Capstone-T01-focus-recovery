package com.focusrecovery.domain.window.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.focusrecovery.domain.window.entity.AnalysisWindow;

public interface AnalysisWindowRepository extends JpaRepository<AnalysisWindow, UUID> {

	Optional<AnalysisWindow> findFirstBySessionIdOrderByWindowIndexDesc(UUID sessionId);

	@Query("""
		select w from AnalysisWindow w where w.sessionId = :sessionId
		and not exists (select 1 from AnalysisResult r where r.windowId = w.windowId)""")
	List<AnalysisWindow> findUnrequestedBySessionId(UUID sessionId);
}

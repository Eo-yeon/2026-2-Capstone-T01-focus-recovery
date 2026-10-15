package com.focusrecovery.domain.window.repository;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.focusrecovery.domain.window.entity.AnalysisWindow;

public interface AnalysisWindowRepository extends JpaRepository<AnalysisWindow, UUID> {

	Optional<AnalysisWindow> findFirstBySessionIdOrderByWindowIndexDesc(UUID sessionId);
}

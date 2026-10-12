package com.focusrecovery.domain.session.repository;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.focusrecovery.domain.session.entity.WorkSession;

public interface WorkSessionRepository extends JpaRepository<WorkSession, UUID> {

	Optional<WorkSession> findByIdempotencyKey(String idempotencyKey);
}

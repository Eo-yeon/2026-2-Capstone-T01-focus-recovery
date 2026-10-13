package com.focusrecovery.domain.session.repository;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import com.focusrecovery.domain.session.entity.WorkSession;

import jakarta.persistence.LockModeType;

public interface WorkSessionRepository extends JpaRepository<WorkSession, UUID> {

	Optional<WorkSession> findByIdempotencyKey(String idempotencyKey);

	// 공유 잠금: 방문 저장·갱신끼리는 동시에 진행되고, 세션 상태 변경(종료)과는 직렬화된다
	@Lock(LockModeType.PESSIMISTIC_READ)
	Optional<WorkSession> findForShareBySessionId(UUID sessionId);
}

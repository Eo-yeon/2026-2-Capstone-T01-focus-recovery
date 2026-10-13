package com.focusrecovery.domain.session.service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.session.dto.WorkSessionResponse;
import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.exception.IdempotencyKeyMismatchException;
import com.focusrecovery.domain.session.exception.SessionNotFoundException;
import com.focusrecovery.domain.session.repository.WorkSessionRepository;

@Service
public class WorkSessionService {

	private final WorkSessionRepository workSessionRepository;

	public WorkSessionService(WorkSessionRepository workSessionRepository) {
		this.workSessionRepository = workSessionRepository;
	}

	// 트랜잭션을 걸지 않는다: 동시 요청으로 유니크 제약이 위반되면 저장 트랜잭션이 끝난 뒤 다시 조회해야 한다
	public WorkSessionResponse create(String goalText, String idempotencyKey) {
		String strippedGoal = goalText.strip();
		if (idempotencyKey == null) {
			return WorkSessionResponse.from(workSessionRepository.save(WorkSession.start(strippedGoal, null)));
		}
		return workSessionRepository.findByIdempotencyKey(idempotencyKey)
			.map(existing -> replay(existing, strippedGoal))
			.orElseGet(() -> {
				try {
					return WorkSessionResponse.from(
						workSessionRepository.saveAndFlush(WorkSession.start(strippedGoal, idempotencyKey)));
				} catch (DataIntegrityViolationException e) {
					// 같은 키의 동시 요청이 먼저 저장된 경우: 그 세션을 반환한다
					WorkSession existing = workSessionRepository.findByIdempotencyKey(idempotencyKey).orElseThrow(() -> e);
					return replay(existing, strippedGoal);
				}
			});
	}

	private WorkSessionResponse replay(WorkSession existing, String goalText) {
		if (!existing.getGoalText().equals(goalText)) {
			throw new IdempotencyKeyMismatchException();
		}
		return WorkSessionResponse.from(existing);
	}

	// 세션 행을 배타 잠금으로 조회하므로 방문 저장·갱신(공유 잠금)과 동시 종료 요청이 모두 직렬화된다
	@Transactional
	public WorkSessionResponse end(UUID sessionId) {
		WorkSession session = workSessionRepository.findForUpdateBySessionId(sessionId)
			.orElseThrow(SessionNotFoundException::new);
		session.end(Instant.now().truncatedTo(ChronoUnit.MILLIS));
		return WorkSessionResponse.from(session);
	}

	@Transactional(readOnly = true)
	public WorkSessionResponse get(UUID sessionId) {
		return workSessionRepository.findById(sessionId)
			.map(WorkSessionResponse::from)
			.orElseThrow(SessionNotFoundException::new);
	}
}

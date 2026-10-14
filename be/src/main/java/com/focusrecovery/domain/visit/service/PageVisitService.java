package com.focusrecovery.domain.visit.service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import com.focusrecovery.domain.session.dto.EndWorkSessionRequest;
import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.entity.WorkSessionStatus;
import com.focusrecovery.domain.session.exception.SessionNotFoundException;
import com.focusrecovery.domain.session.repository.WorkSessionRepository;
import com.focusrecovery.domain.visit.dto.CreatePageVisitRequest;
import com.focusrecovery.domain.visit.dto.PageVisitPageResponse;
import com.focusrecovery.domain.visit.dto.PageVisitResponse;
import com.focusrecovery.domain.visit.dto.UpdateVisitBehaviorRequest;
import com.focusrecovery.domain.visit.dto.VisitBehaviorResponse;
import com.focusrecovery.domain.visit.entity.PageVisit;
import com.focusrecovery.domain.visit.exception.VisitNotFoundException;
import com.focusrecovery.domain.visit.repository.PageVisitRepository;
import com.focusrecovery.global.exception.ConflictException;

@Service
public class PageVisitService {

	private final WorkSessionRepository workSessionRepository;
	private final PageVisitRepository pageVisitRepository;
	private final TransactionTemplate transactionTemplate;

	public PageVisitService(WorkSessionRepository workSessionRepository, PageVisitRepository pageVisitRepository,
		TransactionTemplate transactionTemplate) {
		this.workSessionRepository = workSessionRepository;
		this.pageVisitRepository = pageVisitRepository;
		this.transactionTemplate = transactionTemplate;
	}

	public record SaveResult(PageVisitResponse visit, boolean created) {
	}

	// 동시 저장으로 PK·UNIQUE 제약이 위반되면 그 트랜잭션은 롤백되므로, 새 트랜잭션에서 먼저 저장된 방문을 기준으로 다시 판단한다
	public SaveResult save(UUID sessionId, CreatePageVisitRequest request) {
		PageVisit candidate = request.toEntity(sessionId);
		try {
			return transactionTemplate.execute(status -> saveOrReplay(candidate));
		} catch (DataIntegrityViolationException e) {
			return transactionTemplate.execute(status -> replayOrConflict(candidate).orElseThrow(() -> e));
		}
	}

	private SaveResult saveOrReplay(PageVisit candidate) {
		WorkSession session = workSessionRepository.findForShareBySessionId(candidate.getSessionId())
			.orElseThrow(SessionNotFoundException::new);
		Optional<SaveResult> replay = replayOrConflict(candidate);
		if (replay.isPresent()) {
			return replay.get();
		}
		if (session.getStatus() == WorkSessionStatus.ENDED) {
			throw sessionEnded();
		}
		pageVisitRepository.saveAndFlush(candidate);
		return new SaveResult(PageVisitResponse.from(candidate), true);
	}

	private Optional<SaveResult> replayOrConflict(PageVisit candidate) {
		Optional<PageVisit> existing = pageVisitRepository.findById(candidate.getVisitId());
		if (existing.isPresent()) {
			if (!existing.get().hasSameOriginal(candidate)) {
				throw new ConflictException("VISIT_ID_CONFLICT", "같은 방문 ID로 다른 방문 정보가 전달되었습니다.");
			}
			return Optional.of(new SaveResult(PageVisitResponse.from(existing.get()), false));
		}
		if (pageVisitRepository.existsBySessionIdAndSequence(candidate.getSessionId(), candidate.getSequence())) {
			throw new ConflictException("VISIT_SEQUENCE_CONFLICT", "같은 세션의 방문 순서가 이미 다른 방문에 사용되었습니다.");
		}
		return Optional.empty();
	}

	// 방문 행을 FOR UPDATE로 잠근 뒤 버전을 비교하므로 동시 요청에서도 낮은 버전이 높은 버전을 덮어쓰지 않는다
	@Transactional
	public VisitBehaviorResponse updateBehavior(UUID sessionId, UUID visitId, UpdateVisitBehaviorRequest request) {
		WorkSession session = workSessionRepository.findForShareBySessionId(sessionId)
			.orElseThrow(SessionNotFoundException::new);
		PageVisit visit = pageVisitRepository.findForUpdateByVisitIdAndSessionId(visitId, sessionId)
			.orElseThrow(VisitNotFoundException::new);
		if (session.getStatus() == WorkSessionStatus.ENDED) {
			throw sessionEnded();
		}

		boolean applied = applyBehavior(visit, request.activeDurationMs(), request.tabSwitchCount(),
			request.behaviorVersion(), Instant.now().truncatedTo(ChronoUnit.MILLIS));
		return VisitBehaviorResponse.of(visit, applied);
	}

	// 세션 종료 트랜잭션 안에서만 호출한다: 하나라도 실패하면 예외로 행동 정보와 종료가 함께 롤백된다
	@Transactional(propagation = Propagation.MANDATORY)
	public void applyFinalBehaviors(UUID sessionId, List<EndWorkSessionRequest.FinalBehavior> behaviors, Instant now) {
		for (EndWorkSessionRequest.FinalBehavior behavior : behaviors) {
			PageVisit visit = pageVisitRepository.findForUpdateByVisitIdAndSessionId(UUID.fromString(behavior.visitId()), sessionId)
				.orElseThrow(VisitNotFoundException::new);
			applyBehavior(visit, behavior.activeDurationMs(), behavior.tabSwitchCount(), behavior.behaviorVersion(), now);
		}
	}

	private boolean applyBehavior(PageVisit visit, long duration, int tabSwitches, long version, Instant now) {
		if (version < visit.getBehaviorVersion()) {
			return false;
		}
		if (version == visit.getBehaviorVersion()) {
			if (duration == visit.getActiveDurationMs() && tabSwitches == visit.getTabSwitchCount()) {
				return false;
			}
			throw new ConflictException("BEHAVIOR_VERSION_CONFLICT", "같은 행동 갱신 버전에 다른 값이 전달되었습니다.");
		}
		if (duration < visit.getActiveDurationMs() || tabSwitches < visit.getTabSwitchCount()) {
			throw new ConflictException("BEHAVIOR_COUNTER_DECREASED", "더 높은 버전에서 누적값이 감소했습니다.");
		}
		visit.updateBehavior(duration, tabSwitches, version, now);
		return true;
	}

	@Transactional(readOnly = true)
	public PageVisitPageResponse list(UUID sessionId, int page, int size) {
		if (!workSessionRepository.existsById(sessionId)) {
			throw new SessionNotFoundException();
		}
		return PageVisitPageResponse.from(
			pageVisitRepository.findSummariesBySessionId(sessionId, PageRequest.of(page, size)));
	}

	private static ConflictException sessionEnded() {
		return new ConflictException("SESSION_ENDED", "종료된 작업 세션입니다.");
	}
}

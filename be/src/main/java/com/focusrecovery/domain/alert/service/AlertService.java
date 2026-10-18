package com.focusrecovery.domain.alert.service;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.alert.dto.AlertResponse;
import com.focusrecovery.domain.alert.entity.AlertType;
import com.focusrecovery.domain.alert.entity.Notification;
import com.focusrecovery.domain.alert.repository.NotificationRepository;
import com.focusrecovery.domain.analysis.entity.AnalysisResult;
import com.focusrecovery.domain.analysis.entity.AnalysisStatus;
import com.focusrecovery.domain.analysis.repository.AnalysisResultRepository;
import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.entity.WorkSessionStatus;
import com.focusrecovery.domain.session.exception.SessionNotFoundException;
import com.focusrecovery.domain.session.repository.WorkSessionRepository;
import com.focusrecovery.domain.window.entity.AnalysisWindow;
import com.focusrecovery.domain.window.repository.AnalysisWindowRepository;
import com.focusrecovery.global.exception.ConflictException;

// 알림 후보 생성. 후보 생성과 실제 표시는 별개이며, shownAt이 없는 후보는 표시된 것으로 보지 않는다.
// 잠금 순서는 다른 쓰기와 같이 세션 → 나머지다(종료·방문 저장은 세션 쓰기 잠금, AI 후보는 세션 공유 잠금, 고정 주기는 세션 쓰기 잠금)
@Service
public class AlertService {

	static final String AI_MESSAGE = "최근 탐색이 작업 목표에서 벗어난 것으로 보입니다. 목표를 다시 확인해 보세요.";
	static final String FIXED_INTERVAL_MESSAGE = "작업 목표를 다시 확인해 보세요.";

	private final AlertProperties properties;
	private final Clock clock;
	private final NotificationRepository notificationRepository;
	private final WorkSessionRepository workSessionRepository;
	private final AnalysisResultRepository analysisResultRepository;
	private final AnalysisWindowRepository analysisWindowRepository;

	public AlertService(AlertProperties properties, Clock clock, NotificationRepository notificationRepository,
		WorkSessionRepository workSessionRepository, AnalysisResultRepository analysisResultRepository,
		AnalysisWindowRepository analysisWindowRepository) {
		this.properties = properties;
		this.clock = clock;
		this.notificationRepository = notificationRepository;
		this.workSessionRepository = workSessionRepository;
		this.analysisResultRepository = analysisResultRepository;
		this.analysisWindowRepository = analysisWindowRepository;
	}

	public record FixedIntervalResult(AlertResponse alert, boolean created) {
	}

	// 분석 결과가 COMPLETED·DRIFT로 커밋된 뒤 별도 트랜잭션에서 호출된다. 조건을 통과하면 AI 후보를 만든다(잠정 정책):
	// AI 모드, ACTIVE 세션, 분석 구간이 실제 analysis_window의 최신 구간, 같은 분석의 후보 없음,
	// 실제 표시된 AI 알림이 있으면 그 뒤에 NORMAL·TRANSITION으로 완료된 구간이 있고 마지막 shownAt부터 최소 간격이 지났을 것
	@Transactional
	public Optional<Notification> createAiCandidate(UUID sessionId, UUID analysisId) {
		WorkSession session = workSessionRepository.findForShareBySessionId(sessionId).orElse(null);
		if (properties.mode() != AlertType.AI || session == null || session.getStatus() != WorkSessionStatus.ACTIVE) {
			return Optional.empty();
		}
		// 세션 → 분석 행 순서로 잠근다: 같은 분석의 동시 호출은 여기서 직렬화되어 후보 존재를 확인한 뒤 하나만 만든다
		AnalysisResult analysis = analysisResultRepository.findForUpdateByAnalysisId(analysisId)
			.filter(found -> found.getProcessingStatus() == AnalysisStatus.COMPLETED && "DRIFT".equals(found.getResult()))
			.orElse(null);
		if (analysis == null || notificationRepository.existsByAnalysisId(analysisId)) {
			return Optional.empty();
		}
		int windowIndex = analysisWindowRepository.findById(analysis.getWindowId()).orElseThrow().getWindowIndex();
		if (latestWindowIndex(sessionId) != windowIndex || !driftFlowAllowsAlert(sessionId, windowIndex)) {
			return Optional.empty();
		}
		return Optional.of(notificationRepository.save(Notification.ai(sessionId, analysisId, AI_MESSAGE, now())));
	}

	// 실제 표시된 AI 알림이 없으면 허용한다. 있으면 그 구간 뒤에 정상 복귀(NORMAL·TRANSITION 완료)가 있어야 하고
	// (실패·PENDING·RUNNING·분석 없음은 복귀로 보지 않음) 마지막 shownAt부터 최소 간격이 지나야 한다. 순서는 windowIndex 기준
	private boolean driftFlowAllowsAlert(UUID sessionId, int windowIndex) {
		Optional<Integer> lastShownWindow = notificationRepository.findLastShownAiWindowIndex(sessionId);
		if (lastShownWindow.isEmpty()) {
			return true;
		}
		if (!analysisResultRepository.existsCompletedBetween(sessionId, lastShownWindow.get(), windowIndex,
			AnalysisStatus.COMPLETED)) {
			return false;
		}
		Instant lastShownAt = notificationRepository.findLastShownAt(sessionId, AlertType.AI).orElseThrow();
		return !now().isBefore(lastShownAt.plus(properties.ai().minInterval()));
	}

	// 신규 201 / 미표시 후보 재반환 200. 세션 쓰기 잠금으로 동시 요청을 직렬화해 후보를 하나만 만든다
	@Transactional
	public FixedIntervalResult requestFixedInterval(UUID sessionId) {
		WorkSession session = workSessionRepository.findForUpdateBySessionId(sessionId)
			.orElseThrow(SessionNotFoundException::new);
		if (properties.mode() != AlertType.FIXED_INTERVAL) {
			throw new ConflictException("FIXED_INTERVAL_DISABLED", "고정 주기 알림이 활성화되어 있지 않습니다.");
		}
		if (session.getStatus() == WorkSessionStatus.ENDED) {
			throw new ConflictException("SESSION_ENDED", "종료된 작업 세션입니다.");
		}
		Optional<Notification> unshown = notificationRepository
			.findFirstBySessionIdAndAlertTypeAndShownAtIsNullOrderByCreatedAtDesc(sessionId, AlertType.FIXED_INTERVAL);
		if (unshown.isPresent()) {
			return new FixedIntervalResult(AlertResponse.of(unshown.get(), null, session.getGoalText()), false);
		}
		Instant base = notificationRepository.findLastShownAt(sessionId, AlertType.FIXED_INTERVAL)
			.orElse(session.getStartedAt());
		Instant now = now();
		if (now.isBefore(base.plus(properties.fixedInterval().interval()))) {
			throw new ConflictException("ALERT_INTERVAL_NOT_REACHED", "고정 주기 알림 간격이 아직 지나지 않았습니다.");
		}
		Notification created = notificationRepository.save(
			Notification.fixedInterval(sessionId, FIXED_INTERVAL_MESSAGE, now));
		return new FixedIntervalResult(AlertResponse.of(created, null, session.getGoalText()), true);
	}

	// 분석 상태 조회용(읽기 전용, 후보를 만들지 않음): ACTIVE 세션에서 현재 활성화된 방식의 미표시 후보만 반환한다.
	// AI 후보는 실제 최신 구간의 COMPLETED·DRIFT 분석에 연결되고 현재 표시 이력·최소 간격 조건도 통과한 것만 반환한다
	public AlertResponse currentCandidate(WorkSession session) {
		if (session.getStatus() != WorkSessionStatus.ACTIVE) {
			return null;
		}
		if (properties.mode() == AlertType.FIXED_INTERVAL) {
			return notificationRepository.findFirstBySessionIdAndAlertTypeAndShownAtIsNullOrderByCreatedAtDesc(
					session.getSessionId(), AlertType.FIXED_INTERVAL)
				.map(notification -> AlertResponse.of(notification, null, session.getGoalText()))
				.orElse(null);
		}
		return analysisWindowRepository.findFirstBySessionIdOrderByWindowIndexDesc(session.getSessionId())
			.flatMap(latest -> analysisResultRepository.findByWindowId(latest.getWindowId())
				.filter(analysis -> analysis.getProcessingStatus() == AnalysisStatus.COMPLETED
					&& "DRIFT".equals(analysis.getResult()))
				.flatMap(analysis -> notificationRepository.findByAnalysisIdAndShownAtIsNull(analysis.getAnalysisId()))
				// 후보 생성 뒤 다른 알림이 실제 표시되었을 수 있으므로 현재 표시 이력·최소 간격으로 다시 확인한다(필터링만 함)
				.filter(notification -> driftFlowAllowsAlert(session.getSessionId(), latest.getWindowIndex()))
				.map(notification -> AlertResponse.of(notification, latest.getWindowIndex(), session.getGoalText())))
			.orElse(null);
	}

	private int latestWindowIndex(UUID sessionId) {
		return analysisWindowRepository.findFirstBySessionIdOrderByWindowIndexDesc(sessionId)
			.map(AnalysisWindow::getWindowIndex).orElse(0);
	}

	private Instant now() {
		return clock.instant().truncatedTo(ChronoUnit.MILLIS);
	}
}

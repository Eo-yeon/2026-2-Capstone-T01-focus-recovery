package com.focusrecovery.domain.alert.service;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
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
import com.focusrecovery.global.exception.StoredDataException;

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

	// AI 후보 판단 결과: 새로 만들었거나 이미 있으면 notification, 정책 조건 미충족이면 skipReason
	public record AiDecision(Notification notification, boolean newlyCreated, String skipReason) {

		static AiDecision created(Notification notification, boolean newlyCreated) {
			return new AiDecision(notification, newlyCreated, null);
		}

		static AiDecision skipped(String reason) {
			return new AiDecision(null, false, reason);
		}
	}

	@Transactional
	public Optional<Notification> createAiCandidate(UUID sessionId, UUID analysisId) {
		AiDecision decision = decideAiCandidate(sessionId, analysisId);
		return decision.newlyCreated() ? Optional.of(decision.notification()) : Optional.empty();
	}

	// 처리할 때마다 현재 상태로 다시 판단한다(잠정 정책): 같은 분석의 후보가 이미 있으면 그것을 쓰고, 아니면
	// AI 모드, ACTIVE 세션, COMPLETED·DRIFT, 실제 analysis_window의 최신 구간, 실제 표시 이력·최소 간격 조건을 모두 통과해야 만든다.
	// 잠금은 세션(공유) → 분석 행 순서이며, 같은 분석의 동시 호출은 분석 행 잠금에서 직렬화되어 후보는 하나만 생긴다
	@Transactional(propagation = Propagation.MANDATORY)
	public AiDecision decideAiCandidate(UUID sessionId, UUID analysisId) {
		WorkSession session = workSessionRepository.findForShareBySessionId(sessionId).orElse(null);
		AnalysisResult analysis = analysisResultRepository.findForUpdateByAnalysisId(analysisId).orElse(null);
		// windowIndex는 세션마다 따로 매겨지므로 번호 비교로는 소속을 알 수 없다. 분석 → 구간 → 세션 연결을
		// windowIndex 비교·기존 후보 재사용보다 먼저 확인하며, 불일치는 조건 미충족이 아니라 데이터 정합성 오류다
		AnalysisWindow window = analysis == null ? null
			: analysisWindowRepository.findById(analysis.getWindowId()).orElseThrow();
		if (window != null && !window.getSessionId().equals(sessionId)) {
			throw new StoredDataException("분석이 요청한 세션에 속하지 않습니다. analysisId=" + analysisId
				+ " sessionId=" + sessionId);
		}
		Optional<Notification> existing = notificationRepository.findByAnalysisId(analysisId);
		if (existing.isPresent()) {
			if (!existing.get().getSessionId().equals(sessionId)) {
				throw new StoredDataException("기존 후보가 요청한 세션에 속하지 않습니다. analysisId=" + analysisId
					+ " alertId=" + existing.get().getAlertId());
			}
			return AiDecision.created(existing.get(), false);
		}
		if (session == null || session.getStatus() != WorkSessionStatus.ACTIVE) {
			return AiDecision.skipped("SESSION_ENDED");
		}
		if (properties.mode() != AlertType.AI) {
			return AiDecision.skipped("MODE_NOT_AI");
		}
		if (analysis == null || analysis.getProcessingStatus() != AnalysisStatus.COMPLETED
			|| !"DRIFT".equals(analysis.getResult())) {
			return AiDecision.skipped("NOT_COMPLETED_DRIFT");
		}
		int windowIndex = window.getWindowIndex();
		if (latestWindowIndex(sessionId) != windowIndex) {
			return AiDecision.skipped("NOT_LATEST_WINDOW");
		}
		String flowBlock = driftFlowBlockReason(sessionId, windowIndex);
		if (flowBlock != null) {
			return AiDecision.skipped(flowBlock);
		}
		return AiDecision.created(notificationRepository.save(Notification.ai(sessionId, analysisId, AI_MESSAGE, now())), true);
	}

	// 실제 표시된 AI 알림이 없으면 허용(null). 있으면 그 구간 뒤에 정상 복귀(NORMAL·TRANSITION 완료)가 있어야 하고
	// (실패·PENDING·RUNNING·분석 없음은 복귀로 보지 않음) 마지막 shownAt부터 최소 간격이 지나야 한다. 순서는 windowIndex 기준
	private String driftFlowBlockReason(UUID sessionId, int windowIndex) {
		Optional<Integer> lastShownWindow = notificationRepository.findLastShownAiWindowIndex(sessionId);
		if (lastShownWindow.isEmpty()) {
			return null;
		}
		if (!analysisResultRepository.existsCompletedBetween(sessionId, lastShownWindow.get(), windowIndex,
			AnalysisStatus.COMPLETED)) {
			return "DRIFT_FLOW_CONTINUES";
		}
		Instant lastShownAt = notificationRepository.findLastShownAt(sessionId, AlertType.AI).orElseThrow();
		return now().isBefore(lastShownAt.plus(properties.ai().minInterval())) ? "MIN_INTERVAL_NOT_PASSED" : null;
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
				.filter(notification -> driftFlowBlockReason(session.getSessionId(), latest.getWindowIndex()) == null)
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

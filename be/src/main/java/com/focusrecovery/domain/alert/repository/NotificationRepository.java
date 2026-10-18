package com.focusrecovery.domain.alert.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

import com.focusrecovery.domain.alert.entity.AlertType;
import com.focusrecovery.domain.alert.entity.Notification;

import jakarta.persistence.LockModeType;

public interface NotificationRepository extends JpaRepository<Notification, UUID> {

	Optional<Notification> findByAnalysisId(UUID analysisId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	Optional<Notification> findForUpdateByAlertId(UUID alertId);

	Optional<Notification> findByAnalysisIdAndShownAtIsNull(UUID analysisId);

	Optional<Notification> findBySessionIdAndScheduledAt(UUID sessionId, Instant scheduledAt);

	@Query("select max(n.shownAt) from Notification n where n.sessionId = :sessionId and n.alertType = :alertType")
	Optional<Instant> findLastShownAt(UUID sessionId, AlertType alertType);

	// 실제 표시된 AI 알림 중 가장 뒤 구간의 windowIndex (shownAt이 없는 후보는 표시된 것으로 보지 않는다)
	@Query("""
		select max(w.windowIndex) from Notification n
		join AnalysisResult r on r.analysisId = n.analysisId
		join AnalysisWindow w on w.windowId = r.windowId
		where n.sessionId = :sessionId and n.alertType = com.focusrecovery.domain.alert.entity.AlertType.AI
			and n.shownAt is not null""")
	Optional<Integer> findLastShownAiWindowIndex(UUID sessionId);
}

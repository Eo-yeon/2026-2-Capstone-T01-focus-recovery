package com.focusrecovery.domain.alert.service;

import java.util.UUID;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.focusrecovery.domain.alert.dto.AlertHistoryItem;
import com.focusrecovery.domain.alert.dto.AlertHistoryPageResponse;
import com.focusrecovery.domain.alert.repository.NotificationRepository;
import com.focusrecovery.domain.session.entity.WorkSession;
import com.focusrecovery.domain.session.exception.SessionNotFoundException;
import com.focusrecovery.domain.session.repository.WorkSessionRepository;

// 알림·사용자 선택 이력 조회(읽기 전용). 현재 후보 여부·알림 모드·표시 가능 조건과 무관하게 세션의 모든 알림을 반환하며,
// AI 호출·후보 생성·shownAt 기록·복구 처리를 하지 않는다
@Service
@Transactional(readOnly = true)
public class AlertHistoryService {

	private final WorkSessionRepository workSessionRepository;
	private final NotificationRepository notificationRepository;

	public AlertHistoryService(WorkSessionRepository workSessionRepository, NotificationRepository notificationRepository) {
		this.workSessionRepository = workSessionRepository;
		this.notificationRepository = notificationRepository;
	}

	public AlertHistoryPageResponse history(UUID sessionId, int page, int size) {
		WorkSession session = workSessionRepository.findById(sessionId).orElseThrow(SessionNotFoundException::new);
		return AlertHistoryPageResponse.from(notificationRepository.findHistoryBySessionId(sessionId, PageRequest.of(page, size))
			.map(row -> AlertHistoryItem.of(row, session.getGoalText())));
	}
}

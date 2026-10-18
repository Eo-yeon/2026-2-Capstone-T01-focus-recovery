package com.focusrecovery.domain.alert.repository;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.focusrecovery.domain.alert.entity.NotificationResponse;

public interface NotificationResponseRepository extends JpaRepository<NotificationResponse, UUID> {

	Optional<NotificationResponse> findByAlertId(UUID alertId);
}

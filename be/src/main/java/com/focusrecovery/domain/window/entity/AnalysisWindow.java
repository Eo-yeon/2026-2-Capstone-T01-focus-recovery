package com.focusrecovery.domain.window.entity;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import org.springframework.data.domain.Persistable;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.PostLoad;
import jakarta.persistence.PostPersist;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;

@Entity
@Table(name = "analysis_window")
public class AnalysisWindow implements Persistable<UUID> {

	@Id
	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "window_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID windowId;

	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "session_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID sessionId;

	@Column(name = "window_index", nullable = false, updatable = false)
	private int windowIndex;

	@Column(name = "window_size", nullable = false, updatable = false)
	private int windowSize;

	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "start_visit_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID startVisitId;

	@JdbcTypeCode(SqlTypes.CHAR)
	@Column(name = "end_visit_id", columnDefinition = "CHAR(36)", nullable = false, updatable = false)
	private UUID endVisitId;

	@Column(name = "created_at", columnDefinition = "DATETIME(3)", nullable = false, updatable = false)
	private Instant createdAt;

	@ElementCollection
	@CollectionTable(name = "window_visit", joinColumns = @JoinColumn(name = "window_id"))
	private List<WindowVisit> visits = new ArrayList<>();

	// 서버가 ID를 발급하므로 save()가 merge(조회 후 INSERT)하지 않도록 항상 INSERT 하게 한다
	@Transient
	private boolean isNew = true;

	protected AnalysisWindow() {
	}

	// visitIds는 같은 세션의 연속된 방문을 sequence 순서로 담는다
	public static AnalysisWindow of(UUID sessionId, int windowIndex, List<UUID> visitIds, Instant createdAt) {
		AnalysisWindow window = new AnalysisWindow();
		window.windowId = UUID.randomUUID();
		window.sessionId = sessionId;
		window.windowIndex = windowIndex;
		window.windowSize = visitIds.size();
		window.startVisitId = visitIds.getFirst();
		window.endVisitId = visitIds.getLast();
		window.createdAt = createdAt;
		for (int i = 0; i < visitIds.size(); i++) {
			window.visits.add(new WindowVisit(visitIds.get(i), i + 1));
		}
		return window;
	}

	@PostLoad
	@PostPersist
	void markNotNew() {
		isNew = false;
	}

	@Override
	public UUID getId() {
		return windowId;
	}

	@Override
	public boolean isNew() {
		return isNew;
	}
}

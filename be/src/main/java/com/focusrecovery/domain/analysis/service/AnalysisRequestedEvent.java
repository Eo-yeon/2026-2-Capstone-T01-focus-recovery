package com.focusrecovery.domain.analysis.service;

import java.util.List;
import java.util.UUID;

public record AnalysisRequestedEvent(List<UUID> analysisIds) {
}

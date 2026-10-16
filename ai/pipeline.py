import math
from dataclasses import dataclass, replace
from typing import Iterator, List, Optional, Sequence

from models.classifier import DriftClassifier
from models.context import WINDOW_SIZE, ContextAnalysisResult, LocalContextModel, PageVisit
from models.embedding import LocalSemanticEmbeddingModel

STRIDE = 1


@dataclass
class PipelineResult:
    semantic_relevances: List[float]           # AI-001: 탐색 구간 내 페이지별 의미적 관련성 (P1 -> P5)
    context: Optional[ContextAnalysisResult]   # AI-002: Context 분석 결과 (Context 단계 제외 시 None)
    probabilities: dict                        # AI-003: P_NORMAL / P_TRANSITION / P_DRIFT
    result: str                                # AI-003: NORMAL / TRANSITION / DRIFT

    def to_dict(self) -> dict:
        return {
            "semanticRelevances": self.semantic_relevances,
            "context": self.context.to_dict() if self.context is not None else None,
            "probabilities": self.probabilities,
            "result": self.result,
        }


class FocusRecoveryPipeline:
    """
    AI-001 -> AI-002 -> AI-003을 연결하는 분석 파이프라인.

    최초 작업 목표 + Page Visit
        -> Semantic Relevance (AI-001)
        -> Context Analysis   (AI-002, 선택)
        -> Feature 구성
        -> Drift Classification (AI-003)
        -> NORMAL / TRANSITION / DRIFT

    어떤 단계든 실패하면 예외를 그대로 전달하며, 실패를 NORMAL 등의 정상 결과로 대체하지 않는다.
    """

    def __init__(
        self,
        embedding_model: LocalSemanticEmbeddingModel,
        classifier: DriftClassifier,
        context_model: Optional[LocalContextModel] = None,
    ):
        # context_model이 None이면 Context 분석 단계를 제외한다.
        # (Validation 결과 Context Model이 최종 분류 성능 향상에 기여하지 않는 경우)
        self.embedding_model = embedding_model
        self.context_model = context_model
        self.classifier = classifier

    @classmethod
    def from_default(cls, use_context: bool = True, classifier_type: str = "xgboost") -> "FocusRecoveryPipeline":
        print("[Pipeline] AI 모델을 로드합니다...")
        embedding_model = LocalSemanticEmbeddingModel()
        context_model = LocalContextModel() if use_context else None
        classifier = DriftClassifier(model_type=classifier_type)
        print("[Pipeline] 모든 모델 로드가 완료되었습니다.")
        return cls(embedding_model, classifier, context_model)

    # ------------------------------------------------------------------ 입력 검증
    @staticmethod
    def _validate_input(goal: str, visits: Sequence[PageVisit], behavior_features: Sequence[float]) -> None:
        if not goal or not goal.strip():
            raise ValueError("[Pipeline] 유효한 최초 작업 목표가 필요합니다.")
        if len(visits) != WINDOW_SIZE:
            raise ValueError(
                f"[Pipeline] 최근 {WINDOW_SIZE}개의 유효 Page Visit이 필요합니다. (입력: {len(visits)}개)"
            )
        # 행동 특징을 확보할 수 없는 경우 임의의 값을 생성하지 않는다.
        if not behavior_features:
            raise ValueError("[Pipeline] 행동 특징(behavior_features)이 필요합니다.")
        for i, value in enumerate(behavior_features):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"[Pipeline] behavior_features[{i}]가 유효한 숫자가 아닙니다: {value}")

    # ------------------------------------------------------------------ 단계별 처리
    def _compute_semantic_relevances(self, goal: str, visits: Sequence[PageVisit]) -> List[PageVisit]:
        """
        AI-001: 각 Page Visit의 의미적 관련성을 계산한다.
        Stride 1로 구간이 겹치므로, 이미 계산된 값(semantic_relevance)이 있으면 재사용한다.
        """
        scored = []
        for visit in visits:
            if visit.semantic_relevance is None:
                relevance = self.embedding_model.calculate_relevance(goal, visit.title, visit.content)
                visit = replace(visit, semantic_relevance=relevance)
            scored.append(visit)
        return scored

    @staticmethod
    def _build_semantic_features(relevances: Sequence[float]) -> List[float]:
        """
        탐색 구간의 의미적 관련성 변화와 통계를 특징으로 구성한다.
        단일 페이지의 낮은 관련성만으로 판단하지 않도록 구간 전체 통계를 사용한다.
        최종 특징 구성은 Validation 결과를 기준으로 결정한다.
        """
        n = len(relevances)
        mean = sum(relevances) / n
        std = math.sqrt(sum((r - mean) ** 2 for r in relevances) / n)
        return [
            relevances[-1],                   # 최신 페이지 관련성
            mean,                             # 구간 평균
            min(relevances),                  # 구간 최소
            std,                              # 구간 변동성
            relevances[-1] - relevances[0],   # 구간 내 변화량 (P5 - P1)
        ]

    # ------------------------------------------------------------------ 공개 API
    def analyze(self, goal: str, visits: Sequence[PageVisit], behavior_features: Sequence[float]) -> PipelineResult:
        """최초 목표와 최근 5개 Page Visit, 행동 특징으로 탐색 구간의 최종 상태를 분류한다."""
        self._validate_input(goal, visits, behavior_features)

        # 1. AI-001: Semantic Relevance
        scored_visits = self._compute_semantic_relevances(goal, visits)
        relevances = [v.semantic_relevance for v in scored_visits]

        # 2. AI-002: Context Analysis (실패 시 ContextAnalysisError 전달)
        context_result = None
        if self.context_model is not None:
            context_result = self.context_model.analyze(goal, scored_visits)

        # 3. Feature 구성 + AI-003: Drift Classification
        prediction = self.classifier.predict_state(
            semantic_relevance=self._build_semantic_features(relevances),
            context_result_dict=context_result.to_dict() if context_result is not None else None,
            behavior_features=list(behavior_features),
        )

        return PipelineResult(
            semantic_relevances=relevances,
            context=context_result,
            probabilities=prediction["probabilities"],
            result=prediction["final_state"],
        )

    def score_visits(self, goal: str, visits: Sequence[PageVisit]) -> List[PageVisit]:
        """전체 방문 기록의 의미적 관련성을 한 번씩만 계산한다. (sliding window 처리 전 사전 계산용)"""
        if not goal or not goal.strip():
            raise ValueError("[Pipeline] 유효한 최초 작업 목표가 필요합니다.")
        return self._compute_semantic_relevances(goal, visits)


def iter_windows(visits: Sequence[PageVisit], window_size: int = WINDOW_SIZE, stride: int = STRIDE) -> Iterator[List[PageVisit]]:
    """
    유효 Page Visit 목록을 Window Size 5, Stride 1의 탐색 구간으로 나눈다.
    P1~P5 -> Window 1, P2~P6 -> Window 2, ...
    """
    for start in range(0, len(visits) - window_size + 1, stride):
        yield list(visits[start:start + window_size])


# --- 실행 및 검증 예시 코드 ---
if __name__ == "__main__":
    import json

    pipeline = FocusRecoveryPipeline.from_default()

    goal = "Spring Boot에서 JWT 인증 구현 방법 조사하기"
    history = [
        PageVisit("Spring Security + JWT 연동 가이드", "Spring Boot 환경에서 JWT 로그인 및 토큰 검증 필터..."),
        PageVisit("JWT 공식 소개 (jwt.io)", "JSON Web Token 구조: header, payload, signature..."),
        PageVisit("Refresh Token 저장 전략", "쿠키 vs 로컬 스토리지, 토큰 재발급 전략..."),
        PageVisit("개발자 커리어 로드맵 2026", "백엔드 개발자가 연봉을 올리는 방법..."),
        PageVisit("인기 유튜브 개발 채널 추천", "구독자 많은 개발 유튜버 모음..."),
        PageVisit("유튜브 쇼츠 인기 영상", "오늘의 인기 쇼츠 모음..."),
    ]
    # Extension에서 수집한 구간별 행동 특징 예시: [활성 체류시간(초), 탭 전환 횟수]
    behavior_per_window = [[180.0, 3.0], [95.0, 7.0]]

    # 관련성을 한 번만 계산해 두고 겹치는 구간에서 재사용한다.
    scored_history = pipeline.score_visits(goal, history)
    for idx, (window, behavior) in enumerate(zip(iter_windows(scored_history), behavior_per_window), start=1):
        result = pipeline.analyze(goal, window, behavior)
        print(f"\n[Window {idx}]")
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))

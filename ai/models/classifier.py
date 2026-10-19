from pathlib import Path
from typing import Optional, Sequence, Union

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

# 최종 분류 클래스. 확률 배열의 열 순서도 이 순서를 따른다.
LABELS = ("NORMAL", "TRANSITION", "DRIFT")
MODEL_TYPES = ("logistic_regression", "random_forest", "xgboost")


class DriftClassifier:
    """
    AI-003: 의미적 관련성, 탐색 맥락, 행동 특징을 결합하여 탐색 상태(NORMAL, TRANSITION, DRIFT)를 분류합니다.
    학습되지 않은 상태에서는 예측하지 않으며, 임의의 확률로 대체하지 않습니다.
    """
    def __init__(self, model_type='xgboost', threshold_gamma=0.5, use_context=True, use_behavior=True):
        # Logistic Regression, Random Forest, XGBoost를 비교 후보로 둡니다.
        self.model_type = model_type
        self.model = self._create_model(model_type)

        # P(DRIFT) 판정을 위한 임계값 γ(감마)입니다.
        # 이 값은 Validation 데이터에서 결정하며, Test 결과를 이용해 재조정하지 않아야 합니다.
        self.threshold_gamma = threshold_gamma

        # 학습 시 사용한 특징 구성. 추론 시에도 같은 구성을 사용해야 합니다.
        self.use_context = use_context
        self.use_behavior = use_behavior

        self.classes_: Optional[list] = None  # 학습 데이터에 존재한 클래스 (모델 출력 열 순서)
        self.n_features: Optional[int] = None
        self.metadata: dict = {}

    @staticmethod
    def _create_model(model_type):
        if model_type == 'xgboost':
            return XGBClassifier(
                objective="multi:softprob", n_estimators=100, max_depth=3,
                learning_rate=0.1, eval_metric="mlogloss", random_state=42,
            )
        if model_type == 'random_forest':
            return RandomForestClassifier(n_estimators=200, class_weight="balanced", random_state=42)
        if model_type == 'logistic_regression':
            return make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, class_weight="balanced"))
        raise ValueError(f"지원하지 않는 모델 타입입니다: {model_type}")

    @property
    def is_fitted(self) -> bool:
        return self.classes_ is not None

    # ------------------------------------------------------------------ 특징 구성
    def extract_features(self, semantic_relevance, context_result_dict, behavior_features):
        """
        AI-001(Embedding) 결과, AI-002(Context) 결과, Extension 수집(행동 정보)을 하나의 특징 벡터로 병합합니다.
        semantic_relevance는 단일 값 또는 탐색 구간 통계 리스트를 받을 수 있습니다.
        use_context / use_behavior가 꺼져 있으면 해당 특징을 넣지 않습니다.
        필요한 특징이 없으면 임의의 값을 만들지 않고 ValueError를 발생시킵니다.
        """
        if isinstance(semantic_relevance, (list, tuple)):
            semantic_features = list(semantic_relevance)
        else:
            semantic_features = [semantic_relevance]

        context_features = []
        if self.use_context:
            if context_result_dict is None:
                raise ValueError("[AI-003] Context 특징을 사용하는 모델이지만 Context 분석 결과가 없습니다.")
            # context_result_dict는 ContextAnalysisResult.to_dict()의 반환값을 가정합니다.
            context_features = [
                context_result_dict["goalRelevance"],
                context_result_dict["detourJustification"],
                context_result_dict["driftDegree"],
            ]

        behavior = []
        if self.use_behavior:
            # 행동 정보에는 활성 체류시간, 탭 전환 횟수 등이 포함됩니다.
            if not behavior_features:
                raise ValueError("[AI-003] 행동 특징을 사용하는 모델이지만 behavior_features가 없습니다.")
            behavior = list(behavior_features)

        features = semantic_features + context_features + behavior
        return np.array(features, dtype=float).reshape(1, -1)

    # ------------------------------------------------------------------ 학습 / 예측
    def fit(self, X: np.ndarray, y: Sequence[str]) -> "DriftClassifier":
        """y는 LABELS 문자열 리스트. 학습 데이터에 없는 클래스의 확률은 0으로 출력됩니다."""
        unknown = set(y) - set(LABELS)
        if unknown:
            raise ValueError(f"[AI-003] 알 수 없는 라벨입니다: {unknown}")
        classes = [label for label in LABELS if label in set(y)]
        if len(classes) < 2:
            raise ValueError(f"[AI-003] 학습 데이터에 2개 이상의 클래스가 필요합니다. (현재: {classes})")

        # XGBoost는 0부터 연속된 정수 라벨이 필요하므로 학습 데이터에 있는 클래스 기준으로 인코딩합니다.
        encoded = np.array([classes.index(label) for label in y])
        self.model = self._create_model(self.model_type)
        self.model.fit(np.asarray(X, dtype=float), encoded)
        self.classes_ = classes
        self.n_features = np.asarray(X).shape[1]
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """(n, 3) 확률 배열을 LABELS 순서(NORMAL, TRANSITION, DRIFT)로 반환합니다."""
        if not self.is_fitted:
            raise RuntimeError("[AI-003] 학습되지 않은 분류기입니다. 학습된 모델을 로드하세요.")
        X = np.asarray(X, dtype=float)
        if X.shape[1] != self.n_features:
            raise ValueError(f"[AI-003] 특징 수가 학습 시와 다릅니다. (학습: {self.n_features}, 입력: {X.shape[1]})")
        raw = self.model.predict_proba(X)
        probs = np.zeros((X.shape[0], len(LABELS)))
        for col, label in enumerate(self.classes_):
            probs[:, LABELS.index(label)] = raw[:, col]
        return probs

    def decide(self, p_normal: float, p_transition: float, p_drift: float) -> str:
        # 최종 분류 로직: P(DRIFT)가 임계값 γ 이상이면 DRIFT로 판정합니다.
        if p_drift >= self.threshold_gamma:
            return "DRIFT"
        # 그렇지 않으면 P(NORMAL)과 P(TRANSITION) 중 높은 값을 선택합니다.
        return "NORMAL" if p_normal >= p_transition else "TRANSITION"

    def predict_state(self, semantic_relevance, context_result_dict, behavior_features):
        """
        입력 특징들을 통해 P(NORMAL), P(TRANSITION), P(DRIFT)를 도출하고 최종 상태를 판정합니다.
        """
        features_array = self.extract_features(semantic_relevance, context_result_dict, behavior_features)
        p_normal, p_transition, p_drift = (float(p) for p in self.predict_proba(features_array)[0])
        probs = {
            "P_NORMAL": p_normal,
            "P_TRANSITION": p_transition,
            "P_DRIFT": p_drift,
        }
        return {
            "probabilities": probs,
            "final_state": self.decide(p_normal, p_transition, p_drift),
        }

    # ------------------------------------------------------------------ 저장 / 로드
    def save(self, path: Union[str, Path]) -> None:
        if not self.is_fitted:
            raise RuntimeError("[AI-003] 학습되지 않은 분류기는 저장할 수 없습니다.")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({
            "model": self.model,
            "model_type": self.model_type,
            "threshold_gamma": self.threshold_gamma,
            "use_context": self.use_context,
            "use_behavior": self.use_behavior,
            "classes": self.classes_,
            "n_features": self.n_features,
            "metadata": self.metadata,
        }, path)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "DriftClassifier":
        path = Path(path)
        if not path.is_file():
            raise FileNotFoundError(
                f"[AI-003] 학습된 분류기 파일이 없습니다: {path}\n"
                "먼저 `python -m training.train`으로 분류기를 학습하세요."
            )
        state = joblib.load(path)
        clf = cls(
            model_type=state["model_type"],
            threshold_gamma=state["threshold_gamma"],
            use_context=state["use_context"],
            use_behavior=state["use_behavior"],
        )
        clf.model = state["model"]
        clf.classes_ = state["classes"]
        clf.n_features = state["n_features"]
        clf.metadata = state.get("metadata", {})
        return clf

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from xgboost import XGBClassifier
from sklearn.linear_model import LogisticRegression

class DriftClassifier:
    """
    AI-003: 의미적 관련성, 탐색 맥락, 행동 특징을 결합하여 탐색 상태(NORMAL, TRANSITION, DRIFT)를 분류합니다[cite: 7].
    """
    def __init__(self, model_type='xgboost', threshold_gamma=0.5):
        # Logistic Regression, Random Forest, XGBoost를 비교 후보로 둡니다[cite: 3, 7].
        if model_type == 'xgboost':
            self.model = XGBClassifier()
        elif model_type == 'random_forest':
            self.model = RandomForestClassifier()
        elif model_type == 'logistic_regression':
            self.model = LogisticRegression()
        else:
            raise ValueError("지원하지 않는 모델 타입입니다.")
            
        # P(DRIFT) 판정을 위한 임계값 γ(감마)입니다. 
        # 이 값은 Validation 데이터에서 결정하며, Test 결과를 이용해 재조정하지 않아야 합니다[cite: 7, 9].
        self.threshold_gamma = threshold_gamma

    def extract_features(self, semantic_relevance, context_result_dict, behavior_features):
        """
        AI-001(Embedding) 결과, AI-002(Context) 결과, Extension 수집(행동 정보)을 하나의 특징 벡터로 병합합니다[cite: 3, 6, 7].
        semantic_relevance는 단일 값 또는 탐색 구간 통계 리스트를 받을 수 있습니다.
        context_result_dict가 None이면(Context 단계 제외 구성) Context 특징을 넣지 않습니다.
        """
        if isinstance(semantic_relevance, (list, tuple)):
            semantic_features = list(semantic_relevance)
        else:
            semantic_features = [semantic_relevance]

        # context_result_dict는 ContextAnalysisResult.to_dict()의 반환값을 가정합니다.
        # 값이 없을 때 임의의 기본값을 만들지 않도록 직접 인덱싱합니다.
        if context_result_dict is None:
            context_features = []
        else:
            context_features = [
                context_result_dict["goalRelevance"],
                context_result_dict["detourJustification"],
                context_result_dict["driftDegree"],
            ]

        # 행동 정보에는 활성 체류시간, 탭 전환 횟수 등이 포함됩니다[cite: 3, 6].
        # behavior_features는 [활성 체류시간, 탭 전환 횟수, ...] 형태의 리스트라고 가정합니다.

        features = semantic_features + context_features + list(behavior_features)
        return np.array(features, dtype=float).reshape(1, -1)

    def predict_state(self, semantic_relevance, context_result_dict, behavior_features):
        """
        입력 특징들을 통해 P(NORMAL), P(TRANSITION), P(DRIFT)를 도출하고 최종 상태를 판정합니다[cite: 7].
        """
        features_array = self.extract_features(semantic_relevance, context_result_dict, behavior_features)
        
        # TODO: 실제로는 학습된 self.model.predict_proba(features_array)를 통해 클래스별 확률을 가져와야 합니다.
        # 현 단계에서는 임의의 반환 구조 모의(Mock) 데이터를 사용합니다.
        probs = {
            "P_NORMAL": 0.3,
            "P_TRANSITION": 0.2,
            "P_DRIFT": 0.5
        }
        
        # 최종 분류 로직: P(DRIFT)가 임계값 γ 이상이면 DRIFT로 판정합니다[cite: 7].
        if probs["P_DRIFT"] >= self.threshold_gamma:
            final_state = "DRIFT"
        # 그렇지 않으면 P(NORMAL)과 P(TRANSITION) 중 높은 값을 선택합니다[cite: 7].
        else:
            if probs["P_NORMAL"] >= probs["P_TRANSITION"]:
                final_state = "NORMAL"
            else:
                final_state = "TRANSITION"
                
        return {
            "probabilities": probs,
            "final_state": final_state
        }
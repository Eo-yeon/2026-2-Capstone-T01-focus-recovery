"""
AI-003 목표 이탈 분류기 학습 스크립트.

실행 (ai/ 폴더에서):
    python -m training.train                      # Embedding-only (A)
    python -m training.train --use-context        # Embedding + Context (B)

평가 방식:
- 겹치는 Window가 학습/평가에 나뉘지 않도록 그룹(목표 또는 세션) 단위 Leave-One-Group-Out으로 분할한다.
- 바깥 fold의 held-out 그룹은 Test 역할로 결과 보고에만 사용한다.
- 안쪽 fold(Validation)의 예측으로만 임계값 γ와 모델 타입을 결정한다. Test 결과로 다시 조정하지 않는다.

합성 데이터의 candidateLabel은 검토 전 후보 라벨이므로, 출력되는 수치는 학습 코드의 작동 확인용이며
실제 모델 성능으로 해석하지 않는다.
"""
import argparse
import json
import time
from collections import Counter
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
from sklearn.metrics import confusion_matrix, f1_score, recall_score

from models.classifier import LABELS, MODEL_TYPES, DriftClassifier
from training.dataset import WindowSample, load_dataset, verify_sha256

AI_DIR = Path(__file__).resolve().parents[1]
GAMMA_GRID = np.round(np.arange(0.10, 0.91, 0.05), 2)
MIN_GOALS_FOR_GOAL_SPLIT = 3

SEMANTIC_FEATURE_NAMES = ["relevanceLast", "relevanceMean", "relevanceMin", "relevanceStd", "relevanceDelta"]
CONTEXT_FEATURE_NAMES = ["goalRelevance", "detourJustification", "driftDegree"]
BEHAVIOR_FEATURE_NAMES = ["activeDurationSecMean", "tabSwitchCountSum"]


# ---------------------------------------------------------------------- 특징 추출
def build_feature_matrix(samples: List[WindowSample], use_context: bool, use_behavior: bool) -> np.ndarray:
    """추론과 같은 경로(FocusRecoveryPipeline.extract_window_features)로 Window별 특징을 만든다."""
    from models.context import LocalContextModel
    from models.embedding import LocalSemanticEmbeddingModel
    from pipeline import FocusRecoveryPipeline

    embedding_model = LocalSemanticEmbeddingModel()
    context_model = LocalContextModel() if use_context else None
    feature_spec = DriftClassifier(use_context=use_context, use_behavior=use_behavior)
    pipeline = FocusRecoveryPipeline(embedding_model, feature_spec, context_model)

    relevance_cache = {}  # visitId -> semantic relevance (겹치는 Window에서 재사용)
    rows = []
    started = time.time()
    for i, sample in enumerate(samples, start=1):
        visits = []
        for visit_id, visit in zip(sample.visit_ids, sample.visits):
            if visit_id not in relevance_cache:
                relevance_cache[visit_id] = embedding_model.calculate_relevance(
                    sample.goal_text, visit.title, visit.content
                )
            visits.append(replace(visit, semantic_relevance=relevance_cache[visit_id]))

        features, _, _ = pipeline.extract_window_features(
            sample.goal_text, visits, sample.behavior_features if use_behavior else None
        )
        rows.append(features[0])
        print(f"\r[Train] 특징 추출 {i}/{len(samples)} ({time.time() - started:.0f}s)", end="", flush=True)
    print()
    return np.vstack(rows)


# ---------------------------------------------------------------------- 평가 유틸
def predict_states(probs: np.ndarray, gamma: float) -> np.ndarray:
    decider = DriftClassifier(threshold_gamma=gamma)
    return np.array([decider.decide(*row) for row in probs], dtype=object)


def macro_f1(y_true: Sequence[str], y_pred: Sequence[str]) -> float:
    return float(f1_score(y_true, y_pred, labels=list(LABELS), average="macro", zero_division=0))


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    per_class = f1_score(y_true, y_pred, labels=list(LABELS), average=None, zero_division=0)
    drift_recall = recall_score(y_true, y_pred, labels=["DRIFT"], average=None, zero_division=0)[0]
    return {
        "n": int(len(y_true)),
        "macroF1": macro_f1(y_true, y_pred),
        "f1PerClass": {label: float(score) for label, score in zip(LABELS, per_class)},
        "driftRecall": float(drift_recall),
        "confusionMatrix": {
            "labels": list(LABELS),
            "matrix": confusion_matrix(y_true, y_pred, labels=list(LABELS)).tolist(),
        },
    }


def out_of_fold_probs(
    X: np.ndarray, y: np.ndarray, groups: np.ndarray, model_type: str, use_context: bool, use_behavior: bool
) -> Tuple[np.ndarray, List[str]]:
    """Leave-One-Group-Out 예측 확률. 학습 fold에 클래스가 2개 미만이면 해당 그룹은 예측하지 않는다(NaN)."""
    probs = np.full((len(y), len(LABELS)), np.nan)
    skipped = []
    for group in np.unique(groups):
        test = groups == group
        train = ~test
        if len(set(y[train])) < 2:
            skipped.append(str(group))
            continue
        clf = DriftClassifier(model_type, use_context=use_context, use_behavior=use_behavior)
        clf.fit(X[train], y[train])
        probs[test] = clf.predict_proba(X[test])
    return probs, skipped


def choose_gamma(probs: np.ndarray, y: np.ndarray) -> Tuple[float, Optional[float]]:
    """Validation 예측에서 Macro F1이 가장 높은 γ를 고른다. (동점이면 0.5에 가까운 값)"""
    mask = ~np.isnan(probs[:, 0])
    if not mask.any():
        return 0.5, None
    scored = [(macro_f1(y[mask], predict_states(probs[mask], g)), -abs(g - 0.5), float(g)) for g in GAMMA_GRID]
    best_f1, _, best_gamma = max(scored)
    return best_gamma, best_f1


def nested_evaluate(
    X: np.ndarray, y: np.ndarray, groups: np.ndarray, model_type: str, use_context: bool, use_behavior: bool
) -> dict:
    """바깥 fold: Test 보고용 / 안쪽 fold: γ 결정용."""
    preds = np.full(len(y), None, dtype=object)
    folds = []
    for group in np.unique(groups):
        test = groups == group
        train = ~test
        if len(set(y[train])) < 2:
            folds.append({"heldOut": str(group), "skipped": "학습 fold의 클래스가 2개 미만"})
            continue
        inner_probs, _ = out_of_fold_probs(X[train], y[train], groups[train], model_type, use_context, use_behavior)
        gamma, val_f1 = choose_gamma(inner_probs, y[train])

        clf = DriftClassifier(model_type, threshold_gamma=gamma, use_context=use_context, use_behavior=use_behavior)
        clf.fit(X[train], y[train])
        preds[test] = predict_states(clf.predict_proba(X[test]), gamma)
        folds.append({
            "heldOut": str(group),
            "gamma": gamma,
            "validationMacroF1": val_f1,
            "testMacroF1": macro_f1(y[test], preds[test]),
        })

    evaluated = preds != None  # noqa: E711 (object 배열 비교)
    result = {"folds": folds}
    if evaluated.any():
        result["test"] = compute_metrics(y[evaluated], preds[evaluated].astype(str))
    return result


# ---------------------------------------------------------------------- 메인
def parse_args():
    parser = argparse.ArgumentParser(description="AI-003 목표 이탈 분류기 학습")
    parser.add_argument("--data-dir", type=Path, default=AI_DIR / "data", help="sessions*/windows*.jsonl 위치")
    parser.add_argument("--models", nargs="+", default=list(MODEL_TYPES), choices=MODEL_TYPES)
    parser.add_argument("--use-context", action="store_true", help="Context Model 특징 포함 (B 구성)")
    parser.add_argument("--output", type=Path, default=AI_DIR / "artifacts" / "drift_classifier.joblib")
    parser.add_argument("--report", type=Path, default=AI_DIR / "artifacts" / "training_report.json")
    parser.add_argument("--zip", type=Path, help="체크섬을 확인할 데이터 ZIP 경로")
    parser.add_argument("--sha256", help="데이터 ZIP의 SHA-256 (--zip과 함께 사용)")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.zip or args.sha256:
        if not (args.zip and args.sha256):
            raise SystemExit("--zip과 --sha256은 함께 지정해야 합니다.")
        verify_sha256(args.zip, args.sha256)
        print(f"[Train] SHA-256 확인 완료: {args.zip.name}")

    samples = load_dataset(args.data_dir)
    y = np.array([s.label for s in samples])
    goal_ids = sorted({s.goal_id for s in samples})
    label_status = Counter(s.label_status for s in samples)
    label_dist = Counter(s.label for s in samples)
    print(f"[Train] Window {len(samples)}개 / 세션 {len({s.session_id for s in samples})}개 / 목표 {len(goal_ids)}개")
    print(f"[Train] 라벨 분포: {dict(label_dist)} / 라벨 상태: {dict(label_status)}")

    # 행동 값이 없는 데이터를 0이나 임의 값으로 채우지 않고 행동 특징 자체를 제외한다.
    use_behavior = all(s.behavior_features is not None for s in samples)
    if not use_behavior:
        print("[Train] 행동 측정값(activeDurationMs/tabSwitchCount)이 없는 Window가 있어 행동 특징을 제외합니다.")

    # 목표가 충분하면 목표 단위, 아니면 세션 단위로 분할한다. (Window 무작위 분할 금지)
    if len(goal_ids) >= MIN_GOALS_FOR_GOAL_SPLIT:
        group_unit = "goal"
        groups = np.array([s.goal_id for s in samples])
    else:
        group_unit = "session"
        groups = np.array([f"{s.goal_id}/{s.condition or s.session_id}" for s in samples])
        print(f"[Train] 목표가 {MIN_GOALS_FOR_GOAL_SPLIT}개 미만이라 세션 단위로 분할합니다.")

    X = build_feature_matrix(samples, args.use_context, use_behavior)
    feature_names = (
        SEMANTIC_FEATURE_NAMES
        + (CONTEXT_FEATURE_NAMES if args.use_context else [])
        + (BEHAVIOR_FEATURE_NAMES if use_behavior else [])
    )

    candidates = {}
    for model_type in args.models:
        val_probs, skipped = out_of_fold_probs(X, y, groups, model_type, args.use_context, use_behavior)
        gamma, val_f1 = choose_gamma(val_probs, y)
        evaluation = nested_evaluate(X, y, groups, model_type, args.use_context, use_behavior)
        candidates[model_type] = {
            "validation": {"gamma": gamma, "macroF1": val_f1, "skippedGroups": skipped},
            "nested": evaluation,
        }
        test = evaluation.get("test", {})
        print(
            f"[Train] {model_type:<20} Validation MacroF1={val_f1 if val_f1 is not None else float('nan'):.3f} "
            f"(γ={gamma:.2f}) | 중첩 Test MacroF1={test.get('macroF1', float('nan')):.3f} "
            f"DRIFT Recall={test.get('driftRecall', float('nan')):.3f}"
        )

    # 모델 선택은 Validation 결과만으로 한다.
    valid = {k: v for k, v in candidates.items() if v["validation"]["macroF1"] is not None}
    if not valid:
        raise SystemExit("[Train] Validation 예측을 만들 수 있는 모델이 없습니다. 데이터의 클래스 구성을 확인하세요.")
    best_type = max(valid, key=lambda k: valid[k]["validation"]["macroF1"])
    best_gamma = valid[best_type]["validation"]["gamma"]

    final = DriftClassifier(best_type, threshold_gamma=best_gamma, use_context=args.use_context, use_behavior=use_behavior)
    final.fit(X, y)
    final.metadata = {
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataDir": str(args.data_dir),
        "nSamples": len(samples),
        "labelDistribution": dict(label_dist),
        "labelStatus": dict(label_status),
        "featureNames": feature_names,
        "groupUnit": group_unit,
        "selectedBy": "validation macroF1 (leave-one-group-out)",
        "note": "합성 데이터 후보 라벨 기반 개발 검증용 모델이며 실제 성능 지표가 아님",
    }
    final.save(args.output)

    report = {"metadata": final.metadata, "selectedModel": best_type, "gamma": best_gamma, "candidates": candidates}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n[Train] 선택된 모델: {best_type} (γ={best_gamma:.2f}, Validation 기준)")
    print(f"[Train] 모델 저장: {args.output}")
    print(f"[Train] 리포트 저장: {args.report}")
    print("[Train] 주의: 합성 데이터의 후보 라벨 기반 결과이며 실제 모델 성능으로 해석하지 않습니다.")


if __name__ == "__main__":
    main()

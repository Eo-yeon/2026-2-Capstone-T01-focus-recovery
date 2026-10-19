import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Union

from models.classifier import LABELS
from models.context import WINDOW_SIZE, PageVisit


@dataclass
class WindowSample:
    window_id: str
    session_id: str
    goal_id: str
    goal_text: str
    condition: Optional[str]                  # 합성 세션의 수행 조건 (실제 수집 데이터에는 없을 수 있음)
    window_index: int
    visit_ids: List[str]
    visits: List[PageVisit]
    behavior_features: Optional[List[float]]  # 행동 값이 하나라도 없으면 None (임의 값으로 채우지 않음)
    label: str                                # candidateLabel (합성 데이터는 검토 전 후보 라벨)
    label_status: str


def sha256_of(path: Union[str, Path]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha256(path: Union[str, Path], expected: str) -> None:
    """데이터 ZIP을 받은 뒤 전달받은 체크섬과 일치하는지 확인한다."""
    actual = sha256_of(path)
    if actual.lower() != expected.strip().lower():
        raise ValueError(f"[Dataset] SHA-256 불일치: {path}\n  expected={expected}\n  actual  ={actual}")


def _read_jsonl(path: Path) -> List[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _window_behavior(raw_visits: List[dict]) -> Optional[List[float]]:
    """
    구간의 행동 특징: [평균 활성 체류시간(초), 탭 전환 횟수 합].
    측정값이 하나라도 없으면 None을 반환한다.
    """
    durations = [v.get("activeDurationMs") for v in raw_visits]
    switches = [v.get("tabSwitchCount") for v in raw_visits]
    if any(d is None for d in durations) or any(s is None for s in switches):
        return None
    return [sum(durations) / len(durations) / 1000.0, float(sum(switches))]


def load_dataset(data_dir: Union[str, Path]) -> List[WindowSample]:
    """
    data_dir 아래(하위 폴더 포함)의 sessions*.jsonl, windows*.jsonl을 읽어 Window 단위 샘플로 변환한다.
    Window의 visitIds가 같은 세션의 연속 5개 방문인지 확인한다.
    """
    data_dir = Path(data_dir)
    session_files = sorted(data_dir.rglob("sessions*.jsonl"))
    window_files = sorted(data_dir.rglob("windows*.jsonl"))
    if not session_files or not window_files:
        raise FileNotFoundError(f"[Dataset] {data_dir}에서 sessions*.jsonl / windows*.jsonl을 찾을 수 없습니다.")

    sessions: Dict[str, dict] = {}
    visits_by_id: Dict[str, dict] = {}
    for path in session_files:
        for session in _read_jsonl(path):
            sessions[session["sessionId"]] = session
            for visit in session["visits"]:
                visits_by_id[visit["visitId"]] = visit

    samples: List[WindowSample] = []
    for path in window_files:
        for window in _read_jsonl(path):
            session = sessions.get(window["sessionId"])
            if session is None:
                raise ValueError(f"[Dataset] Window {window['windowId']}의 세션을 찾을 수 없습니다.")
            if window["candidateLabel"] not in LABELS:
                raise ValueError(f"[Dataset] 알 수 없는 라벨: {window['candidateLabel']}")

            visit_ids = window["visitIds"]
            if len(visit_ids) != WINDOW_SIZE:
                raise ValueError(f"[Dataset] Window {window['windowId']}의 방문 수가 {WINDOW_SIZE}개가 아닙니다.")
            raw_visits = [visits_by_id[vid] for vid in visit_ids]
            sequences = [v["sequence"] for v in raw_visits]
            if any(v["sessionId"] != session["sessionId"] for v in raw_visits) or sequences != list(
                range(sequences[0], sequences[0] + WINDOW_SIZE)
            ):
                raise ValueError(f"[Dataset] Window {window['windowId']}가 같은 세션의 연속 방문이 아닙니다.")

            samples.append(WindowSample(
                window_id=window["windowId"],
                session_id=session["sessionId"],
                goal_id=session["goalId"],
                goal_text=session["goalText"],
                condition=session.get("condition"),
                window_index=window["windowIndex"],
                visit_ids=visit_ids,
                visits=[PageVisit(title=v["title"], content=v["content"]) for v in raw_visits],
                behavior_features=_window_behavior(raw_visits),
                label=window["candidateLabel"],
                label_status=window.get("labelStatus", "UNKNOWN"),
            ))

    samples.sort(key=lambda s: (s.goal_id, s.session_id, s.window_index))
    return samples

# AI

Focus Recovery의 AI 분석 영역입니다.

사용자가 입력한 최초 작업 목표와 최근 웹 탐색 흐름을 분석하여,
현재 탐색 상태를 `NORMAL`, `TRANSITION`, `DRIFT` 중 하나로 분류합니다.

## 주요 기능

AI 영역은 다음 세 기능으로 구성됩니다.

### AI-001 목표-페이지 의미적 관련성 계산

최초 작업 목표와 각 페이지의 제목 및 본문 사이의 의미적 관련성을 계산합니다.

계산된 관련성은 최근 탐색 흐름의 변화와 통계를 구성하고,
Context 분석과 최종 목표 이탈 분류에 사용합니다.

Embedding Model 후보:

- `Qwen3-Embedding-0.6B`
- `multilingual-e5-base`
- `BGE-M3`

### AI-002 최근 탐색 흐름 분석

최근 5개의 유효 Page Visit을 하나의 탐색 구간으로 보고,
방문 순서와 주제 변화를 분석합니다.

Context Model은 다음 특징을 생성합니다.

- `goalRelevance`
- `detourJustification`
- `driftDegree`
- `contextState`

`contextState`는 Context Model의 중간 판단이며,
최종 목표 이탈 분류 결과와는 구분합니다.

Context Model 후보:

- `Qwen3-4B`
- `Qwen3-8B 4-bit`

### AI-003 목표 이탈 분류

의미적 관련성, 탐색 맥락, 행동 특징을 이용하여
최근 탐색 구간의 최종 상태를 분류합니다.

최종 출력은 다음 세 클래스의 예측 확률과 상태입니다.

- `P(NORMAL)`
- `P(TRANSITION)`
- `P(DRIFT)`
- `result`

분류기 후보:

- Logistic Regression
- Random Forest
- XGBoost

최종 모델과 특징 구성은 Validation 데이터의 평가 결과를 기준으로 결정합니다.

## 분석 단위

AI 분석은 최근 5개의 유효 Page Visit으로 구성된 탐색 구간을 기준으로 수행합니다.

```text
Window Size: 5
Stride: 1
```

새로운 유효 Page Visit이 추가될 때마다 최근 5개 방문으로 새로운 탐색 구간을 구성합니다.

```text
P1 P2 P3 P4 P5       → Window 1
   P2 P3 P4 P5 P6    → Window 2
      P3 P4 P5 P6 P7 → Window 3
```

## 처리 흐름

```text
최초 작업 목표 + Page Visit
            ↓
    Semantic Relevance
            ↓
      Context Analysis
            ↓
       Feature 구성
            ↓
     Drift Classification
            ↓
NORMAL / TRANSITION / DRIFT
```

Context Model이 실제 최종 분류 성능 향상에 기여하지 않는 경우,
검증 결과에 따라 Context 분석 단계를 제외할 수 있습니다.

## 개발 원칙

- 단일 페이지의 관련성이 낮다는 이유만으로 `DRIFT`로 판단하지 않습니다.
- 분석에 필요한 입력을 확보할 수 없는 경우 임의의 값을 생성하지 않습니다.
- Context Model의 결과만으로 최종 상태를 결정하지 않습니다.
- Context Model의 구조화 출력 검증 실패 시 1회 재시도합니다.
- 분석 실패를 `NORMAL` 등의 정상 결과로 대체하지 않습니다.
- 모델 및 임계값은 Validation 데이터를 기준으로 결정합니다.
- Test 데이터는 최종 설정 확정 이후 일반화 성능 평가에만 사용합니다.

## 분류기 학습

학습 데이터는 Git에 올리지 않고 `ai/data/` 아래에 둡니다. (`.gitignore` 처리됨)
데이터 폴더에는 `sessions*.jsonl`, `windows*.jsonl`이 있어야 합니다.

```bash
cd ai
python -m training.train                 # Embedding-only (A)
python -m training.train --use-context   # Embedding + Context (B)
python -m training.train --zip <데이터.zip> --sha256 <체크섬>   # 체크섬 확인 후 학습
```

- 겹치는 Window가 학습/평가에 나뉘지 않도록 목표(3개 이상일 때) 또는 세션 단위로 분할합니다.
- 임계값 γ와 모델 타입은 Validation fold 결과로만 결정하고, held-out fold 결과는 보고에만 사용합니다.
- 행동 측정값이 없는 데이터는 0이나 임의 값으로 채우지 않고 행동 특징을 제외하고 학습합니다.
- 산출물: `ai/artifacts/drift_classifier.joblib`, `ai/artifacts/training_report.json` (Git 제외)
- API 서버(`main.py`)는 학습된 분류기를 로드하며, 경로는 `DRIFT_CLASSIFIER_PATH`로 바꿀 수 있습니다.

합성 데이터의 후보 라벨로 학습한 결과는 학습 코드의 작동 확인용이며 실제 모델 성능이 아닙니다.

## 분석 API (AI-API-01)

BE(`AiAnalysisClient`)가 호출하는 API입니다. 실행: `cd ai && uvicorn main:app --port 8000`

- `POST /api/ai/analyses`
  - 요청: `analysisId`, `sessionId`, `windowId`, `windowIndex`, `goalText`, `visits[5]` (position 1~5)
  - 성공(200): 요청 식별자 3개, `result`, `pNormal`/`pTransition`/`pDrift`(합 1), `contextUsed`, `contextResult`, `featureSnapshot`, `modelVersions`, `analyzedAt`(UTC 밀리초)
  - 실패: `{"code", "message", "fieldErrors"}`

| code | HTTP | 상황 |
| --- | --- | --- |
| `INVALID_REQUEST` | 422 | 요청 형식·값 오류 (방문 수, position, 빈 목표 등) |
| `ANALYSIS_ID_CONFLICT` | 409 | 같은 `analysisId`로 다른 내용의 요청 |
| `ANALYSIS_IN_PROGRESS` | 409 | 같은 `analysisId`의 분석이 처리 중 |
| `AI_ANALYSIS_FAILED` | 500 | 분석 실패 (Context 출력 재검증 실패 등) |
| `AI_NOT_READY` | 503 | 모델 로드 중 또는 로드 실패 |

- 같은 `analysisId`와 같은 내용으로 다시 요청하면 저장된 응답을 그대로 반환합니다. (메모리 보관, 재시작 시 초기화)
- `GET /health`: 모델 로드가 끝나면 200 `{"status": "READY"}`, 그 전에는 503 `AI_NOT_READY`

## 개발 상태

현재 AI 영역은 기능 설계가 완료된 초기 개발 환경 구성 단계입니다.

Python 프로젝트 구조, 의존성, 실행 방법 및 테스트 방법은
AI 개발 환경 구성이 완료된 이후 본 문서에 추가합니다.
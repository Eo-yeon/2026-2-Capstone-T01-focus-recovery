from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import uvicorn

from models.context import PageVisit
from pipeline import FocusRecoveryPipeline

app = FastAPI(title="AI Capstone Design - Drift Analysis API")

# AI 파이프라인 전역 인스턴스 초기화 (AI-001 -> AI-002 -> AI-003)
# 학습된 분류기(ai/artifacts/drift_classifier.joblib 또는 DRIFT_CLASSIFIER_PATH)가 필요하다.
pipeline = FocusRecoveryPipeline.from_default()

# Request 데이터 스키마 정의 (Spring Boot에서 전달받을 데이터 구조)
class PageVisitRequest(BaseModel):
    title: str
    content: str

class AnalysisRequest(BaseModel):
    task_goal: str
    recent_pages: List[PageVisitRequest]
    behavior_features: Optional[List[float]] = None # 예: [활성 체류시간, 탭 전환 횟수 등], 행동 특징 없이 학습된 분류기면 생략

@app.post("/api/v1/analyze")
def analyze_drift(request: AnalysisRequest):
    """
    최초 목표와 최근 5개 페이지, 행동 특징을 분석하여 탐색 상태(NORMAL, TRANSITION, DRIFT)를 반환합니다.
    분석 실패는 정상 결과로 대체하지 않고 오류로 응답합니다.
    """
    visits = [PageVisit(title=page.title, content=page.content) for page in request.recent_pages]

    try:
        result = pipeline.analyze(request.task_goal, visits, request.behavior_features)
    except ValueError as e:
        # 입력 검증 실패 (목표 누락, 방문 수 불일치, 행동 특징 누락 등)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # 모델 추론 실패 (ContextAnalysisError 포함)
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "success", "data": result.to_dict()}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

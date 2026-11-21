from fastapi import APIRouter, HTTPException

from .ai_pipeline import AiPipelineError, prepare_search, rank_candidates, rank_context_candidates, status_payload
from .ai_schemas import AiContextRankRequest, AiRankRequest, AiSearchRequest

router = APIRouter(prefix="/api/ai", tags=["AI search"])


def _http_error(error: AiPipelineError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


@router.get("/status")
def ai_status() -> dict:
    return status_payload()


@router.post("/search/prepare")
def ai_prepare_search(request: AiSearchRequest) -> dict:
    try:
        return prepare_search(request).model_dump()
    except AiPipelineError as error:
        raise _http_error(error) from error


@router.post("/vision/compare")
def ai_compare_candidates(request: AiRankRequest) -> dict:
    try:
        return rank_candidates(request).model_dump()
    except AiPipelineError as error:
        raise _http_error(error) from error


@router.post("/search/rank-context")
def ai_rank_context_candidates(request: AiContextRankRequest) -> dict:
    try:
        return rank_context_candidates(request).model_dump()
    except AiPipelineError as error:
        raise _http_error(error) from error

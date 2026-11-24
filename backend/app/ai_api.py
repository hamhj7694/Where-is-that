from fastapi import APIRouter, HTTPException

from . import web_reference
from .ai_pipeline import (
    AiPipelineError,
    match_visual_features,
    prepare_search,
    rank_candidates,
    rank_context_candidates,
    status_payload,
)
from .ai_schemas import AiContextRankRequest, AiRankRequest, AiSearchRequest, AiVisualMatchRequest

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


@router.post("/vision/match-public")
def ai_match_public_images(request: AiVisualMatchRequest) -> dict:
    """참고 사진 유무와 무관하게 공개 항목의 사진·설명을 시각 특징으로 비교한다.

    말로만 모르는 캐릭터는 웹에서 찾은 참고 사진·특징을 중간 단계에서 추가한다.
    """
    try:
        if request.webReferenceApplied or request.localOnly:
            return match_visual_features(request).model_dump()
        features, references = web_reference.enrich(
            list(request.imageFeatures), list(request.references)
        )
        enriched = request.model_copy(update={
            "imageFeatures": features, "references": references,
            "webReferenceApplied": True,
            "preferSemantic": request.photoOnly and not request.localOnly and (
                request.preferSemantic or not request.references
            ),
        })
        return match_visual_features(enriched).model_dump()
    except AiPipelineError as error:
        raise _http_error(error) from error


@router.post("/search/rank-context")
def ai_rank_context_candidates(request: AiContextRankRequest) -> dict:
    try:
        return rank_context_candidates(request).model_dump()
    except AiPipelineError as error:
        raise _http_error(error) from error

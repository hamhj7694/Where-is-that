"""LangGraph 기반 AI 호출 오케스트레이션.

텍스트만 필요하면 LLM 역할, 사진만 필요하면 VLM 역할, 둘 다 필요하면 joint
멀티모달 역할만 호출한다. 공개 사진 비교는 로컬 임베딩이 가능하면 멀티모달
폴백을 생략하고, 카테고리 범위 안에서만 CLIP 비교를 한다.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import ValidationError

from . import image_similarity, local_vision
from .ai_schemas import (
    AiSearchPlan,
    AiVisualMatchResponse,
    AiVisualMatchResult,
)


class SearchState(TypedDict, total=False):
    request: object
    descriptions: list[str]
    value: dict
    plan: AiSearchPlan


class VisualState(TypedDict, total=False):
    request: object
    photo_images: dict[str, str]
    description_texts: dict[str, str]
    target_hints: str
    basis: dict[str, str]
    scoped: dict[str, str]
    computed: dict[str, int]
    notes: dict[str, str]
    scores: dict[str, int]
    source: str
    response: AiVisualMatchResponse


def _search_route(state: SearchState) -> str:
    return "describe" if state["request"].images else "interpret"


def _search_describe(state: SearchState) -> dict:
    from . import ai_pipeline

    return {"descriptions": ai_pipeline._describe_images(state["request"].images)}


def _search_interpret(state: SearchState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    today = datetime.now(timezone(timedelta(hours=9))).date().isoformat()
    value = ai_pipeline._json_object(ai_pipeline._completion(
        "multimodal" if request.images else "llm",
        [
            {"role": "system", "content": ai_pipeline._prompt("interpret_search.txt")},
            {"role": "user", "content": json.dumps({
                "mode": request.mode,
                "todayInSeoul": today,
                "originalQuery": request.query,
                "imageDescriptions": state.get("descriptions", []),
                "existingFilters": request.filters,
            }, ensure_ascii=False)},
        ],
    ))
    return {"value": value}


def _search_finish(state: SearchState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    value = dict(state["value"])
    value["originalQuery"] = request.query
    value["imageDescriptions"] = state.get("descriptions", [])
    value["criteria"] = ai_pipeline._normalize_criteria(value.get("criteria"), value.get("channels"))
    try:
        return {"plan": AiSearchPlan.model_validate(value)}
    except ValidationError as error:
        from .ai_pipeline import AiPipelineError

        raise AiPipelineError(502, "ai_invalid_response", "AI가 검색 조건을 올바르게 만들지 못했어요.") from error


def _build_search_graph():
    builder = StateGraph(SearchState)
    builder.add_node("describe", _search_describe)
    builder.add_node("interpret", _search_interpret)
    builder.add_node("finish", _search_finish)
    builder.add_conditional_edges(
        START, _search_route, {"describe": "describe", "interpret": "interpret"}
    )
    builder.add_edge("describe", "interpret")
    builder.add_edge("interpret", "finish")
    builder.add_edge("finish", END)
    return builder.compile()


def _visual_fetch(state: VisualState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    photo_images: dict[str, str] = {}
    description_texts: dict[str, str] = {}
    for candidate in request.candidates:
        photo = ai_pipeline._fetch_public_image(candidate.imageUrl) if candidate.imageUrl else None
        if photo:
            photo_images[candidate.id] = photo
        elif candidate.text.strip():
            description_texts[candidate.id] = candidate.text
    return {
        "photo_images": photo_images,
        "description_texts": description_texts,
        "target_hints": " ".join([request.query, *request.imageFeatures]),
        "basis": {candidate_id: "photo" for candidate_id in photo_images},
        "source": "multimodal",
    }


def _visual_route_after_fetch(state: VisualState) -> str:
    if not state["photo_images"]:
        return "describe"
    if not image_similarity.is_configured():
        return "fallback"
    return "select"


def _visual_select(state: VisualState) -> dict:
    texts = {candidate.id: candidate.text for candidate in state["request"].candidates}
    return {"scoped": local_vision.scope_candidates(state["photo_images"], texts, state["target_hints"])}


def _visual_embed(state: VisualState) -> dict:
    request = state["request"]
    if request.references:
        computed = image_similarity.score_similarity(
            request.references, state["scoped"], state["target_hints"]
        )
    else:
        computed = image_similarity.score_text_image_similarity(
            request.imageFeatures, state["scoped"], state["target_hints"]
        )
    notes = image_similarity.crop_notes(state["target_hints"], state["scoped"]) if computed else {}
    return {
        "computed": computed,
        "notes": notes,
        "source": "vision-model" if computed else "multimodal",
    }


def _visual_route_after_embed(state: VisualState) -> str:
    return "describe" if state["computed"] else "fallback"


def _visual_fallback(state: VisualState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    computed = ai_pipeline._multimodal_visual_scores(
        request.query, request.imageFeatures, request.references, state["photo_images"]
    )
    return {"computed": computed, "source": "multimodal"}


def _visual_describe(state: VisualState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    scores = dict(state.get("computed", {}))
    basis = dict(state.get("basis", {}))
    for candidate_id, text in state["description_texts"].items():
        scores[candidate_id] = ai_pipeline._text_feature_score(request.imageFeatures, text)
        basis[candidate_id] = "description"
    # 범위에서 제외된 사진 후보는 값싼 텍스트 점수만 붙여 순서를 유지한다.
    for candidate in request.candidates:
        if candidate.id in state["photo_images"] and candidate.id not in scores:
            scores[candidate.id] = ai_pipeline._text_feature_score(request.imageFeatures, candidate.text)
    return {"scores": scores, "basis": basis, "source": state.get("source", "multimodal")}


def _visual_finish(state: VisualState) -> dict:
    request = state["request"]
    notes = state.get("notes", {})
    results = [
        AiVisualMatchResult(
            id=candidate.id,
            imageSimilarity=state["scores"].get(candidate.id, 0),
            basis=state["basis"].get(
                candidate.id,
                "description" if candidate.id in state["description_texts"] else "photo",
            ),
            reason=notes.get(candidate.id)
            or (
                "공개 사진과 시각 특징을 비교했어요."
                if candidate.id in state["photo_images"]
                else "설명에 시각 특징이 있는지 확인했어요."
            ),
        )
        for candidate in request.candidates
    ]
    results.sort(key=lambda item: item.imageSimilarity, reverse=True)
    return {
        "response": AiVisualMatchResponse(
            results=results,
            source=state.get("source", "multimodal"),
            usedFeatures=request.imageFeatures,
        )
    }


def _build_visual_graph():
    builder = StateGraph(VisualState)
    builder.add_node("fetch", _visual_fetch)
    builder.add_node("select", _visual_select)
    builder.add_node("embed", _visual_embed)
    builder.add_node("fallback", _visual_fallback)
    builder.add_node("describe", _visual_describe)
    builder.add_node("finish", _visual_finish)
    builder.add_edge(START, "fetch")
    builder.add_conditional_edges(
        "fetch",
        _visual_route_after_fetch,
        {"select": "select", "fallback": "fallback", "describe": "describe"},
    )
    builder.add_edge("select", "embed")
    builder.add_conditional_edges(
        "embed", _visual_route_after_embed, {"describe": "describe", "fallback": "fallback"}
    )
    builder.add_edge("fallback", "describe")
    builder.add_edge("describe", "finish")
    builder.add_edge("finish", END)
    return builder.compile()


SEARCH_GRAPH = _build_search_graph()
VISUAL_GRAPH = _build_visual_graph()


def prepare(request) -> AiSearchPlan:
    return SEARCH_GRAPH.invoke({"request": request})["plan"]


def match_visual_features(request) -> AiVisualMatchResponse:
    return VISUAL_GRAPH.invoke({
        "request": request,
        "photo_images": {},
        "description_texts": {},
        "target_hints": "",
        "basis": {},
        "computed": {},
        "notes": {},
        "scores": {},
        "source": "multimodal",
    })["response"]

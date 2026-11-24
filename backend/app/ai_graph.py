"""LangGraph 기반 AI 호출 오케스트레이션.

텍스트만 필요하면 LLM 역할, 사진만 필요하면 VLM 역할, 둘 다 필요하면 joint
멀티모달 역할만 호출한다. 공개 사진 비교는 로컬 임베딩을 먼저 쓰고,
후보의 품목명과 관계없이 요청에 들어온 사진을 비교한다.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import ValidationError

from . import config, image_similarity, local_vision
from .ai_schemas import (
    AiSearchPlan,
    AiVisualMatchResponse,
    AiVisualMatchResult,
)

logger = logging.getLogger(__name__)


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
    vlm_multi: dict[str, bool]
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
    value["criteria"] = ai_pipeline._normalize_criteria(value.get("criteria"), value.get("channels"), request.query)
    # AI가 '강남역' 같은 값을 지역에 넣어도 17개 시도 이름으로 정리한다.
    # 여기서 걸러진 값은 화면이 문장에서 다시 유추하므로 지역 단서가 사라지지 않는다.
    from .lostfound_codes import REGION_CODES

    filters = value.get("filters") if isinstance(value.get("filters"), dict) else {}
    region = str(filters.get("region") or "").strip()
    filters["region"] = next((name for name in REGION_CODES if region and (name in region or region in name)), "")
    value["filters"] = filters
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

    from .police_api import _image_key

    request = state["request"]
    photo_images: dict[str, str] = {}
    description_texts: dict[str, str] = {}
    # 같은 사진 경로를 가진 후보는 한 번만 내려받는다. 점수 대상 ID는 그대로 남겨
    # 표시 결과가 줄어들거나 순위가 달라지지 않게 한다.
    images = [(_image_key(candidate.imageUrl), candidate) for candidate in request.candidates]
    urls = {key: candidate.imageUrl for key, candidate in images if key}
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {key: executor.submit(ai_pipeline._fetch_public_image, url) for key, url in urls.items()}
        fetched = {key: future.result() for key, future in futures.items()}
    for image_key, candidate in images:
        photo = fetched.get(image_key) if image_key else None
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


def _vlm_available() -> bool:
    from . import ai_pipeline

    provider, key, base_url, model = ai_pipeline._role_config("vlm")
    return provider == "openai-compatible" and bool(key and base_url and model)


def _visual_route_after_fetch(state: VisualState) -> str:
    if not state["photo_images"]:
        return "describe"
    if getattr(state.get("request"), "localOnly", False):
        return "select"
    if getattr(state.get("request"), "preferSemantic", False) and _vlm_available():
        return "fallback"
    if not image_similarity.is_configured():
        return "fallback"
    # 크롭이 실제로 쓰이는 로컬 CLIP 경로에서만 VLM 판정을 한 번 호출한다.
    if (
        config.VLM_CROP_CENSUS
        and config.AI_SIMILARITY_PROVIDER == "local-clip"
        and local_vision.yoloe_available()
        and _vlm_available()
    ):
        return "census"
    return "select"


def _visual_census(state: VisualState) -> dict:
    """참고 사진·공개 사진 전체를 한 번의 VLM 호출로 세어 크롭 근거를 만든다.

    실패하면 빈 힌트를 돌려 YOLOE 게이팅으로 되돌아간다. 검색 자체는 실패하지 않는다.
    """
    from . import ai_pipeline

    request = state["request"]
    image_by_key: dict[str, str] = {}
    for index, image in enumerate(request.references):
        if isinstance(image, str) and ai_pipeline._DATA_URL.fullmatch(image):
            image_by_key[f"r{index}"] = image
    for index, (candidate_id, image) in enumerate(state["photo_images"].items()):
        if isinstance(image, str) and ai_pipeline._DATA_URL.fullmatch(image):
            image_by_key[f"c{index}"] = image
    if not image_by_key:
        return {"vlm_multi": {}}

    content: list[dict[str, object]] = [{
        "type": "text",
        "text": json.dumps({
            "task": "각 사진의 객체 개수와 서로 다른 객체 종류 수를 세어 크롭 여부를 판단합니다.",
            "images": [{"id": key} for key in image_by_key],
        }, ensure_ascii=False),
    }]
    for image in image_by_key.values():
        content.append({"type": "image_url", "image_url": {"url": image, "detail": "low"}})
    try:
        value = ai_pipeline._json_object(ai_pipeline._completion("vlm", [
            {"role": "system", "content": ai_pipeline._prompt("crop_census.txt")},
            {"role": "user", "content": content},
        ]))
    except (ai_pipeline.AiPipelineError, OSError) as error:
        logger.warning("VLM crop census failed: %s", error)
        return {"vlm_multi": {}}

    rows = value.get("results")
    if not isinstance(rows, list):
        return {"vlm_multi": {}}
    hints: dict[str, bool] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = row.get("id")
        if not isinstance(key, str) or key not in image_by_key:
            continue
        count = row.get("objectCount")
        types = row.get("objectTypes")
        count_ok = (
            isinstance(count, int) and not isinstance(count, bool)
            and count >= config.CROP_MIN_OBJECTS
        )
        distinct_types = {
            item.strip().lower() for item in types
            if isinstance(item, str) and item.strip()
        } if isinstance(types, list) else set()
        types_ok = len(distinct_types) >= config.CROP_MIN_OBJECT_TYPES
        hints[image_by_key[key]] = count_ok or types_ok
    return {"vlm_multi": hints}


def _visual_route_after_census(state: VisualState) -> str:
    return "fallback" if not image_similarity.is_configured() else "select"


def _visual_embed(state: VisualState) -> dict:
    request = state["request"]
    hints = state.get("vlm_multi") or {}
    photos = state["photo_images"]
    engine = local_vision if request.localOnly else image_similarity
    if request.references:
        computed = engine.score_similarity(request.references, photos, state["target_hints"], hints)
    else:
        features = request.imageFeatures or [request.query]
        computed = engine.score_text_image_similarity(features, photos, state["target_hints"], hints)
    notes = image_similarity.crop_notes(state["target_hints"], photos, hints) if computed and not request.localOnly else {}
    return {
        "computed": computed,
        "notes": notes,
        "source": "vision-model" if computed else "multimodal",
    }


def _low_confidence_text_scores(scores: dict[str, int]) -> bool:
    """짧은 한국어 설명이 같은 객체 프롬프트로 수렴했는지 점수 분포로 판단한다."""
    values = sorted(scores.values(), reverse=True)
    if len(values) < 2:
        return True
    return (
        values[0] < config.TEXT_FALLBACK_MAX_SCORE
        or values[0] - values[1] < config.TEXT_FALLBACK_MIN_GAP
    )


def _low_confidence_reference_scores(scores: dict[str, int]) -> bool:
    # 웹에서 가져온 참고 사진은 작거나 각도가 달라 CLIP 점수가 0으로 나오는 경우가 있다.
    # 이때 멀티모달이 사진을 직접 보지 않으면 낯선 캐릭터를 놓친다.
    values = sorted(scores.values(), reverse=True)
    return not values or values[0] < 40


def _visual_route_after_embed(state: VisualState) -> str:
    if getattr(state.get("request"), "localOnly", False):
        return "describe"
    if not state["computed"]:
        return "fallback"
    if state["request"].references:
        return "fallback" if _low_confidence_reference_scores(state["computed"]) else "describe"
    # 색상을 직접 말했으면 색상 게이트가 걸린 로컬 점수를 신뢰한다.
    # 멀티모달은 브랜드·물건 종류만 보고도 점수를 올려 파란 카드를 흰 카드로 판단한다.
    if local_vision.requested_colors(state["request"].imageFeatures, state["target_hints"]):
        return "describe"
    # 텍스트만 있는 비교는 점수가 평평하면 멀티모달이 사진을 직접 보게 한다.
    if _low_confidence_text_scores(state["computed"]):
        return "fallback"
    return "describe"


def _visual_fallback(state: VisualState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    try:
        computed = ai_pipeline._multimodal_visual_scores(
            request.query, request.imageFeatures, request.references, state["photo_images"]
        )
    except ai_pipeline.AiPipelineError:
        if not request.photoOnly:
            raise
        computed = {}
    if not computed and request.photoOnly:
        if state.get("computed"):
            return {"computed": state["computed"], "source": state["source"]}
        return _visual_embed(state)
    return {"computed": computed, "source": "multimodal"}


def _visual_describe(state: VisualState) -> dict:
    from . import ai_pipeline

    request = state["request"]
    scores = dict(state.get("computed", {}))
    basis = dict(state.get("basis", {}))
    if request.photoOnly:
        return {"scores": scores, "basis": basis, "source": state.get("source", "multimodal")}
    for candidate_id, text in state["description_texts"].items():
        scores[candidate_id] = ai_pipeline._text_feature_score(request.imageFeatures, text)
        basis[candidate_id] = "description"
    # 사진 비교에 실패했으면 설명 점수를 사진 점수로 표시하지 않는다.
    for candidate in request.candidates:
        if candidate.id in state["photo_images"] and candidate.id not in scores:
            scores[candidate.id] = ai_pipeline._text_feature_score(request.imageFeatures, candidate.text)
            basis[candidate.id] = "description"
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
                if state["basis"].get(candidate.id) == "photo"
                else "설명에 시각 특징이 있는지 확인했어요."
            ),
        )
        for candidate in request.candidates
        if not request.photoOnly or (candidate.id in state["scores"] and state["basis"].get(candidate.id) == "photo")
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
    builder.add_node("census", _visual_census)
    builder.add_node("embed", _visual_embed)
    builder.add_node("fallback", _visual_fallback)
    builder.add_node("describe", _visual_describe)
    builder.add_node("finish", _visual_finish)
    builder.add_edge(START, "fetch")
    builder.add_conditional_edges(
        "fetch",
        _visual_route_after_fetch,
        {
            "census": "census",
            "select": "embed",
            "fallback": "fallback",
            "describe": "describe",
        },
    )
    builder.add_conditional_edges(
        "census",
        _visual_route_after_census,
        {"select": "embed", "fallback": "fallback"},
    )
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
        "vlm_multi": {},
        "computed": {},
        "notes": {},
        "scores": {},
        "source": "multimodal",
    })["response"]

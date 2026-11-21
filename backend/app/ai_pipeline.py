from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from pydantic import ValidationError

from . import config, image_similarity
from .ai_schemas import (
    AiContextRankRequest,
    AiContextRankResponse,
    AiRankCandidate,
    AiRankRequest,
    AiRankResponse,
    AiSearchPlan,
    AiSearchRequest,
    AiVisualMatchRequest,
    AiVisualMatchResponse,
    AiVisualMatchResult,
)


class AiPipelineError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


# 자연어·이미지·joint 해석은 하나의 멀티모달 역할이 맡는다.
# llm/vlm/vision 문자열은 이전 호출부·테스트를 위한 별칭이다.
Role = Literal["multimodal", "llm", "vlm", "vision"]
_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$")


def _role_config(_role: Role) -> tuple[str, str, str, str]:
    return (
        config.AI_MULTIMODAL_PROVIDER,
        config.AI_MULTIMODAL_API_KEY,
        config.AI_MULTIMODAL_BASE_URL,
        config.AI_MULTIMODAL_MODEL,
    )


def status_payload() -> dict[str, Any]:
    provider, key, _, model = _role_config("multimodal")
    multimodal = {
        "available": bool(key and model and provider == "openai-compatible"),
        "provider": provider,
        "model": model,
    }
    return {
        "available": multimodal["available"],
        "roles": {
            "multimodal": multimodal,
            "imageSimilarity": image_similarity.status_payload(),
        },
        "storesRequests": False,
    }


def _prompt(name: str) -> str:
    path: Path = config.AI_PROMPT_DIR / name
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise AiPipelineError(500, "ai_prompt_unavailable", "AI 프롬프트 파일을 읽지 못했어요.") from error


def _completion(role: Role, messages: list[dict[str, Any]]) -> str:
    provider, key, base_url, model = _role_config(role)
    if provider != "openai-compatible":
        raise AiPipelineError(503, "ai_provider_unsupported", f"{role} 제공자 설정을 지원하지 않아요.")
    if not key:
        raise AiPipelineError(503, "ai_not_configured", "AI API 키가 설정되지 않았어요. 서버 .env에 키를 입력해 주세요.")
    if not model or not base_url:
        raise AiPipelineError(503, "ai_model_not_configured", "AI 모델 또는 API 주소가 설정되지 않았어요.")
    try:
        response = httpx.post(
            base_url + "/chat/completions",
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": messages,
                # 일부 모델(gpt-6-luna 등)은 기본 temperature만 지원하므로 명시하지 않는다.
                "response_format": {"type": "json_object"},
                "store": False,
            },
            timeout=config.AI_TIMEOUT,
        )
        response.raise_for_status()
    except httpx.TimeoutException as error:
        raise AiPipelineError(504, "ai_timeout", "AI 응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.") from error
    except httpx.HTTPStatusError as error:
        if error.response.status_code in (401, 403):
            raise AiPipelineError(502, "ai_auth_failed", "AI 제공자 인증에 실패했어요. 서버 키와 권한을 확인해 주세요.") from error
        if error.response.status_code == 429:
            raise AiPipelineError(503, "ai_rate_limited", "AI 요청 한도에 도달했어요. 잠시 후 다시 시도해 주세요.") from error
        raise AiPipelineError(502, "ai_provider_error", "AI 제공자가 요청을 처리하지 못했어요.") from error
    except httpx.RequestError as error:
        raise AiPipelineError(502, "ai_unreachable", "AI 제공자에 연결하지 못했어요.") from error
    try:
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise AiPipelineError(502, "ai_invalid_response", "AI 응답 형식을 확인할 수 없어요.") from error
    if not isinstance(content, str) or not content.strip():
        raise AiPipelineError(502, "ai_invalid_response", "AI가 빈 응답을 반환했어요.")
    return content


def _json_object(content: str) -> dict[str, Any]:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        raise AiPipelineError(502, "ai_invalid_response", "AI 응답을 JSON으로 해석하지 못했어요.") from error
    if not isinstance(value, dict):
        raise AiPipelineError(502, "ai_invalid_response", "AI 응답 형식이 올바르지 않아요.")
    return value


def _describe_images(images: list[str]) -> list[str]:
    if not images:
        return []
    content: list[dict[str, Any]] = [{"type": "text", "text": "이미지를 입력된 순서대로 살펴보고 JSON {\"descriptions\":[\"...\"]}로 답하세요. 각 설명은 확인 가능한 색상, 형태, 재질, 문자만 짧게 기술하고 추측을 사실처럼 쓰지 마세요."}]
    for image in images:
        if not _DATA_URL.fullmatch(image):
            raise AiPipelineError(422, "invalid_image", "참고 사진 형식을 확인해 주세요.")
        content.append({"type": "image_url", "image_url": {"url": image, "detail": "low"}})
    value = _json_object(_completion("multimodal", [
        {"role": "system", "content": _prompt("describe_images.txt")},
        {"role": "user", "content": content},
    ]))
    descriptions = value.get("descriptions")
    if not isinstance(descriptions, list) or len(descriptions) != len(images) or not all(isinstance(item, str) for item in descriptions):
        raise AiPipelineError(502, "ai_invalid_response", "AI 사진 분석 결과를 확인할 수 없어요.")
    return [item[:300] for item in descriptions]


def _normalize_criteria(value: object, channels: dict) -> dict[str, list[str]]:
    """AI 응답의 맞춤 검색 조건을 정리하고, 빠진 탐색어는 채널 계획에서 보완한다."""
    raw = value if isinstance(value, dict) else {}
    limits = {"apiKeywords": 3, "include": 8, "any": 8, "exclude": 8, "imageFeatures": 8}
    result: dict[str, list[str]] = {}
    for key, limit in limits.items():
        source = raw.get(key)
        terms: list[str] = []
        if isinstance(source, list):
            for term in source:
                if not isinstance(term, str):
                    continue
                cleaned = re.sub(r"\s+", " ", term.strip())[:40]
                if cleaned and cleaned not in terms:
                    terms.append(cleaned)
                if len(terms) >= limit:
                    break
        result[key] = terms

    combined = channels.get("combined") if isinstance(channels, dict) else {}
    image = channels.get("image") if isinstance(channels, dict) else {}
    combined = combined if isinstance(combined, dict) else {}
    image = image if isinstance(image, dict) else {}
    fallback = [combined.get("query", ""), image.get("query", "")]
    fallback.extend(term for term in combined.get("keywords", []) if isinstance(term, str))
    fallback.append("")
    if not result["apiKeywords"]:
        result["apiKeywords"] = [term for term in fallback if term][:3]
    if not any(result[key] for key in ("include", "any", "exclude", "imageFeatures")):
        result["include"] = [term for term in fallback[2:] if term][:8]
    return result


def prepare_search(request: AiSearchRequest) -> AiSearchPlan:
    descriptions = _describe_images(request.images)
    today = datetime.now(timezone(timedelta(hours=9))).date().isoformat()
    value = _json_object(_completion("multimodal", [
        {"role": "system", "content": _prompt("interpret_search.txt")},
        {"role": "user", "content": json.dumps({
            "mode": request.mode,
            "todayInSeoul": today,
            "originalQuery": request.query,
            "imageDescriptions": descriptions,
            "existingFilters": request.filters,
        }, ensure_ascii=False)},
    ]))
    value["originalQuery"] = request.query
    value["imageDescriptions"] = descriptions
    value["criteria"] = _normalize_criteria(value.get("criteria"), value.get("channels"))
    try:
        return AiSearchPlan.model_validate(value)
    except ValidationError as error:
        raise AiPipelineError(502, "ai_invalid_response", "AI가 검색 조건을 올바르게 만들지 못했어요.") from error


def rank_candidates(request: AiRankRequest) -> AiRankResponse:
    # 참고 사진은 그대로 보내면서, 무엇이 보이는지 텍스트로도 분석해 검색 문장과 함께 채점 근거로 쓴다.
    descriptions = _describe_images(request.references) if request.references else []
    content: list[dict[str, Any]] = [{
        "type": "text",
        "text": json.dumps({
            "mode": request.mode,
            "query": request.query,
            "referenceDescriptions": descriptions,
            "candidateIdsInOrder": [candidate.id for candidate in request.candidates],
            "task": "작성한 검색 문장과 참고 사진 분석(referenceDescriptions), 그리고 참고 사진 원본을 모두 함께 고려해 각 후보를 채점하세요. score(종합 관련성)와 contextRelevance(검색 문장과 참고 사진 분석이 말하는 대상·장면·글자·시기 같은 맥락 관련성)을 각각 0~100 정수로 매기고 reasons는 최대 4개. imageSimilarity는 별도 이미지 유사도 전용 비전이 계산하므로 생략해도 됩니다. 모든 후보 id를 한 번씩 포함하세요. 예: {\"results\":[{\"id\":\"...\",\"score\":0,\"contextRelevance\":0,\"reasons\":[\"...\"]}]}",
        }, ensure_ascii=False),
    }]
    for image in request.references:
        if not _DATA_URL.fullmatch(image):
            raise AiPipelineError(422, "invalid_image", "참고 사진 형식을 확인해 주세요.")
        content.append({"type": "image_url", "image_url": {"url": image, "detail": "low"}})
    for candidate in request.candidates:
        if not _DATA_URL.fullmatch(candidate.image):
            raise AiPipelineError(422, "invalid_image", "검색 후보 사진 형식을 확인해 주세요.")
        content.append({"type": "text", "text": "후보 ID: " + candidate.id})
        content.append({"type": "image_url", "image_url": {"url": candidate.image, "detail": "low"}})
    value = _json_object(_completion("multimodal", [
        {"role": "system", "content": _prompt("compare_candidates.txt")},
        {"role": "user", "content": content},
    ]))
    try:
        result = AiRankResponse.model_validate(value)
    except ValidationError as error:
        raise AiPipelineError(502, "ai_invalid_response", "AI 후보 비교 결과를 확인할 수 없어요.") from error
    expected = {candidate.id for candidate in request.candidates}
    actual = [item.id for item in result.results]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise AiPipelineError(502, "ai_invalid_response", "AI 후보 비교 결과가 일부 누락되거나 중복됐어요.")

    # 이미지 유사도는 텍스트 추론이 아니라 전용 비전 임베딩으로만 갱신한다.
    vision_scores = image_similarity.score_similarity(
        request.references,
        {candidate.id: candidate.image for candidate in request.candidates},
    )
    source = "vision-model" if vision_scores else "multimodal"
    ranked = [
        item.model_copy(update={"imageSimilarity": vision_scores[item.id]})
        if item.id in vision_scores else item
        for item in result.results
    ]
    return result.model_copy(update={
        "results": sorted(ranked, key=lambda item: item.score, reverse=True),
        "referenceDescriptions": descriptions,
        "imageSimilaritySource": source,
    })


_IMAGE_MIME_TYPES = {
    "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif",
}


def _fetch_public_image(url: str) -> str | None:
    """허용된 공개 기관 사진만 받아 AI 전송용 소형 JPEG data URL로 바꾼다."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in config.VISUAL_MATCH_ALLOWED_HOSTS:
        return None
    try:
        response = httpx.get(url, timeout=config.VISUAL_MATCH_FETCH_TIMEOUT, follow_redirects=True)
        response.raise_for_status()
        mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if mime not in _IMAGE_MIME_TYPES or len(response.content) > config.VISUAL_MATCH_MAX_BYTES:
            return None
        # 리다이렉트가 다른 호스트로 빠지면 분석하지 않는다(SSRF 방지).
        final_host = (urlparse(str(response.url)).hostname or "").lower()
        if final_host not in config.VISUAL_MATCH_ALLOWED_HOSTS:
            return None
        from io import BytesIO

        from PIL import Image, ImageOps  # requirements.txt의 pillow

        with Image.open(BytesIO(response.content)) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
            image.thumbnail(
                (config.VISUAL_MATCH_THUMBNAIL_SIDE, config.VISUAL_MATCH_THUMBNAIL_SIDE),
                Image.Resampling.LANCZOS,
            )
            buffer = BytesIO()
            image.save(buffer, format="JPEG", quality=config.VISUAL_MATCH_THUMBNAIL_QUALITY, optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    except (httpx.HTTPError, OSError, ValueError):
        return None


def _text_feature_score(features: list[str], text: str) -> int:
    """사진이 없는 항목의 설명을 시각 특징과 대조한다."""
    if not features or not text.strip():
        return 0
    normalized = re.sub(r"\s+", " ", text).lower()
    hits = 0
    for feature in features:
        words = [word for word in feature.lower().split() if word]
        if words and (feature.lower() in normalized or all(word in normalized for word in words)):
            hits += 1
    return min(100, round(hits / len(features) * 100))


def _multimodal_visual_scores(
    query: str,
    features: list[str],
    references: list[str],
    images: dict[str, str],
) -> dict[str, int]:
    """전용 비전이 없을 때 멀티모달이 공개 사진을 시각 특징과 대조한다."""
    content: list[dict[str, Any]] = [{
        "type": "text",
        "text": json.dumps({
            "query": query,
            "imageFeatures": features,
            "candidateIdsInOrder": list(images),
            "task": "각 공개 사진이 imageFeatures에 얼마나 잘 맞는지 imageSimilarity를 0~100 정수로 매기고 reasoning은 짧게 적으세요. 모든 id를 한 번씩 포함하세요. 예: {\"results\":[{\"id\":\"...\",\"imageSimilarity\":0}]}",
        }, ensure_ascii=False),
    }]
    for image in references:
        if not _DATA_URL.fullmatch(image):
            raise AiPipelineError(422, "invalid_image", "참고 사진 형식을 확인해 주세요.")
        content.append({"type": "image_url", "image_url": {"url": image, "detail": "low"}})
    for candidate_id, image in images.items():
        content.append({"type": "text", "text": "후보 ID: " + candidate_id})
        content.append({"type": "image_url", "image_url": {"url": image, "detail": "low"}})
    value = _json_object(_completion("multimodal", [
        {"role": "system", "content": _prompt("match_visual_features.txt")},
        {"role": "user", "content": content},
    ]))
    rows = value.get("results")
    if not isinstance(rows, list):
        raise AiPipelineError(502, "ai_invalid_response", "AI 사진 대조 결과를 확인할 수 없어요.")
    scores: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        score = row.get("imageSimilarity")
        if isinstance(score, (int, float)) and not isinstance(score, bool) and row["id"] in images:
            scores[row["id"]] = max(0, min(100, round(score)))
    return scores


def match_visual_features(request: AiVisualMatchRequest) -> AiVisualMatchResponse:
    """참고 사진 유무와 무관하게 공개 항목의 사진·설명을 모두 분석해 우선순위를 만든다."""
    photo_images: dict[str, str] = {}
    description_texts: dict[str, str] = {}
    for candidate in request.candidates:
        photo = _fetch_public_image(candidate.imageUrl) if candidate.imageUrl else None
        if photo:
            photo_images[candidate.id] = photo
        elif candidate.text.strip():
            description_texts[candidate.id] = candidate.text

    scores: dict[str, int] = {}
    basis: dict[str, str] = {}
    vision_used = False
    if photo_images:
        computed = image_similarity.score_similarity(request.references, photo_images) if request.references \
            else image_similarity.score_text_image_similarity(request.imageFeatures, photo_images)
        if computed:
            vision_used = True
            scores.update(computed)
        else:
            scores.update(_multimodal_visual_scores(request.query, request.imageFeatures, request.references, photo_images))
        basis.update({candidate_id: "photo" for candidate_id in photo_images})

    for candidate_id, text in description_texts.items():
        scores[candidate_id] = _text_feature_score(request.imageFeatures, text)
        basis[candidate_id] = "description"

    results = [
        AiVisualMatchResult(
            id=candidate.id,
            imageSimilarity=scores.get(candidate.id, 0),
            basis=basis.get(candidate.id, "description" if candidate.id in description_texts else "photo"),
            reason="공개 사진과 시각 특징을 비교했어요." if basis.get(candidate.id) == "photo" else "설명에 시각 특징이 있는지 확인했어요.",
        )
        for candidate in request.candidates
    ]
    results.sort(key=lambda item: item.imageSimilarity, reverse=True)
    return AiVisualMatchResponse(
        results=results,
        source="vision-model" if vision_used else "multimodal",
        usedFeatures=request.imageFeatures,
    )


def rank_context_candidates(request: AiContextRankRequest) -> AiContextRankResponse:
    value = _json_object(_completion("multimodal", [
        {"role": "system", "content": _prompt("rank_context_candidates.txt")},
        {"role": "user", "content": json.dumps({
            "originalQuery": request.originalQuery,
            "searchQuery": request.searchQuery,
            "imageDescriptions": request.imageDescriptions,
            "appliedFilters": request.filters,
            "candidateIdsInOrder": [candidate.id for candidate in request.candidates],
            "candidates": [candidate.model_dump() for candidate in request.candidates],
        }, ensure_ascii=False)},
    ]))
    try:
        result = AiContextRankResponse.model_validate(value)
    except ValidationError as error:
        raise AiPipelineError(502, "ai_invalid_response", "AI 설명·장소 분석 결과를 확인할 수 없어요.") from error
    expected = {candidate.id for candidate in request.candidates}
    actual = [item.id for item in result.results]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise AiPipelineError(502, "ai_invalid_response", "AI 설명·장소 분석 결과가 일부 누락되거나 중복됐어요.")
    return result.model_copy(update={"results": sorted(result.results, key=lambda item: item.score, reverse=True)})

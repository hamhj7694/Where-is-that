from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import ValidationError

from . import config
from .ai_schemas import (
    AiContextRankRequest,
    AiContextRankResponse,
    AiRankCandidate,
    AiRankRequest,
    AiRankResponse,
    AiSearchPlan,
    AiSearchRequest,
)


class AiPipelineError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


Role = Literal["llm", "vlm", "vision"]
_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$")


def _role_config(role: Role) -> tuple[str, str, str, str]:
    if role == "llm":
        return config.AI_LLM_PROVIDER, config.AI_LLM_API_KEY, config.AI_LLM_BASE_URL, config.AI_LLM_MODEL
    if role == "vlm":
        return config.AI_VLM_PROVIDER, config.AI_VLM_API_KEY, config.AI_VLM_BASE_URL, config.AI_VLM_MODEL
    return config.AI_VISION_PROVIDER, config.AI_VISION_API_KEY, config.AI_VISION_BASE_URL, config.AI_VISION_MODEL


def status_payload() -> dict[str, Any]:
    roles: dict[str, dict[str, Any]] = {}
    role_names: dict[str, Role] = {"llm": "llm", "vlm": "vlm", "vision": "vision"}
    for name, role in role_names.items():
        provider, key, _, model = _role_config(role)
        roles[name] = {"available": bool(key and model and provider == "openai-compatible"), "provider": provider, "model": model}
    return {"available": all(item["available"] for item in roles.values()), "roles": roles, "storesRequests": False}


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
    value = _json_object(_completion("vlm", [
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
    value = _json_object(_completion("llm", [
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
            "task": "작성한 검색 문장과 참고 사진 분석(referenceDescriptions), 그리고 참고 사진 원본을 모두 함께 고려해 각 후보를 채점하세요. score(종합 관련성), imageSimilarity(참고 사진의 대상·색상·모양·요소와의 시각적 유사도; 참고 사진 없으면 0), contextRelevance(검색 문장과 참고 사진 분석이 말하는 대상·장면·글자·시기 같은 맥락 관련성)을 각각 0~100 정수로 매기고 reasons는 최대 4개. 모든 후보 id를 한 번씩 포함하세요. 예: {\"results\":[{\"id\":\"...\",\"score\":0,\"imageSimilarity\":0,\"contextRelevance\":0,\"reasons\":[\"...\"]}]}",
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
    value = _json_object(_completion("vision", [
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
    return result.model_copy(update={
        "results": sorted(result.results, key=lambda item: item.score, reverse=True),
        "referenceDescriptions": descriptions,
    })


def rank_context_candidates(request: AiContextRankRequest) -> AiContextRankResponse:
    value = _json_object(_completion("llm", [
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

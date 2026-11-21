"""이미지 유사도만 담당하는 전용 비전 어댑터.

멀티모달 채팅 모델은 자연어·이미지·joint 해석을 맡고, 이 모듈은 사진 임베딩의
코사인 유사도만 계산한다. 참고 사진이 없으면 멀티모달이 텍스트에서 읽은 시각
특징을 임베딩해 공개 API 사진과 대조한다. 설정이 없으면 빈 결과를 반환해
호출부가 멀티모달 추론 점수를 사용한다(키·토큰은 응답에 노출하지 않는다).
"""

from __future__ import annotations

import math
import re
from typing import Any

import httpx

from . import config, local_vision

_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$")
_SUPPORTED_PROVIDERS = {"local-clip", "openai-compatible", "clip-http"}
_BATCH_SIZE = 8
# ("text", value) 또는 ("image", data_url)
EmbeddingItem = tuple[str, str]


def is_configured() -> bool:
    provider = config.AI_SIMILARITY_PROVIDER
    if provider == "local-clip":
        return local_vision.clip_available()
    if provider not in _SUPPORTED_PROVIDERS or not config.AI_SIMILARITY_MODEL:
        return False
    if not config.AI_SIMILARITY_BASE_URL:
        return False
    return bool(config.AI_SIMILARITY_API_KEY) or provider == "clip-http"


def status_payload() -> dict[str, Any]:
    available = is_configured()
    provider = config.AI_SIMILARITY_PROVIDER
    if provider == "local-clip":
        return {
            "available": available,
            "provider": provider,
            "model": f"{config.LOCAL_CLIP_MODEL}/{config.LOCAL_CLIP_PRETRAINED}",
            "source": "vision-model" if available else "multimodal",
            "crop": {
                "enabled": config.YOLOE_ENABLED and local_vision.yoloe_available(),
                "model": config.YOLOE_MODEL.rsplit("/", 1)[-1],
            },
        }
    return {
        "available": available,
        "provider": provider,
        "model": config.AI_SIMILARITY_MODEL,
        "source": "vision-model" if available else "multimodal",
    }


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if config.AI_SIMILARITY_API_KEY:
        headers["Authorization"] = "Bearer " + config.AI_SIMILARITY_API_KEY
    return headers


def _input_item(kind: str, value: str) -> Any:
    style = config.AI_SIMILARITY_INPUT_STYLE
    if kind == "text":
        if style == "image":
            return {"text": value}
        if style == "url":
            return value
        return {"type": "text", "text": value}
    if style == "image":
        return {"image": value}
    if style == "url":
        return value
    return {"type": "image_url", "image_url": {"url": value}}


def _to_vector(value: object) -> list[float] | None:
    if not isinstance(value, list):
        return None
    try:
        vector = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    return vector or None


def _embed_batch(items: list[EmbeddingItem]) -> list[list[float]] | None:
    provider = config.AI_SIMILARITY_PROVIDER
    try:
        if provider == "clip-http":
            vectors: list[list[float]] = []
            for kind, value in items:
                payload: dict[str, Any] = {"model": config.AI_SIMILARITY_MODEL}
                payload[kind] = value.split(",", 1)[1] if kind == "image" else value
                response = httpx.post(
                    config.AI_SIMILARITY_BASE_URL + "/embed",
                    headers=_headers(),
                    json=payload,
                    timeout=config.AI_SIMILARITY_TIMEOUT,
                )
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict):
                    return None
                vector = _to_vector(body.get("embedding") or body.get("vector"))
                if vector is None:
                    return None
                vectors.append(vector)
            return vectors

        response = httpx.post(
            config.AI_SIMILARITY_BASE_URL + "/embeddings",
            headers=_headers(),
            json={
                "model": config.AI_SIMILARITY_MODEL,
                "input": [_input_item(kind, value) for kind, value in items],
                "encoding_format": "float",
            },
            timeout=config.AI_SIMILARITY_TIMEOUT,
        )
        response.raise_for_status()
        body = response.json()
        rows = body.get("data") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            return None
        indexed: list[tuple[int, list[float]]] = []
        for row in rows:
            if not isinstance(row, dict):
                return None
            vector = _to_vector(row.get("embedding"))
            if vector is None:
                return None
            index = row.get("index", len(indexed))
            if not isinstance(index, int):
                return None
            indexed.append((index, vector))
        indexed.sort(key=lambda entry: entry[0])
        return [vector for _, vector in indexed]
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return None


def _embed_all(items: list[EmbeddingItem]) -> list[list[float]] | None:
    result: list[list[float]] = []
    for start in range(0, len(items), _BATCH_SIZE):
        vectors = _embed_batch(items[start:start + _BATCH_SIZE])
        if vectors is None:
            return None
        result.extend(vectors)
    return result if len(result) == len(items) else None


def _cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if not left_norm or not right_norm:
        return 0.0
    return max(-1.0, min(1.0, dot / (left_norm * right_norm)))


def _valid_images(candidates: dict[str, str]) -> bool:
    return bool(candidates) and all(
        isinstance(image, str) and _DATA_URL.fullmatch(image)
        for image in candidates.values()
    )


def score_similarity(
    references: list[str],
    candidates: dict[str, str],
    targets: str = "",
    vlm_multi: dict[str, bool] | None = None,
) -> dict[str, int]:
    """참고 사진 각각과 후보 사진의 유사도 중 최대값을 0~100으로 반환한다."""
    if config.AI_SIMILARITY_PROVIDER == "local-clip":
        return local_vision.score_similarity(references, candidates, targets, vlm_multi)
    if not references or not _valid_images(candidates) or not is_configured():
        return {}
    if any(not isinstance(image, str) or not _DATA_URL.fullmatch(image) for image in references):
        return {}
    items: list[EmbeddingItem] = [("image", image) for image in references]
    items.extend(("image", image) for image in candidates.values())
    embeddings = _embed_all(items)
    if embeddings is None:
        return {}
    reference_vectors = embeddings[:len(references)]
    scores: dict[str, int] = {}
    for offset, (candidate_id, _) in enumerate(candidates.items()):
        vector = embeddings[len(references) + offset]
        best = max((_cosine(vector, reference) for reference in reference_vectors), default=0.0)
        scores[candidate_id] = int(round(max(0.0, min(1.0, best)) * 100))
    return scores


def score_text_image_similarity(
    texts: list[str],
    candidates: dict[str, str],
    targets: str = "",
    vlm_multi: dict[str, bool] | None = None,
) -> dict[str, int]:
    """텍스트에서 읽은 시각 특징과 공개 사진의 유사도를 0~100으로 반환한다.

    참고 사진이 없을 때 사용하는 경로다. 여러 특징 중 가장 높은 일치도를 후보 점수로 쓴다.
    """
    if config.AI_SIMILARITY_PROVIDER == "local-clip":
        return local_vision.score_text_image_similarity(texts, candidates, targets, vlm_multi)
    clean_texts = [text.strip()[:120] for text in texts if isinstance(text, str) and text.strip()]
    if not clean_texts or not _valid_images(candidates) or not is_configured():
        return {}
    items: list[EmbeddingItem] = [("text", text) for text in clean_texts]
    items.extend(("image", image) for image in candidates.values())
    embeddings = _embed_all(items)
    if embeddings is None:
        return {}
    text_vectors = embeddings[:len(clean_texts)]
    scores: dict[str, int] = {}
    for offset, (candidate_id, _) in enumerate(candidates.items()):
        vector = embeddings[len(clean_texts) + offset]
        best = max((_cosine(vector, text) for text in text_vectors), default=0.0)
        scores[candidate_id] = int(round(max(0.0, min(1.0, best)) * 100))
    return scores


def crop_notes(
    targets: str, candidates: dict[str, str], vlm_multi: dict[str, bool] | None = None
) -> dict[str, str]:
    """로컬 비전이 타깃을 크롭한 후보의 근거 문구를 반환한다."""
    if config.AI_SIMILARITY_PROVIDER != "local-clip":
        return {}
    return local_vision.crop_notes(targets, candidates, vlm_multi)

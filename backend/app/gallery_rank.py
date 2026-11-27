"""Rank a browser-connected gallery using the device's CLIP model."""

import re
from functools import lru_cache

from . import local_vision
from .ai_pipeline import AiPipelineError, _completion, _json_object
from .ai_schemas import AiGalleryRankRequest

_QUERY_PROMPT = (
    "Convert the user's photo search text into a short English image caption for CLIP retrieval. "
    "Return a JSON object with a prompt string up to 120 characters. "
    "Describe the requested subject, scene and visible features. Keep specific object types distinct. "
    "Leave out things the user wants to exclude. Do not add unrequested features."
)
_FALLBACK_TERMS = {
    "너트": "metal nut",
    "와셔": "washer",
    "워셔": "washer",
    "볼트": "bolt",
    "나사": "screw",
}


@lru_cache(maxsize=128)
def _interpret_query(query: str) -> str:
    value = _json_object(_completion("llm", [
        {"role": "system", "content": _QUERY_PROMPT},
        {"role": "user", "content": query},
    ]))
    prompt = value.get("prompt")
    return prompt.strip()[:160] if isinstance(prompt, str) else ""


def gallery_query_prompt(query: str) -> str:
    query = query.strip()
    if not query:
        return ""
    try:
        if prompt := _interpret_query(query):
            return prompt
    except AiPipelineError:
        # Candidate scoring still works with a local prompt if the text provider is unavailable.
        pass
    translated = " ".join(english for korean, english in _FALLBACK_TERMS.items() if korean in query)
    if translated:
        return f"a photo of {translated}"[:160]
    prompts = local_vision.text_prompts((query,), "")
    return next((prompt[:160] for prompt in reversed(prompts) if re.search("[a-zA-Z]", prompt)), query[:160])


def rank_gallery_batch(request: AiGalleryRankRequest) -> dict:
    if not local_vision.clip_available():
        raise AiPipelineError(503, "local_vision_unavailable", "이 기기의 사진 분석 모델을 사용할 수 없어요.")
    try:
        query = local_vision.embed_text(request.queryPrompt) if request.queryPrompt else None
        reference = None
        if request.reference:
            reference = local_vision.embed_gallery_images({"reference": request.reference}).get("reference")
            if reference is None:
                raise AiPipelineError(422, "reference_unreadable", "참고 사진을 읽지 못했어요. 다른 사진을 선택해 주세요.")
        vectors = local_vision.embed_gallery_images({item.id: item.image for item in request.candidates})
    except (ValueError, OSError, RuntimeError, ImportError) as error:
        raise AiPipelineError(503, "local_vision_unavailable", "이 기기에서 사진 분석을 마치지 못했어요.") from error

    results = []
    for item_id, vector in vectors.items():
        context_score = local_vision.similarity_score(vector, [query], text_headroom=True) if query else None
        image_score = local_vision.similarity_score(vector, [reference], image=True) if reference else context_score
        if context_score is None:
            context_score = image_score
        results.append({
            "id": item_id,
            "score": round(0.3 * image_score + 0.7 * context_score, 4),
            "imageSimilarity": round(image_score, 4),
            "contextRelevance": round(context_score, 4),
        })
    return {"results": results}

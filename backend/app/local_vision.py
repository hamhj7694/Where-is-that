"""사전학습 YOLOE + CLIP으로 관심 물건만 크롭해 벡터 비교하는 로컬 비전.

추가 학습은 하지 않는다. YOLOE는 자연어에서 뽑은 타깃 라벨로 물건 위치를 찾아
바운딩박스만 남기고, CLIP은 그 크롭(또는 텍스트 프롬프트)과 공개 사진을 같은
벡터 공간에서 비교한다. 탐지 실패 시 원본으로 폴백한다.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import logging
import math
import re
import threading
from functools import lru_cache
from typing import Any

from . import config

logger = logging.getLogger(__name__)

_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$")
_MODEL_LOCK = threading.RLock()

# 자연어에 자주 나오는 습득물·시각 특징을 YOLOE/CLIP이 잘 아는 영어 라벨로 바꾼다.
# 모델은 영어 텍스트 프롬프트에 훨씬 강하므로 한국어 입력을 여기서 번역한다.
_LABEL_MAP = {
    "지갑": "wallet", "돈지갑": "wallet", "재갑": "wallet",
    "지폐": "banknote", "돈": "money", "동전": "coin",
    "카드": "card", "신용카드": "credit card", "교통카드": "transit card",
    "우산": "umbrella", "장우산": "umbrella",
    "열쇠": "key", "키": "key", "자물쇠": "lock",
    "안경": "eyeglasses", "돋보기": "eyeglasses", "선글라스": "sunglasses",
    "휴대폰": "cell phone", "핸드폰": "cell phone", "스마트폰": "cell phone", "전화기": "telephone",
    "가방": "handbag", "손가방": "handbag", "배낭": "backpack", "백팩": "backpack", "서류가방": "briefcase",
    "시계": "watch", "손목시계": "wristwatch",
    "반지": "ring", "목걸이": "necklace", "귀걸이": "earring", "팔찌": "bracelet",
    "신발": "shoe", "운동화": "sneaker", "구두": "dress shoe", "슬리퍼": "sandal",
    "모자": "hat", "장갑": "glove", "마스크": "mask", "스카프": "scarf", "넥타이": "tie",
    "책": "book", "수첩": "notebook", "노트북": "laptop", "컴퓨터": "computer", "태블릿": "tablet",
    "카메라": "camera", "이어폰": "earphone", "헤드폰": "headphones", "충전기": "charger", "케이블": "cable",
    "병": "bottle", "물병": "water bottle", "컵": "cup", "텀블러": "tumbler", "도시락": "lunch box",
    "여권": "passport", "주민등록증": "identity card", "운전면허증": "driver license", "우표": "stamp",
    "딸기": "strawberry", "사과": "apple", "바나나": "banana", "오렌지": "orange",
    "고양이": "cat", "강아지": "dog", "꽃": "flower", "인형": "stuffed toy", "열매": "fruit",
    "손": "hand", "사람": "person", "책상": "desk", "의자": "chair", "컴퓨터 본체": "computer",
}
_SKIP_LABELS = {
    "black", "white", "red", "blue", "color", "photo", "picture", "image",
    "with", "drawing", "and", "the", "for",
}
# CLIP 코사인 유사도는 완전 일치가 1.0이 아니라 보통 0.25~0.40대라서
# 실서비스 점수로 쓰기 위해 그 구간을 0~100으로 늘린다.
_CLIP_SCORE_BASE = 0.10
_CLIP_SCORE_SPAN = 0.35


def clip_available() -> bool:
    return bool(
        config.LOCAL_VISION_ENABLED
        and importlib.util.find_spec("torch")
        and importlib.util.find_spec("open_clip")
    )


def yoloe_available() -> bool:
    return bool(config.YOLOE_ENABLED and importlib.util.find_spec("ultralytics"))


@lru_cache(maxsize=256)
def target_labels(hints: str) -> tuple[str, ...]:
    """검색어·시각 특징에서 YOLOE/CLIP에 줄 영어 타깃 라벨을 뽑는다."""
    text = re.sub(r"\s+", " ", (hints or "").strip().lower())
    if not text:
        return ()
    labels: list[str] = []
    for korean, english in _LABEL_MAP.items():
        if korean in text and english not in labels:
            labels.append(english)
    for word in re.findall(r"[a-zA-Z][a-zA-Z\-]{2,30}", text):
        cleaned = word.strip().lower()
        if cleaned and cleaned not in _SKIP_LABELS and cleaned not in labels:
            labels.append(cleaned)
    return tuple(labels[:6])


@lru_cache(maxsize=256)
def text_prompts(texts: tuple[str, ...], targets: str) -> tuple[str, ...]:
    """CLIP 텍스트 임베딩용 영어 프롬프트를 만든다(한국어 특징도 라벨로 변환)."""
    combined = " ".join([*texts, targets])
    labels = target_labels(combined)
    prompts = [f"a photo of {label}" for label in labels]
    for text in texts:
        if re.search(r"[A-Za-z]{3,}", text):
            prompts.append(text.strip()[:120])
    unique = list(dict.fromkeys(prompt for prompt in prompts if prompt.strip()))
    return tuple(unique[:8]) or labels or texts[:8]


@lru_cache(maxsize=256)
def scope_keywords(hints: str) -> tuple[str, ...]:
    """카테고리 범위 제한에 쓸 한국어·영어 키워드를 만든다."""
    text = re.sub(r"\s+", " ", (hints or "").strip().lower())
    keywords: list[str] = list(target_labels(text))
    for korean in _LABEL_MAP:
        if korean in text and korean not in keywords:
            keywords.append(korean)
    return tuple(keywords[:8])


def scope_candidates(
    candidates: dict[str, str],
    texts: dict[str, str],
    hints: str,
    limit: int | None = None,
) -> dict[str, str]:
    """카테고리 키워드가 있는 후보만 남겨 불필요한 임베딩 비교를 줄인다."""
    cap = limit or config.VISUAL_MATCH_MAX_COMPARE
    items = list(candidates.items())[:cap]
    if not items:
        return {}
    keywords = scope_keywords(hints)
    if not keywords:
        return dict(items)
    matched: dict[str, str] = {}
    unknown: dict[str, str] = {}
    for candidate_id, image in items:
        text = texts.get(candidate_id, "").strip().lower()
        if not text:
            unknown[candidate_id] = image
        elif any(keyword.lower() in text for keyword in keywords):
            matched[candidate_id] = image
    scoped = dict((list(matched.items()) + list(unknown.items()))[:cap])
    return scoped or dict(items)


@lru_cache(maxsize=1)
def _clip_bundle() -> Any:
    with _MODEL_LOCK:
        import open_clip

        model, _, preprocess = open_clip.create_model_and_transforms(
            config.LOCAL_CLIP_MODEL, pretrained=config.LOCAL_CLIP_PRETRAINED
        )
        tokenizer = open_clip.get_tokenizer(config.LOCAL_CLIP_MODEL)
        model.eval()
        return model, preprocess, tokenizer


@lru_cache(maxsize=1)
def _yoloe_model() -> Any:
    with _MODEL_LOCK:
        from ultralytics import YOLOE

        return YOLOE(config.YOLOE_MODEL)


def _decode(data_url: str):
    if not isinstance(data_url, str) or not _DATA_URL.fullmatch(data_url):
        raise ValueError("invalid data url")
    from PIL import Image, ImageOps

    raw = base64.b64decode(data_url.split(",", 1)[1])
    with Image.open(io.BytesIO(raw)) as original:
        return ImageOps.exif_transpose(original).convert("RGB")


def _encode(image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _clutter_ratio(image) -> float:
    """배경이 얼마나 복잡한지 0~1로 추정한다(작은 색상 격자만 쓴다)."""
    small = image.convert("RGB").resize((16, 16))
    flatten = getattr(small, "get_flattened_data", None) or small.getdata
    pixels = list(flatten())
    border = [
        pixels[y * 16 + x]
        for y in range(16) for x in range(16)
        if x < 2 or x > 13 or y < 2 or y > 13
    ]
    base = tuple(sum(pixel[channel] for pixel in border) // len(border) for channel in range(3))
    inner = [pixels[y * 16 + x] for y in range(3, 13) for x in range(3, 13)]
    differences = [sum(abs(pixel[channel] - base[channel]) for channel in range(3)) / 3 for pixel in inner]
    return sum(difference > 28 for difference in differences) / len(differences)


def needs_crop(image) -> bool:
    """단순 배경이면 탐지 호출 자체를 피하고, 복잡한 배경에서만 크롭을 고려한다."""
    return _clutter_ratio(image) >= config.CROP_CLUTTER_THRESHOLD


@lru_cache(maxsize=128)
def crop_target(data_url: str, labels: tuple[str, ...]) -> tuple[str, bool]:
    """타깃 물건만 남긴(data url, 크롭 여부)을 반환한다. 실패하면 원본을 쓴다."""
    if not labels or not yoloe_available():
        return data_url, False
    try:
        image = _decode(data_url)
        if not needs_crop(image):
            return data_url, False
        image.thumbnail((1024, 1024))
        model = _yoloe_model()
        with _MODEL_LOCK:
            model.set_classes(list(labels))
            results = model.predict(
                image,
                conf=config.YOLOE_CONFIDENCE,
                max_det=config.YOLOE_MAX_DETECTIONS,
                verbose=False,
            )
        best: tuple[float, float, tuple[float, float, float, float]] | None = None
        for result in results:
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            names = getattr(result, "names", {}) or {}
            for index in range(len(boxes)):
                name = str(names.get(int(boxes.cls[index]), "")).lower()
                if not any(label.split()[-1] in name or name in label for label in labels):
                    continue
                confidence = float(boxes.conf[index])
                x1, y1, x2, y2 = (float(value) for value in boxes.xyxy[index])
                area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
                score = confidence * math.sqrt(max(area, 1.0))
                if best is None or score > best[0]:
                    best = (score, confidence, (x1, y1, x2, y2))
        if best is None:
            return data_url, False
        x1, y1, x2, y2 = best[2]
        box_ratio = max(0.0, x2 - x1) * max(0.0, y2 - y1) / max(1, image.width * image.height)
        if box_ratio >= config.CROP_MAX_BOX_RATIO:
            return data_url, False
        pad_x = (x2 - x1) * 0.05
        pad_y = (y2 - y1) * 0.05
        box = (
            max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y)),
            min(image.width, int(x2 + pad_x)), min(image.height, int(y2 + pad_y)),
        )
        if box[2] - box[0] < 12 or box[3] - box[1] < 12:
            return data_url, False
        return _encode(image.crop(box)), True
    except (ValueError, OSError, RuntimeError, ImportError) as error:
        logger.warning("local vision crop failed: %s", error)
        return data_url, False


@lru_cache(maxsize=512)
def embed_image(data_url: str) -> tuple[float, ...]:
    import torch

    model, preprocess, _ = _clip_bundle()
    image = _decode(data_url)
    with torch.inference_mode():
        tensor = preprocess(image).unsqueeze(0)
        vector = model.encode_image(tensor)
        vector = vector / vector.norm(dim=-1, keepdim=True)
        return tuple(float(value) for value in vector[0])


@lru_cache(maxsize=256)
def embed_text(prompt: str) -> tuple[float, ...]:
    import torch

    model, _, tokenizer = _clip_bundle()
    with torch.inference_mode():
        vector = model.encode_text(tokenizer([prompt[:120]]))
        vector = vector / vector.norm(dim=-1, keepdim=True)
        return tuple(float(value) for value in vector[0])


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if not left_norm or not right_norm:
        return 0.0
    return max(-1.0, min(1.0, dot / (left_norm * right_norm)))


def _score(vector: tuple[float, ...], references: list[tuple[float, ...]]) -> int:
    best = max((_cosine(vector, reference) for reference in references), default=0.0)
    calibrated = (best - _CLIP_SCORE_BASE) / _CLIP_SCORE_SPAN
    return int(round(max(0.0, min(1.0, calibrated)) * 100))


def score_similarity(
    references: list[str], candidates: dict[str, str], targets: str = ""
) -> dict[str, int]:
    """참고 사진과 공개 사진을 타깃 크롭 후 CLIP 코사인 유사도로 비교한다."""
    if not references or not candidates or not clip_available():
        return {}
    labels = target_labels(targets)
    try:
        reference_images = [crop_target(image, labels)[0] for image in references]
        candidate_images = {
            candidate_id: crop_target(image, labels)[0]
            for candidate_id, image in candidates.items()
        }
        reference_vectors = [embed_image(image) for image in reference_images]
        return {
            candidate_id: _score(embed_image(image), reference_vectors)
            for candidate_id, image in candidate_images.items()
        }
    except (ValueError, OSError, RuntimeError, ImportError) as error:
        logger.warning("local vision similarity failed: %s", error)
        return {}


def score_text_image_similarity(
    texts: list[str], candidates: dict[str, str], targets: str = ""
) -> dict[str, int]:
    """텍스트 시각 특징을 영어 프롬프트로 바꿔 공개 사진(크롭)과 비교한다."""
    clean_texts = tuple(text.strip()[:120] for text in texts if isinstance(text, str) and text.strip())
    if not clean_texts or not candidates or not clip_available():
        return {}
    labels = target_labels(" ".join(clean_texts) + " " + targets)
    prompts = text_prompts(clean_texts, targets)
    try:
        text_vectors = [embed_text(prompt) for prompt in prompts]
        return {
            candidate_id: _score(embed_image(crop_target(image, labels)[0]), text_vectors)
            for candidate_id, image in candidates.items()
        }
    except (ValueError, OSError, RuntimeError, ImportError) as error:
        logger.warning("local vision text similarity failed: %s", error)
        return {}


def crop_notes(targets: str, candidates: dict[str, str]) -> dict[str, str]:
    """어느 후보에서 타깃을 크롭했는지 근거 문구를 만든다."""
    if not candidates or not yoloe_available():
        return {}
    labels = target_labels(targets)
    if not labels:
        return {}
    notes: dict[str, str] = {}
    for candidate_id, image in candidates.items():
        try:
            if crop_target(image, labels)[1]:
                notes[candidate_id] = "사진에서 관심 물건 부분만 잘라 비교했어요."
        except (ValueError, OSError, RuntimeError, ImportError):
            continue
    return notes

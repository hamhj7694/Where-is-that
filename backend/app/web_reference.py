"""낯선 고유명사를 인터넷에서 찾아 시각 참고 자료를 만든다.

치이카와·하치와레·짱구·먼작귀처럼 모델이 말만으로는 잘 모르는 캐릭터는
웹에서 설명과 대표 이미지를 가져와 특징 문구와 참고 사진(data URL)으로 바꾼다.
이 결과는 ``match_visual_features``의 ``imageFeatures``/``references``에 그대로 붙어
공개 분실물 사진과 비교된다. 공개 API와 공개 리더만 쓰므로 키를 저장하지 않는다.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import re
from contextlib import closing
from urllib.parse import quote, urlparse

import httpx
from PIL import Image

from . import config, db

logger = logging.getLogger(__name__)

USER_AGENT = "Geugeo-Eodi/0.1 (public lost-item visual search)"
BROWSER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36"
JINA_READER = "https://r.jina.ai/"
WIKI_ARTICLE = "https://{lang}.wikipedia.org/wiki/{title}"
WIKI_SEARCH = "https://{lang}.wikipedia.org/w/index.php?search={term}"
DUCKDUCKGO = "https://api.duckduckgo.com/"
IMAGE_HOSTS = {
    "upload.wikimedia.org", "thumb.wikimedia.org", "duckduckgo.com", "search.pstatic.net",
}
NAVER_IMAGE_SEARCH = "https://search.naver.com/search.naver"

# 색상·일반 명사는 웹에서 찾아도 공개 사진 비교에 도움이 안 되므로 건너뛴다.
GENERIC_TERMS = frozenset({
    "카드", "지갑", "가방", "그림", "캐릭터", "모양", "물건", "사진", "이름", "색", "색상",
    "파란색", "파랑", "하늘색", "청록색", "빨간색", "분홍색", "노란색", "초록색", "보라색",
    "검정색", "검은색", "흰색", "하양", "갈색", "회색", "금색", "은색", "남색",
})

# 위키 문서 맨 위의 아이콘·안내 그림은 캐릭터 특징이 아니다.
SKIP_IMAGE_WORDS = (
    "picto_", "edit", "icon", "commons", "wikimedia", "wikipedia", "ambox",
    "question", "crystal", "symbol", "disambig", "redirect", "flag_of_", "_svg",
)
IMAGE_PATTERN = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
NAVER_IMAGE_PATTERN = re.compile(r"https://search\.pstatic\.net/common/\?[^\s\"'<>]+")


def is_generic(term: str) -> bool:
    value = term.strip().lower()
    return not value or value in GENERIC_TERMS or any(word in GENERIC_TERMS for word in value.split())


def _cache_key(term: str) -> str:
    return "webref3:" + hashlib.sha256(term.strip().lower().encode("utf-8")).hexdigest()


def _get(url: str, *, headers: dict | None = None, **kwargs) -> httpx.Response | None:
    try:
        response = httpx.get(
            url,
            timeout=config.WEB_REFERENCE_TIMEOUT,
            headers={"User-Agent": USER_AGENT, **(headers or {})},
            follow_redirects=True,
            **kwargs,
        )
        return response if response.status_code < 400 else None
    except Exception as error:
        logger.info("web reference request failed: %s", type(error).__name__)
        return None


def _features(summary: str, term: str) -> list[str]:
    result = [term.strip()[:40]]
    parts = re.split(r"(?<=[.!?。])\s+|\n+", summary)
    for part in parts:
        clause = re.sub(r"\[\[|\]\]", "", part).strip()
        if len(clause) < 8 or is_generic(clause):
            continue
        result.append(clause[:60])
        if len(result) >= 3:
            break
    return result


def _pick_image(markdown: str) -> str:
    urls = [url.split("?")[0] for url in IMAGE_PATTERN.findall(markdown)]
    useful = [(url, urlparse(url).path.rsplit("/", 1)[-1].lower()) for url in urls]
    useful = [(url, name) for url, name in useful if urlparse(url).hostname in IMAGE_HOSTS]
    good = [url for url, name in useful if not any(word in name for word in SKIP_IMAGE_WORDS) and "logo" not in name]
    if good:
        return good[0]
    logos = [url for url, name in useful if "logo" in name]
    if logos:
        return logos[0]
    return useful[0][0] if useful else ""


def _summary_lines(markdown: str) -> str:
    lines: list[str] = []
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line or line.startswith(("Title:", "URL Source:", "Final URL:", "Published Time:", "#")):
            continue
        if IMAGE_PATTERN.search(line):
            continue
        line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)  # 링크 → 글자만
        line = re.sub(r"[*`>_]", "", line).strip()
        if len(line) < 8 or line.startswith("![") or "|" in line:
            continue
        lines.append(line)
        if len(" ".join(lines)) >= 220:
            break
    return " ".join(lines)[:400]


def _fetch_wiki(term: str) -> dict:
    # 리더 프록시를 통해 위키 문서를 읽는다. 직접 API는 봇 정책으로 막히는 경우가 있다.
    for lang in ("ko", "en"):
        target = WIKI_ARTICLE.format(lang=lang, title=quote(term, safe=""))
        response = _get(JINA_READER + target) or _get(
            JINA_READER + WIKI_SEARCH.format(lang=lang, term=quote(term, safe=""))
        )
        if response is None:
            continue
        text = response.text
        if "Markdown Content:" not in text:
            continue
        markdown = text.split("Markdown Content:", 1)[1]
        summary = _summary_lines(markdown)
        if not summary:
            continue
        title_match = re.search(r"^Title:\s*(.+)$", text, re.MULTILINE)
        return {
            "term": term,
            "title": title_match.group(1).strip() if title_match else term,
            "summary": summary,
            "features": _features(summary, term),
            "image": _thumbnail(_pick_image(markdown)),
            "source": "wiki",
        }
    return {}


def _fetch_duckduckgo(term: str) -> dict:
    response = _get(DUCKDUCKGO, params={"q": term, "format": "json", "no_html": 1})
    if response is None:
        return {}
    try:
        body = response.json()
    except ValueError:
        return {}
    summary = str(body.get("AbstractText") or "").strip()
    if not summary:
        return {}
    image = str(body.get("Image") or "")
    if image.startswith("/"):
        image = "https://duckduckgo.com" + image
    return {
        "term": term,
        "title": str(body.get("Heading") or term),
        "summary": summary[:400],
        "features": _features(summary, term),
        "image": _thumbnail(image) if image else "",
        "source": "duckduckgo",
    }


def _naver_image_urls(term: str) -> list[str]:
    """위키 이미지가 막힐 때를 대비해 공개 이미지 검색에서 썸네일을 가져온다."""
    response = _get(
        NAVER_IMAGE_SEARCH,
        params={"where": "image", "query": term},
        headers={"User-Agent": BROWSER_AGENT},
    )
    if response is None:
        return []
    result: list[str] = []
    for url in NAVER_IMAGE_PATTERN.findall(response.text):
        url = url.replace("&amp;", "&")
        if url not in result:
            result.append(url)
        if len(result) >= config.WEB_REFERENCE_MAX_IMAGES:
            break
    return result


def _fetch(term: str) -> dict:
    result = _fetch_wiki(term) or _fetch_duckduckgo(term)
    if not result:
        return {}
    images = [result["image"]] if result.get("image") else []
    for url in _naver_image_urls(term):
        if len(images) >= config.WEB_REFERENCE_MAX_IMAGES:
            break
        thumbnail = _thumbnail(url)
        if thumbnail and thumbnail not in images:
            images.append(thumbnail)
    result["images"] = images
    result["image"] = images[0] if images else ""
    return result


def _thumbnail(url: str) -> str:
    """참고 이미지를 안전하게 작게 줄여 data URL로 만든다."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in IMAGE_HOSTS:
        return ""
    try:
        with httpx.Client(
            timeout=config.WEB_REFERENCE_TIMEOUT,
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            response = client.get(url)
            if response.status_code >= 400 or not response.headers.get("content-type", "").startswith("image/"):
                return ""
            if len(response.content) > config.VISUAL_MATCH_MAX_BYTES:
                return ""
            image = Image.open(io.BytesIO(response.content))
            image.thumbnail((config.VISUAL_MATCH_THUMBNAIL_SIDE, config.VISUAL_MATCH_THUMBNAIL_SIDE))
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=config.VISUAL_MATCH_THUMBNAIL_QUALITY)
            return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception as error:
        logger.info("web reference thumbnail failed: %s", type(error).__name__)
        return ""


def lookup(term: str) -> dict:
    """용어 하나에 대한 웹 참고 자료. 실패하면 빈 dict."""
    value = term.strip()
    if not value or is_generic(value) or not config.WEB_REFERENCE_ENABLED:
        return {}
    key = _cache_key(value)
    with closing(db.connect()) as connection:
        cached = db.cache_get(connection, "lostfound", key, config.WEB_REFERENCE_TTL)
    if cached is not None:
        return cached
    result = _fetch(value)
    if result:
        with closing(db.connect()) as connection:
            db.cache_set(connection, "lostfound", key, result)
    return result


def enrich(image_features: list[str], references: list[str] | None = None) -> tuple[list[str], list[str]]:
    """시각 특징에 웹에서 찾은 특징·참고 사진을 더한다.

    참고 사진은 ``match_visual_features``가 이미 사진↔사진 임베딩으로 비교하므로
    별도 임베딩 호출 없이 그대로 넘길 수 있다.
    """
    features = [term.strip() for term in (image_features or []) if isinstance(term, str) and term.strip()]
    refs = [ref for ref in (references or []) if isinstance(ref, str) and ref.startswith("data:image/")]
    if not config.WEB_REFERENCE_ENABLED:
        return features[:8], refs[:6]
    for term in list(features[:4]):
        if is_generic(term):
            continue
        # 사진이 이미 충분해도 낯선 이름의 설명은 필요하다. 이미지 개수만 제한한다.
        info = lookup(term)
        if not info:
            continue
        found_images = info.get("images") or ([info["image"]] if info.get("image") else [])
        for image in found_images:
            if len(refs) >= config.WEB_REFERENCE_MAX_IMAGES:
                break
            if image not in refs:
                refs.append(image)
        for feature in info.get("features", []):
            if feature not in features and len(features) < 8:
                features.append(feature)
    return features[:8], refs[:6]

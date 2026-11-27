from __future__ import annotations

import hashlib
import html
import json
import logging
import math
import re
import sqlite3
import threading
import unicodedata
import xml.etree.ElementTree as ET
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from . import config, db, lostfound_codes, search_period

logger = logging.getLogger(__name__)

BASE_URL = "https://apis.data.go.kr/1320000"
SEARCH_PATHS = {
    "police": "/LosfundInfoInqireService/getLosfundInfoAccTpNmCstdyPlace",
    "portal": "/LosPtfundInfoInqireService/getPtLosfundInfoAccTpNmCstdyPlace",
}
# 분류·지역·색상·기간을 서버에서 좁혀 주는 전용 필터 API.
FILTER_PATHS = {
    "police": "/LosfundInfoInqireService/getLosfundInfoAccToClAreaPd",
    "portal": "/LosPtfundInfoInqireService/getPtLosfundInfoAccToClAreaPd",
}
DETAIL_PATHS = {
    "police": "/LosfundInfoInqireService/getLosfundDetailInfo",
    "portal": "/LosPtfundInfoInqireService/getPtLosfundDetailInfo",
}
SOURCES = ("police", "portal")
PHOTO_SEARCH_RECENT_DAYS = 3
PERIOD_PAGE_ROWS = 100
PERIOD_MAX_PAGE = 9999
_PERIOD_CACHE_LOCKS = tuple(threading.Lock() for _ in range(16))
IMAGE_BASE = "https://www.lost112.go.kr"
MAX_XML_BYTES = 2_000_000
# 요청마다 새 커넥션을 만들면 TLS 핸드셰이크 때문에 전체 스캔이 몇 배 느려진다.
# 스레드 안전한 공용 클라이언트로 연결을 재사용한다.
_http_client = httpx.Client(
    timeout=config.POLICE_API_TIMEOUT,
    limits=httpx.Limits(
        max_connections=config.POLICE_API_MAX_CONNECTIONS,
        max_keepalive_connections=config.POLICE_API_MAX_CONNECTIONS,
    ),
)
# 실제 응답은 F2018113000002322뿐 아니라 V0007722L11170002 같은 영문+숫자 형식도 온다.
ATC_ID_PATTERN = re.compile(r"[A-Za-z0-9]{6,40}")


class PoliceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def configured() -> bool:
    return bool(config.POLICE_SERVICE_KEY)


def _request(path: str, params: dict[str, str | int]) -> ET.Element:
    query = {"serviceKey": config.POLICE_SERVICE_KEY}
    query.update({key: str(value) for key, value in params.items()})
    try:
        response = _http_client.get(BASE_URL + path, params=query)
    except httpx.TimeoutException:
        raise PoliceError("lostfound_timeout", "경찰청 유실물 서버 응답이 늦어요.")
    except httpx.HTTPError:
        raise PoliceError("lostfound_upstream", "경찰청 유실물 서버에 연결하지 못했어요.")
    if response.status_code != 200:
        logger.warning(
            "police api failed: status=%s body=%s",
            response.status_code,
            response.text[:300],
        )
        raise PoliceError("lostfound_upstream", "경찰청 유실물 정보를 가져오지 못했어요.")
    content = response.content[:MAX_XML_BYTES]
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        logger.warning("police api returned invalid xml: %s", response.text[:300])
        raise PoliceError("lostfound_upstream", "경찰청 유실물 정보 형식을 확인하지 못했어요.")
    _check_result(root)
    return root


def _check_result(root: ET.Element) -> None:
    code = ""
    message = ""
    for node in root.iter():
        if node.tag == "resultCode":
            code = (node.text or "").strip()
        elif node.tag in {"resultMsg", "resultMag"}:
            message = (node.text or "").strip()
    if code and code != "00":
        raise PoliceError("lostfound_upstream", "경찰청 유실물 조회에 실패했어요. (" + message[:60] + ")")


def _text(item: ET.Element, *tags: str) -> str:
    for tag in tags:
        node = item.find(tag)
        if node is not None and node.text:
            return node.text.strip()
    return ""


def _date(value: str) -> str:
    cleaned = value.strip()
    if re.fullmatch(r"\d{8}", cleaned):
        return cleaned[:4] + "-" + cleaned[4:6] + "-" + cleaned[6:]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
        return cleaned
    return ""


def _image_url(value: str) -> str:
    cleaned = value.strip()
    if not cleaned or "no_img" in cleaned.lower():
        return ""
    if cleaned.startswith("//"):
        cleaned = "https:" + cleaned
    elif cleaned.startswith("/"):
        cleaned = IMAGE_BASE + cleaned
    elif not re.match(r"^https?://", cleaned):
        return ""
    return cleaned[:500]


def _notes(value: str) -> str:
    cleaned = html.unescape(re.sub(r"<[^>]+>", "", value.strip()))
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:4000]


def _display_time(value: str) -> str:
    cleaned = value.strip()
    if cleaned in {"24", "2400"}:
        return "24:00"
    if re.fullmatch(r"\d{4}", cleaned):
        return cleaned[:2] + ":" + cleaned[2:]
    if re.fullmatch(r"\d{1,2}:\d{2}", cleaned):
        return cleaned
    return cleaned[:20]


def _normalize(source: str, item: ET.Element) -> dict:
    atc_id = _text(item, "atcId")[:40]
    fd_sn = _text(item, "fdSn")[:10]
    found_date = _date(_text(item, "fdYmd"))
    row = {
        "id": f"{source}:{atc_id}:{fd_sn}",
        "source": source,
        "atcId": atc_id,
        "fdSn": fd_sn,
        "name": _text(item, "fdPrdtNm")[:200],
        "subject": _text(item, "fdSbjt")[:300],
        "category": _text(item, "prdtClNm")[:100],
        "color": _text(item, "clrNm")[:100],
        "imageUrl": _image_url(_text(item, "fdFilePathImg")),
        "foundDate": found_date,
        "foundTime": _text(item, "fdHor")[:10],
        "foundPlace": _text(item, "fdPlace")[:100],
        "storagePlace": _text(item, "depPlace")[:100],
        "orgId": _text(item, "orgId")[:20],
        "orgName": _text(item, "orgNm")[:200],
        "tel": _text(item, "tel")[:30],
        "status": _text(item, "csteSteNm")[:50],
        "keepType": _text(item, "fndKeepOrgnSeNm")[:50],
        "notes": _notes(_text(item, "uniq")),
        "address": _text(item, "addr")[:200],
        "detailLoaded": False,
    }
    row["mapQuery"] = (
        row["storagePlace"] or row["orgName"] or row["address"] or row["foundPlace"]
    )
    row["display"] = {
        "date": found_date,
        "time": _display_time(row["foundTime"]),
        "category": row["category"],
        "color": row["color"],
        "place": row["storagePlace"] or row["orgName"],
    }
    return row


def _score(item: dict, keyword: str) -> float:
    name = item["name"].lower()
    subject = item["subject"].lower()
    category = item["category"].lower()
    score = 0.0
    if keyword:
        if keyword in name:
            score += 5
        elif keyword in subject:
            score += 3
        elif keyword in category:
            score += 1
    for token in {token for token in re.split(r"[\s,]+", keyword.lower()) if len(token) >= 2}:
        if token in name:
            score += 2
        elif token in subject:
            score += 1
        elif token in category:
            score += 0.5
    item["matchScore"] = round(score, 2)
    return score


def _keyword(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())[:100]


CRITERIA_TEXT_FIELDS = (
    "name", "subject", "notes", "category", "color", "foundPlace",
    "storagePlace", "orgName", "address", "status", "keepType",
)
CRITERIA_LIMITS = {"apiKeywords": 3, "include": 8, "any": 8, "exclude": 8, "prefer": 8, "imageFeatures": 8}
# 직접 찾기는 점수로 순위를 바꾸지 않고, 어떤 신호가 맞았는지 등급으로만 줄 세운다.
MATCH_TIERS = {
    0: "AI+검색어+필터 일치",
    1: "AI 조건 일치",
    2: "검색어 일치",
    3: "조건 필터 일치",
    4: "부분 일치",
    5: "공개 원문",
}


def _clean_terms(value: object, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for term in value:
        if not isinstance(term, str):
            continue
        cleaned = re.sub(r"\s+", " ", term.strip())[:40].lower()
        if cleaned and cleaned not in result:
            result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def _normalize_criteria(hints: object) -> dict[str, list[str]]:
    if not isinstance(hints, dict):
        return {}
    criteria = {key: _clean_terms(hints.get(key), limit) for key, limit in CRITERIA_LIMITS.items()}
    return criteria if any(criteria.values()) else {}


def _item_text(item: dict) -> str:
    text = " ".join(str(item.get(field) or "") for field in CRITERIA_TEXT_FIELDS)
    return re.sub(r"\s+", " ", text).lower()


# 공개 API는 개인정보를 '류*진'처럼 가려서 준다. 사용자가 '류영진'을 쳐도 같은 사람으로 찾아야 한다.
MASK_CHARS = "*?●○×"
_MASKED_SPAN = re.compile(r"[^\s()\[\],·|]+[" + re.escape(MASK_CHARS) + r"][^\s()\[\],·|]+")
_WORD = re.compile(r"[^\s()\[\],·|]+")


def _mask_pattern(token: str) -> re.Pattern | None:
    """가려진 글자를 한 글자 이상의 와일드카드로 바꾼 정규식."""
    if not any(char in token for char in MASK_CHARS):
        return None
    # '*'는 실제 이름에서 0글자 이상을 가릴 수 있다(예: 공개값 '류*진' ↔ 원문 '류진'·'류영진').
    parts = [".{0,3}" if char in MASK_CHARS else re.escape(char) for char in token]
    return re.compile("^" + "".join(parts) + "$", re.IGNORECASE)


def _masked_name_match(needle: str, text: str) -> bool:
    """검색어 쪽이나 공개값 쪽이 가려진 이름이어도 서로 맞는지 본다."""
    query_pattern = _mask_pattern(needle)
    if query_pattern:
        return any(query_pattern.fullmatch(token) for token in _WORD.findall(text))
    for span in _MASKED_SPAN.findall(text):
        span_pattern = _mask_pattern(span)
        if span_pattern and any(span_pattern.fullmatch(token) for token in needle.split()):
            return True
    return False


def _term_matches(term: str, text: str) -> bool:
    if not term or not text:
        return False
    if term in text:
        return True
    tokens = term.split()
    if len(tokens) > 1 and all(token in text for token in tokens):
        return True
    return _masked_name_match(term.lower(), text.lower())


def text_signal_score(item: dict, criteria: dict[str, list[str]], keyword: str) -> int:
    """제목에 핵심어가 들어간 정도를 점수로 만든다(사진 점수와 함께 순위에 쓴다)."""
    terms = []
    for key in ("include", "any", "prefer", "imageFeatures"):
        terms.extend(criteria.get(key, []))
    terms.extend(token for token in re.split(r"\s+", keyword.lower()) if len(token) >= 2)
    terms = list(dict.fromkeys(terms))
    name = str(item.get("name") or "").lower()
    subject = str(item.get("subject") or "").lower()
    category = str(item.get("category") or "").lower()
    score = 0
    for term in terms:
        if _term_matches(term, name):
            score += 4
        elif _term_matches(term, subject):
            score += 2
        elif _term_matches(term, category):
            score += 1
    if any(_term_matches(term, _item_text(item)) for term in criteria.get("exclude", [])):
        score -= 6
    return score


def score_criteria(item: dict, criteria: dict[str, list[str]]) -> dict:
    """공개 API 항목의 전체 텍스트에 AND/OR/NOT과 사진 특징을 적용한다.

    AI 단서를 점수로 돌려주고, 제외 단서에 해당해도 호출자가 후보 전체를 유지할 수 있게 한다.
    조건이 없으면 원래 공개 API 순서를 유지한다.
    """
    result = {"score": 0.0, "hits": [], "allInclude": False, "excluded": None}
    if not criteria:
        return result
    text = _item_text(item)
    include = criteria.get("include", [])
    varied = criteria.get("any", []) + criteria.get("imageFeatures", [])
    preferred = criteria.get("prefer", [])
    result["excluded"] = next((term for term in criteria.get("exclude", []) if _term_matches(term, text)), None)
    include_hits = [term for term in include if _term_matches(term, text)]
    varied_hits = [term for term in varied if _term_matches(term, text)]
    preferred_hits = [term for term in preferred if _term_matches(term, text)]
    result["allInclude"] = bool(include) and len(include_hits) == len(include)
    result["hits"] = include_hits + varied_hits + preferred_hits
    weight = len(include) * 3 + len(varied) + len(preferred)
    if weight:
        achieved = len(include_hits) * 3 + len(varied_hits) + len(preferred_hits)
        result["score"] = round(achieved / weight * 90 + (10 if result["allInclude"] else 0), 2)
    return result


def search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
    if source not in SEARCH_PATHS:
        raise PoliceError("lostfound_invalid_source", "유실물 검색 대상을 확인해 주세요.")
    root = _request(
        SEARCH_PATHS[source],
        {"PRDT_NM": keyword, "pageNo": page, "numOfRows": rows},
    )
    items = [_normalize(source, node) for node in root.iter("item")]
    total = 0
    for node in root.iter("totalCount"):
        try:
            total = int((node.text or "").strip())
        except ValueError:
            total = len(items)
        break
    return {"items": items, "totalCount": total or len(items)}


def _api_date(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    return digits[:8] if len(digits) == 8 else ""


def search_filtered(source: str, params: dict[str, str], page: int, rows: int) -> dict:
    """분류·지역·색상·기간 코드로 서버에서 좁힌 결과를 한 페이지 가져온다."""
    if source not in FILTER_PATHS:
        raise PoliceError("lostfound_invalid_source", "유실물 검색 대상을 확인해 주세요.")
    if source == "portal" and "FD_COL_CD" in params:
        params = {**params, "CLR_CD": params["FD_COL_CD"]}
        del params["FD_COL_CD"]
    root = _request(
        FILTER_PATHS[source],
        {**params, "pageNo": page, "numOfRows": rows},
    )
    items = [_normalize(source, node) for node in root.iter("item")]
    total = 0
    for node in root.iter("totalCount"):
        try:
            total = int((node.text or "").strip())
        except ValueError:
            total = len(items)
        break
    return {"items": items, "totalCount": total or len(items)}


def _cached_period_page(source: str, params: dict[str, str], page: int) -> dict:
    key = "period:v1:" + json.dumps([source, params, page, PERIOD_PAGE_ROWS], sort_keys=True)
    with _PERIOD_CACHE_LOCKS[hash(key) % len(_PERIOD_CACHE_LOCKS)]:
        try:
            with closing(db.connect()) as connection:
                cached = db.cache_get(connection, "lostfound", key, config.LOSTFOUND_SEARCH_TTL)
            if cached is not None:
                return cached
        except sqlite3.Error:
            logger.warning("Public period page cache unavailable")
        result = search_filtered(source, params, page, PERIOD_PAGE_ROWS)
        try:
            with closing(db.connect()) as connection:
                db.cache_set(connection, "lostfound", key, result)
        except sqlite3.Error:
            logger.warning("Public period page could not be cached")
        return result


def _period_candidates(
    period: dict, filters: dict | None, category: dict[str, str], cursor: dict | None,
) -> dict:
    # 매 요청에서 출처별 한 페이지를 진행한다. 우선 분류가 전체 날짜 조회를 막지 않는다.
    date_params = {"START_YMD": period["from"].replace("-", ""), "END_YMD": period["to"].replace("-", "")}
    applied = {**(filters or {}), "from": period["from"], "to": period["to"]}
    # 여러 공식 코드가 같은 표시 색상을 뜻한다. 공개 목록을 한 번 읽어 표시 색상을 확인한다.
    upstream_filters = {key: value for key, value in applied.items() if key != "color"}
    broad = lostfound_codes.filter_param_sets(upstream_filters, _api_date) or [date_params]
    priority = [{**params, **category} for params in broad] if category and not applied.get("category") else []
    # 원천의 여러 날짜 응답은 날짜순이 아님을 실측했다. 기본 기간에는 최근 일자의
    # 품목 페이지를 조금씩 별도 조회해 최신 품목이 여러 페이지 사이에 묻히는 일을 줄인다.
    daily = []
    if priority and period["basis"] == "default":
        end = date.fromisoformat(period["to"])
        for offset in range(7):
            day = (end - timedelta(days=offset)).strftime("%Y%m%d")
            daily.append({**priority[0], "START_YMD": day, "END_YMD": day})
    scope = hashlib.sha256(json.dumps([broad, priority, daily], sort_keys=True).encode()).hexdigest()
    pages = dict(cursor.get("pages", {})) if cursor and cursor.get("scope") == scope else {}
    sources: dict[str, list[dict]] = {source: [] for source in SOURCES}
    photo_priority: list[str] = []
    available: set[str] = set()
    errors: list[dict] = []

    with ThreadPoolExecutor(max_workers=min(4, config.BROWSE_MAX_WORKERS)) as executor:
        jobs = {}
        for kind, group in (("priority", priority), ("broad", broad)):
            for source in SOURCES:
                for index, params in enumerate(group):
                    key = f"{kind}:{source}:{index}"
                    number = pages.get(key, 1)
                    if number < 0:
                        available.add(source)
                    elif number <= PERIOD_MAX_PAGE:
                        jobs[key] = (source, number, executor.submit(_cached_period_page, source, params, number))
        for source in SOURCES:
            pending_days = [(f"priority:{source}:{i + 1}", params) for i, params in enumerate(daily)
                            if f"priority:{source}:{i + 1}" not in pages]
            for key, params in pending_days[:2]:
                jobs[key] = (source, 1, executor.submit(_cached_period_page, source, params, 1))
        for key, (source, number, future) in jobs.items():
            try:
                result = future.result()
            except PoliceError as error:
                errors.append({"source": source, "page": number, "lane": key.split(":")[0], "code": error.code, "message": error.message})
                continue
            available.add(source)
            items = [item.copy() for item in result["items"] if metadata_pass(
                item, applied, skip_region=bool(lostfound_codes.region_param(str(applied.get("region") or ""))),
            )]
            sources[source].extend(items)
            if key.startswith("priority:"):
                photo_priority.extend(item["id"] for item in items if item.get("imageUrl"))
            records_seen = (number - 1) * PERIOD_PAGE_ROWS + len(result["items"])
            one_page_sample = key.startswith("priority:") and not key.endswith(":0")
            if one_page_sample or records_seen >= result["totalCount"]:
                pages[key] = -number
            elif len(result["items"]) != PERIOD_PAGE_ROWS:
                # 공급자가 요청한 페이지 크기보다 적게 주면 다음 시작점을 신뢰할 수 없다.
                errors.append({"source": source, "page": number, "lane": key.split(":")[0], "code": "lostfound_short_page",
                               "message": "공개 API의 페이지 범위를 확인하지 못했어요."})
            else:
                pages[key] = number + 1

    coverage = {}
    for source in SOURCES:
        positions = [pages.get(f"broad:{source}:{i}", 1) for i in range(len(broad))]
        coverage[source] = {
            "pagesRead": sum(abs(position) - int(position > 0) for position in positions),
            "complete": all(position < 0 for position in positions),
        }
    return {
        "bySource": sources,
        "sources": [source for source in SOURCES if source in available],
        "photoPriority": list(dict.fromkeys(photo_priority)),
        "errors": errors,
        "coverage": {**period, "sources": coverage, "complete": all(value["complete"] for value in coverage.values())},
        "periodCursor": {"scope": scope, "pages": pages},
        "hasMore": any(0 < pages.get(f"broad:{source}:{i}", 1) <= PERIOD_MAX_PAGE
                       for source in SOURCES for i in range(len(broad))),
    }


def order_period_photos(items: list[dict], priority_ids: list[str], criteria: dict, query: str) -> list[dict]:
    priority = set(priority_ids)
    ordered = sorted((item for item in items if item.get("imageUrl")), key=lambda item: (
        text_signal_score(item, criteria, query), item["foundDate"], item["id"],
    ), reverse=True)
    preferred = deque(item for item in ordered if item["id"] in priority)
    broad = deque(item for item in ordered if item["id"] not in priority)
    output = []
    while preferred or broad:
        for lane in (preferred, preferred, broad):
            if lane:
                output.append(lane.popleft())
    return output


def criteria_pass(item: dict, criteria: dict[str, list[str]]) -> bool:
    """공개 설명이 AI 단서와 일치하는지 확인한다."""
    if not criteria:
        return True
    text = _item_text(item)
    if any(_term_matches(term, text) for term in criteria.get("exclude", [])):
        return False
    include = criteria.get("include", [])
    if include and not all(_term_matches(term, text) for term in include):
        return False
    alternatives = criteria.get("any", []) + criteria.get("imageFeatures", [])
    if alternatives and not any(_term_matches(term, text) for term in alternatives):
        return False
    return True


def metadata_pass(item: dict, filters: dict | None, *, skip_region: bool = False) -> bool:
    """URL 필터를 공개 항목 전체 필드에 적용한다(현재 페이지가 아니라 스캔한 전체 풀)."""
    values = filters if isinstance(filters, dict) else {}
    category = str(values.get("category") or "").strip()
    if category:
        actual = str(item.get("category") or "")
        broad_match = " > " not in category and actual.startswith(category + " >")
        if actual != category and not broad_match:
            return False
    color = str(values.get("color") or "").strip()
    if color and str(item.get("color") or "") != color:
        return False
    region = str(values.get("region") or "").strip()
    # 전용 필터 API가 지역 코드로 이미 좁혔으면 응답에 시도명이 없으므로 텍스트 검사를 생략한다.
    if region and not skip_region:
        places = " ".join(str(item.get(field) or "") for field in ("foundPlace", "address", "storagePlace", "orgName"))
        if region not in places:
            return False
    found_date = str(item.get("foundDate") or "")
    date_from = str(values.get("from") or "").strip()
    date_to = str(values.get("to") or "").strip()
    if date_from and (not found_date or found_date < date_from):
        return False
    if date_to and (not found_date or found_date > date_to):
        return False
    return True


def _image_key(value: object) -> str:
    """사진 경로의 추적용 쿼리만 빼고 비교한다. 사진이 없으면 빈 문자열."""
    raw = str(value or "").strip()
    if not raw or "no_img" in raw.lower():
        return ""
    if raw.startswith("//"):
        raw = "https:" + raw
    elif raw.startswith("/"):
        raw = IMAGE_BASE + raw
    elif not re.match(r"^https?://", raw):
        return ""
    try:
        parsed = urlsplit(raw)
        host = parsed.netloc.lower()
        if parsed.scheme == "https" and host.endswith(":443"):
            host = host[:-4]
        if parsed.scheme == "http" and host.endswith(":80"):
            host = host[:-3]
        query = urlencode([
            (key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if not re.match(r"^(utm_|fbclid$|gclid$|msclkid$)", key, re.I)
        ])
        return urlunsplit((parsed.scheme.lower(), host, parsed.path, query, ""))
    except ValueError:
        return raw.lower()


def _browse_dedupe_key(item: dict) -> str:
    """제목·사진 경로가 같으면 한 건으로 본다. 사진이 없으면 기존 내용 키로 폴백한다."""
    def clean(value: object) -> str:
        text = unicodedata.normalize("NFKC", str(value or ""))
        text = re.sub(r"[\u200b-\u200d\ufeff]", "", text)
        return re.sub(r"\s+", " ", text.strip()).lower()

    image = _image_key(item.get("imageUrl"))
    if image:
        return "title-image:" + clean(item.get("name")) + "|" + image
    fields = (
        item.get("name"), item.get("color"), item.get("category"), item.get("foundDate"),
        item.get("storagePlace") or item.get("orgName"),
    )
    return "content:" + "|".join(clean(value) for value in fields)


def _browse_page(
    cache: dict[str, dict] | None, lookup, source: str, query, page: int, rows: int,
) -> dict:
    if cache is None:
        return lookup(source, query, page, rows)
    key = json.dumps([lookup is search_filtered, source, query, page, rows], sort_keys=True, ensure_ascii=False)
    if key not in cache:
        cache[key] = lookup(source, query, page, rows)
    payload = cache[key]
    # 정렬과 사진 분석이 바꾼 필드는 원본 페이지에 쓰지 않는다.
    return {**payload, "items": [item.copy() for item in payload["items"]]}


def _browse_filtered(
    param_sets: list[dict[str, str]],
    rows: int,
    max_pages: int | None,
    visual_need: int = 0,
    page_cache: dict[str, dict] | None = None,
) -> tuple[dict[str, list[dict]], list[dict], int, bool]:
    """전용 필터 API로 서버에서 좁힌 뒤, 사진 분석 풀을 채울 때까지 다음 페이지를 읽는다."""
    results: dict[str, list[dict]] = {}
    errors: list[dict] = []
    total_reported = 0
    pages_scanned = 0
    limit_reached = False
    # 페이지와 무관하게 같은 풀을 읽어야 page만 바꿀 때 재조회·재분석하지 않는다.
    needed = visual_need or rows
    cap = config.LOSTFOUND_MAX_PAGES if max_pages is None else max_pages

    for params in param_sets:
        first: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
            futures = {source: executor.submit(_browse_page, page_cache, search_filtered, source, params, 1, rows) for source in SOURCES}
            for source, future in futures.items():
                try:
                    first[source] = future.result()
                except PoliceError as error:
                    if not any(entry["source"] == source for entry in errors):
                        errors.append({"source": source, "code": error.code, "message": error.message})
        if not first:
            continue
        for payload in first.values():
            total_reported = max(total_reported, payload["totalCount"])
        for source, payload in first.items():
            results.setdefault(source, []).extend(payload["items"])
        pages_scanned += len(first)

        largest = max((payload["totalCount"] for payload in first.values()), default=0)
        available = math.ceil(largest / rows) if largest else 0
        if cap and available > cap:
            available = cap
            limit_reached = True

        number = 2
        while number <= available:
            batch = list(range(number, min(number + 4, available + 1)))
            with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
                futures = {
                    (source, page_number): executor.submit(_browse_page, page_cache, search_filtered, source, params, page_number, rows)
                    for page_number in batch for source in SOURCES
                }
                for (source, _page_number), future in futures.items():
                    try:
                        payload = future.result()
                    except PoliceError as error:
                        if not any(entry["source"] == source for entry in errors):
                            errors.append({"source": source, "code": error.code, "message": error.message})
                        continue
                    results.setdefault(source, []).extend(payload["items"])
                    pages_scanned += 1
            number += 4
            if sum(len(rows_for_source) for rows_for_source in results.values()) >= needed:
                limit_reached = limit_reached or number <= available
                break
    return results, errors, total_reported, pages_scanned, limit_reached


def browse_all(
    keyword: str,
    page: int = 1,
    rows: int = 20,
    filters: dict | None = None,
    hints: dict | None = None,
    max_pages: int | None = None,
    visual_need: int = 0,
    search_mode: str | None = None,
    page_cache: dict[str, dict] | None = None,
    period_mode: bool = False,
    period_cursor: dict | None = None,
) -> dict:
    """직접 찾기용: 필터가 있으면 전용 API로, 없으면 이름 검색으로 여러 페이지를 스캔한다."""
    cleaned = _keyword(keyword)
    criteria = {} if search_mode == "basic" else _normalize_criteria(hints)
    has_ai = search_mode == "ai" or bool(criteria)
    has_keyword = bool(cleaned)
    has_filters = any(str(value or "").strip() for value in (filters or {}).values())
    param_sets = lostfound_codes.filter_param_sets(filters, _api_date)
    api_keywords: list[str] = []
    reported_totals: dict[str, int] = {}
    pages_scanned = 0
    limit_reached = False
    photo_priority: list[str] = []
    use_codes = bool(param_sets)
    # 지역 텍스트 검사를 건너뛸 수 있는 건 공식 코드로 지역을 실제 좁혔을 때뿐이다.
    # 코드 없는 지역값(구·동 등)은 다른 필터가 코드로 가도 텍스트 검사를 유지한다.
    region_applied = bool(lostfound_codes.region_param(str((filters or {}).get("region") or "")))

    collection = None
    if period_mode:
        period = search_period.resolve_period(filters, hints if has_ai else None, query=cleaned if has_ai else "")
        api_keywords = criteria.get("apiKeywords") or ([cleaned] if cleaned else [])
        preferred = search_period.category_priority((hints or {}).get("itemCategory"), cleaned, api_keywords) if has_ai else {}
        collection = _period_candidates(period, filters, preferred, period_cursor)
        results, errors = collection["bySource"], collection["errors"]
        photo_priority = collection["photoPriority"]
        limit_reached = not collection["coverage"]["complete"]
        pages_scanned = sum(row["pagesRead"] for row in collection["coverage"]["sources"].values())
        use_codes = True
        # 이름 조회는 첫 묶음에서 빠른 텍스트 후보를 보탠다. 날짜 목록은 독립적으로 이어간다.
        if cleaned and not period_cursor:
            named = search_all(cleaned, 1, rows, hints=hints if has_ai else None)
            for item in named["items"]:
                if metadata_pass(item, {**(filters or {}), **period}):
                    results[item["source"]].append(item)
            collection["sources"] = [source for source in SOURCES if source in collection["sources"] or source in named["sources"]]
    elif use_codes:
        results, errors, total_reported, pages_scanned, limit_reached = _browse_filtered(
            param_sets, rows, max_pages, visual_need, page_cache,
        )
        reported_totals["filtered"] = total_reported
    else:
        raw_keywords = criteria.get("apiKeywords") or ([cleaned] if cleaned else [""])
        split_keywords: list[str] = []
        for term in raw_keywords:
            split_keywords.extend(term.split())
        api_keywords = list(dict.fromkeys(split_keywords))[:3] or [""]
        cap = config.LOSTFOUND_MAX_PAGES if max_pages is None else max_pages
        results: dict[str, list[dict]] = {}
        errors: list[dict] = []

        scanned_by_term: dict[str, int] = {}

        def scan_terms(terms: list[str]) -> int:
            per_term = max(1, cap // len(terms)) if cap else 1
            scanned_by_term.update(dict.fromkeys(terms, per_term))
            with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
                futures = {
                    (term, source, number): executor.submit(_browse_page, page_cache, search, source, term, number, rows)
                    for term in terms
                    for number in range(1, per_term + 1)
                    for source in SOURCES
                }
                for (term, source, _number), future in futures.items():
                    try:
                        payload = future.result()
                    except PoliceError as error:
                        if not any(error_item["source"] == source for error_item in errors):
                            errors.append({"source": source, "code": error.code, "message": error.message})
                        continue
                    results.setdefault(source, []).extend(payload["items"])
                    reported_totals[term] = max(reported_totals.get(term, 0), payload["totalCount"])
            return per_term * len(terms)

        # AI 검색은 이름 조회 결과에 최근 공개 목록을 추가해 사진과 설명도 비교한다.
        scan_terms_list = list(dict.fromkeys([*api_keywords, ""])) if has_ai else api_keywords
        pages_scanned = scan_terms(scan_terms_list)
        # 일반 검색의 이름 조회가 빗나가면 최근 공개 설명에서도 입력어를 확인한다.
        if not has_ai and has_keyword and not any(
            _term_matches(cleaned.lower(), _item_text(item))
            for source_items in results.values() for item in source_items
        ):
            pages_scanned += scan_terms([""])
        limit_reached = cap > 0 and any(value > scanned_by_term[term] * rows for term, value in reported_totals.items())

        if search_mode == "ai" and has_keyword and not has_filters:
            # 분실물 찾기와 같은 날짜·품목 목록에서 이름과 별도로 사진을 가져온다.
            with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
                jobs = _recent_photo_pages(executor, [*cleaned.split(), *api_keywords], "", 1, rows, page_cache)
                for (source, _day), future in jobs.items():
                    try:
                        payload = future.result()
                    except PoliceError as error:
                        if not any(entry["source"] == source for entry in errors):
                            errors.append({"source": source, "code": error.code, "message": error.message})
                        continue
                    rows_for_day = payload["items"]
                    results.setdefault(source, []).extend(rows_for_day)
                    photo_priority.extend(item["id"] for item in rows_for_day if item.get("imageUrl"))
                    pages_scanned += 1
                    limit_reached = limit_reached or payload["totalCount"] > rows

    # 사용자가 고른 필터와 일반 검색어만 후보 범위를 결정한다.
    active_signals = has_ai + has_keyword + has_filters
    seen_ids: set[str] = set()
    deduped: dict[str, dict] = {}
    for source in SOURCES:
        for row in results.get(source, []):
            if row["id"] in seen_ids:
                continue
            if has_filters and not metadata_pass(row, filters, skip_region=use_codes and region_applied):
                continue
            keyword_ok = has_keyword and _term_matches(cleaned.lower(), _item_text(row))
            if has_keyword and not has_ai and not keyword_ok:
                continue
            seen_ids.add(row["id"])
            key = _browse_dedupe_key(row)
            if key in deduped:
                continue
            match = score_criteria(row, criteria)
            ai_ok = bool(criteria) and criteria_pass(row, criteria)
            signals = (("AI", ai_ok), ("검색어", keyword_ok), ("조건 필터", has_filters))
            matched = [name for name, ok in signals if ok]
            if active_signals >= 2 and len(matched) == active_signals:
                tier = 0
            elif ai_ok:
                tier = 1
            elif keyword_ok:
                tier = 2
            elif has_filters:
                tier = 3
            elif match["hits"] and not match["excluded"]:
                tier = 4
            else:
                tier = 5
            row["matchTier"] = tier
            row["matchLabel"] = "+".join(matched) + " 일치" if tier == 0 else MATCH_TIERS[tier]
            row["matchScore"] = _score(row, cleaned)
            row["aiMatch"] = {"hits": match["hits"], "allInclude": match["allInclude"]}
            deduped[key] = row
    items = sorted(deduped.values(), key=lambda row: (row["foundDate"], row["id"]), reverse=True)
    # 같은 등급 안에서도 제목·본문에 맞은 말이 많은 물건부터 보여준다.
    # 사진 점수는 텍스트 신호×10과 합산해 텍스트 우선 순위를 유지한다(최종 정렬도 같은 규칙).
    items.sort(key=lambda row: (
        row["matchTier"], -text_signal_score(row, criteria, cleaned),
    ))
    total = len(items)
    start = max(0, (page - 1) * rows)
    return {
        "query": cleaned,
        "apiKeywords": api_keywords,
        "sources": collection["sources"] if collection is not None else [source for source in SOURCES if source in results],
        "total": total,
        "items": items[start:start + rows],
        # 사진 분석은 페이지에 잘려 나간 항목도 봐야 하므로 전체 후보를 함께 넘긴다.
        # 응답 모델에서는 제외되고, 서버 안에서만 재정렬·재페이지네이션에 쓴다.
        "allItems": items,
        "photoPriority": list(dict.fromkeys(photo_priority)),
        "errors": errors,
        "page": page,
        "rows": rows,
        "scanned": sum(len(rows_for_source) for rows_for_source in results.values()),
        "pagesScanned": pages_scanned,
        "scanLimitReached": limit_reached,
        "filterApi": use_codes,
        "criteriaApplied": bool(criteria),
        "filtersApplied": {key: str(value) for key, value in (filters or {}).items() if str(value or "").strip()},
        **({key: collection[key] for key in ("coverage", "periodCursor", "hasMore")} if collection is not None else {}),
    }


def _photo_params(terms: list[str], category_hint: str) -> dict[str, str]:
    # 원문 품목을 우선한다. 어느 쪽이든 별도 조회에만 사용한다.
    for term in [*terms, category_hint]:
        params = lostfound_codes.category_params(term)
        if params:
            return params
    return {}


def _recent_photo_pages(
    executor: ThreadPoolExecutor, terms: list[str], category_hint: str, page: int, rows: int,
    page_cache: dict[str, dict] | None = None,
) -> dict[tuple[str, str], Future[dict]]:
    category = _photo_params(terms, category_hint)
    today = datetime.now(timezone(timedelta(hours=9))).date()
    days = [(today - timedelta(days=offset)).strftime("%Y%m%d") for offset in range(PHOTO_SEARCH_RECENT_DAYS)]
    return {
        (source, day): executor.submit(
            _browse_page, page_cache, search_filtered, source, {**category, "START_YMD": day, "END_YMD": day}, page, rows,
        )
        for source in SOURCES for day in days
    }


def search_all(
    keyword: str, page: int = 1, rows: int = 20, allow_empty: bool = False, hints: dict | None = None,
    *, original_query: str = "", photo_search: bool = False, photo_category: str = "",
) -> dict:
    cleaned = _keyword(keyword)
    original = _keyword(original_query)
    if not cleaned and not original and not (allow_empty or photo_search):
        raise PoliceError("lostfound_invalid_query", "검색할 물품명을 입력해 주세요.")
    criteria = _normalize_criteria(hints)
    ai_terms = [word for term in criteria.get("apiKeywords", []) for word in term.split()]
    name_terms = ai_terms or cleaned.split()
    # 원문 단서와 AI가 찾은 탐색어를 모두 이름 조회에 사용한다.
    api_keywords = list(dict.fromkeys([*original.split()[:2], *name_terms]))[:3]
    if not api_keywords and not photo_search:
        api_keywords = [""]

    results: dict[str, list[dict]] = {}
    photo_results: dict[str, dict] = {}
    context_results: dict[str, dict] = {}
    available_sources: set[str] = set()
    errors: list[dict] = []
    totals: dict[str, int] = {}
    has_more = False
    with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
        futures = {
            (False, term, source): executor.submit(search, source, term, page, rows)
            for term in api_keywords
            for source in SOURCES
        }
        if photo_search:
            recent = _recent_photo_pages(executor, original.split() + cleaned.split() + ai_terms, photo_category, page, rows)
            for source in SOURCES:
                for (recent_source, day), job in recent.items():
                    if recent_source == source:
                        futures[True, day, source] = job
                # 최신 일자와 함께 전체 공개 목록도 이어서 볼 수 있다.
                futures[True, "", source] = executor.submit(search, source, "", page, rows)
        for (is_photo, term, source), future in futures.items():
            try:
                payload = future.result()
            except PoliceError as error:
                if not any(error_item["source"] == source for error_item in errors):
                    errors.append({"source": source, "code": error.code, "message": error.message})
                continue
            available_sources.add(source)
            if is_photo:
                for item in payload["items"]:
                    if item.get("imageUrl"):
                        photo_results.setdefault(item["id"], item)
                    # 설명이 구체적인 항목은 사진이 없어도 맥락 후보에 들어간다.
                    literal = (original or cleaned).lower()
                    if _term_matches(literal, _item_text(item)) or score_criteria(item, criteria)["hits"]:
                        context_results.setdefault(item["id"], item)
            else:
                results.setdefault(source, []).extend(payload["items"])
                totals[term] = max(totals.get(term, 0), payload["totalCount"])
            # Each source and term paginates independently. The merged item count can
            # exceed an individual source's total even when it has more pages.
            has_more = has_more or page * rows < payload["totalCount"]

    merged: dict[str, dict] = {}
    for source in SOURCES:
        for item in results.get(source, []):
            merged.setdefault(item["id"], item)
    items = []
    for item in merged.values():
        match = score_criteria(item, criteria)
        base_score = _score(item, cleaned)
        item["matchScore"] = round(base_score + (0 if match["excluded"] else match["score"]), 2)
        item["aiMatch"] = {
            "hits": [] if match["excluded"] else match["hits"],
            "allInclude": bool(not match["excluded"] and match["allInclude"]),
        }
        items.append(item)
    items.sort(key=lambda item: item["id"])
    items.sort(key=lambda item: item["foundDate"], reverse=True)
    items.sort(key=lambda item: item["matchScore"], reverse=True)
    return {
        "query": cleaned,
        "apiKeywords": api_keywords,
        "matched": sum(1 for item in items if item["aiMatch"]["hits"]),
        "sources": [source for source in SOURCES if source in available_sources],
        "total": max(totals.values()) if totals else 0,
        "hasMore": has_more and page < config.LOSTFOUND_SEARCH_MAX_PAGES,
        "scanLimitReached": has_more and page >= config.LOSTFOUND_SEARCH_MAX_PAGES,
        "items": items,
        "photoItems": list(photo_results.values()),
        "contextItems": [item for item_id, item in context_results.items() if item_id not in merged],
        "errors": errors,
    }


def search_in_period(
    keyword: str, page: int, rows: int, hints: dict | None, cursor: dict | None,
    *, original_query: str, photo_category: str, filters: dict | None,
) -> dict:
    criteria = _normalize_criteria(hints)
    query = original_query or keyword
    period = search_period.resolve_period(filters, hints, query=query)
    keywords = criteria.get("apiKeywords", [])
    preferred = search_period.category_priority(photo_category, query, keywords)
    collected = _period_candidates(period, filters, preferred, cursor)
    named = search_all(keyword or original_query, page, rows, hints=hints) if query else {}
    lexical = [item for item in named.get("items", []) if metadata_pass(item, period)]
    lexical_ids = {item["id"] for item in lexical}
    pool = {item["id"]: item for rows in collected["bySource"].values() for item in rows}
    priority = set(collected["photoPriority"])
    ordered = sorted(pool.values(), key=lambda item: (
        item["id"] in priority,
        text_signal_score(item, criteria, query),
        item["foundDate"],
    ), reverse=True)
    photos = order_period_photos(ordered, collected["photoPriority"], criteria, query)
    context = [
        item for item in ordered if item["id"] not in lexical_ids
        and (text_signal_score(item, criteria, query) > 0 or score_criteria(item, criteria)["hits"])
    ]
    # 이름이나 코드 분류가 빗나가도 설명이 풍부하면 비교 후보로 보탠다.
    context_ids = {item["id"] for item in context} | lexical_ids
    extra_context = [item for item in ordered if item["id"] not in context_ids and item.get("notes")]
    context.extend(extra_context[:rows])
    errors = collected["errors"]
    return {
        "query": keyword, "apiKeywords": named.get("apiKeywords", []), "matched": named.get("matched", 0),
        "sources": [source for source in SOURCES if source in collected["sources"] or source in named.get("sources", [])],
        "items": lexical, "photoItems": photos, "contextItems": context, "errors": errors,
        "total": len(lexical) + len(context), "hasMore": collected["hasMore"],
        "scanLimitReached": not collected["coverage"]["complete"],
        "coverage": collected["coverage"], "periodCursor": collected["periodCursor"],
    }


def detail(source: str, atc_id: str, fd_sn: str) -> dict:
    if source not in DETAIL_PATHS:
        raise PoliceError("lostfound_invalid_source", "유실물 검색 대상을 확인해 주세요.")
    if not ATC_ID_PATTERN.fullmatch(atc_id):
        raise PoliceError("lostfound_invalid_id", "관리번호를 확인해 주세요.")
    if not re.fullmatch(r"\d{1,3}", fd_sn) or not 1 <= int(fd_sn) <= 999:
        raise PoliceError("lostfound_invalid_id", "습득순번을 확인해 주세요.")
    root = _request(
        DETAIL_PATHS[source],
        {"ATC_ID": atc_id, "FD_SN": fd_sn},
    )
    nodes = list(root.iter("item"))
    if not nodes:
        raise PoliceError("lostfound_not_found", "해당 습득물 정보를 찾지 못했어요.")
    row = _normalize(source, nodes[0])
    row["detailLoaded"] = True
    return row

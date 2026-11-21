from __future__ import annotations

import html
import logging
import math
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import httpx

from . import config, lostfound_codes

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
CRITERIA_LIMITS = {"apiKeywords": 3, "include": 8, "any": 8, "exclude": 8, "imageFeatures": 8}


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


def _term_matches(term: str, text: str) -> bool:
    if not term or not text:
        return False
    if term in text:
        return True
    tokens = term.split()
    return len(tokens) > 1 and all(token in text for token in tokens)


def score_criteria(item: dict, criteria: dict[str, list[str]]) -> dict:
    """공개 API 항목의 전체 텍스트에 AND/OR/NOT과 사진 특징을 적용한다.

    include/any/imageFeatures는 관련도 점수로 반영하고, exclude는 명시적 NOT이므로 제외한다.
    조건이 없으면 원래 공개 API 순서를 유지한다.
    """
    result = {"score": 0.0, "hits": [], "allInclude": False, "excluded": None}
    if not criteria:
        return result
    text = _item_text(item)
    include = criteria.get("include", [])
    varied = criteria.get("any", []) + criteria.get("imageFeatures", [])
    result["excluded"] = next((term for term in criteria.get("exclude", []) if _term_matches(term, text)), None)
    include_hits = [term for term in include if _term_matches(term, text)]
    varied_hits = [term for term in varied if _term_matches(term, text)]
    result["allInclude"] = bool(include) and len(include_hits) == len(include)
    result["hits"] = include_hits + varied_hits
    weight = len(include) * 3 + len(varied)
    if weight:
        result["score"] = round((len(include_hits) * 3 + len(varied_hits)) / weight * 90 + (10 if result["allInclude"] else 0), 2)
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


def _keyword_item_match(item: dict, keyword: str) -> bool:
    """전용 필터 API에는 PRDT_NM이 없으므로 물품명·내용·분류로 로컬 매칭한다."""
    if not keyword:
        return True
    text = " ".join(str(item.get(field) or "") for field in ("name", "subject", "category")).lower()
    return _term_matches(keyword.lower(), text)


def criteria_pass(item: dict, criteria: dict[str, list[str]]) -> bool:
    """AI 조건을 점수가 아닌 하드 필터로 적용한다(직접 찾기는 순위를 재정렬하지 않는다)."""
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


def _browse_dedupe_key(item: dict) -> str:
    """프론트 dedupeLostFound와 같은 기준으로 같은 물건 후보를 한 번만 센다."""
    def clean(value: object) -> str:
        return re.sub(r"\s+", " ", str(value or "").strip()).lower()

    fields = (
        item.get("name"), item.get("color"), item.get("category"), item.get("foundDate"),
        item.get("storagePlace") or item.get("orgName"),
    )
    return "|".join(clean(value) for value in fields)


def _browse_filtered(
    param_sets: list[dict[str, str]],
    cleaned: str,
    page: int,
    rows: int,
    max_pages: int | None,
) -> tuple[dict[str, list[dict]], list[dict], int, bool]:
    """전용 필터 API로 서버에서 좁힌 뒤, 필요할 때만 다음 페이지를 읽는다."""
    results: dict[str, list[dict]] = {}
    errors: list[dict] = []
    total_reported = 0
    pages_scanned = 0
    limit_reached = False
    needed = page * rows
    cap = config.LOSTFOUND_MAX_PAGES if max_pages is None else max_pages

    for params in param_sets:
        first: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
            futures = {source: executor.submit(search_filtered, source, params, 1, rows) for source in SOURCES}
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
                    (source, page_number): executor.submit(search_filtered, source, params, page_number, rows)
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
            if not cleaned or sum(len(rows_for_source) for rows_for_source in results.values()) >= needed:
                break
    return results, errors, total_reported, pages_scanned, limit_reached


def browse_all(
    keyword: str,
    page: int = 1,
    rows: int = 20,
    filters: dict | None = None,
    hints: dict | None = None,
    max_pages: int | None = None,
) -> dict:
    """직접 찾기용: 필터가 있으면 전용 API로, 없으면 이름 검색으로 여러 페이지를 스캔한다."""
    cleaned = _keyword(keyword)
    criteria = _normalize_criteria(hints)
    param_sets = lostfound_codes.filter_param_sets(filters, _api_date)
    api_keywords: list[str] = []
    reported_totals: dict[str, int] = {}
    pages_scanned = 0
    limit_reached = False
    use_codes = bool(param_sets)

    if use_codes:
        results, errors, total_reported, pages_scanned, limit_reached = _browse_filtered(param_sets, cleaned, page, rows, max_pages)
        reported_totals["filtered"] = total_reported
    else:
        api_keywords = (criteria.get("apiKeywords") or ([cleaned] if cleaned else [""]))[:3]
        cap = config.LOSTFOUND_MAX_PAGES if max_pages is None else max_pages
        pages_per_term = max(1, cap // len(api_keywords)) if cap else 1
        results: dict[str, list[dict]] = {}
        errors: list[dict] = []
        with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
            futures = {
                (term, source, number): executor.submit(search, source, term, number, rows)
                for term in api_keywords
                for number in range(1, pages_per_term + 1)
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
        pages_scanned = pages_per_term * len(api_keywords)
        limit_reached = cap > 0 and any(value > pages_per_term * rows for value in reported_totals.values())

    merged: dict[str, dict] = {}
    deduped: dict[str, dict] = {}
    for source in SOURCES:
        for row in results.get(source, []):
            if row["id"] in merged:
                continue
            if not metadata_pass(row, filters, skip_region=use_codes):
                continue
            if use_codes and not _keyword_item_match(row, cleaned):
                continue
            if not criteria_pass(row, criteria):
                continue
            merged[row["id"]] = row
            key = _browse_dedupe_key(row)
            if key in deduped:
                continue
            match = score_criteria(row, criteria)
            row["matchScore"] = _score(row, cleaned)
            row["aiMatch"] = {"hits": match["hits"], "allInclude": match["allInclude"]}
            deduped[key] = row
    # AI 점수로 정렬하지 않는다. 공개 API의 최신순/ID순만 유지한다.
    items = sorted(deduped.values(), key=lambda row: (row["foundDate"], row["id"]), reverse=True)
    total = len(items)
    start = max(0, (page - 1) * rows)
    return {
        "query": cleaned,
        "apiKeywords": api_keywords,
        "sources": [source for source in SOURCES if source in results],
        "total": total,
        "items": items[start:start + rows],
        "errors": errors,
        "page": page,
        "rows": rows,
        "scanned": sum(len(rows_for_source) for rows_for_source in results.values()),
        "pagesScanned": pages_scanned,
        "scanLimitReached": limit_reached,
        "filterApi": use_codes,
        "criteriaApplied": bool(criteria),
        "filtersApplied": {key: str(value) for key, value in (filters or {}).items() if str(value or "").strip()},
    }


def search_all(keyword: str, page: int = 1, rows: int = 20, allow_empty: bool = False, hints: dict | None = None) -> dict:
    cleaned = _keyword(keyword)
    if not cleaned and not allow_empty:
        raise PoliceError("lostfound_invalid_query", "검색할 물품명을 입력해 주세요.")
    criteria = _normalize_criteria(hints)
    # 자연어 문장 전체를 PRDT_NM에 넣으면 0건이므로 AI가 분리한 핵심 명사로 넓게 가져온 뒤 JSON으로 좁힌다.
    api_keywords = (criteria.get("apiKeywords") or ([cleaned] if cleaned else [""]))[:3]

    results: dict[str, list[dict]] = {}
    errors: list[dict] = []
    totals: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=config.BROWSE_MAX_WORKERS) as executor:
        futures = {
            (term, source): executor.submit(search, source, term, page, rows)
            for term in api_keywords
            for source in SOURCES
        }
        for (term, source), future in futures.items():
            try:
                payload = future.result()
            except PoliceError as error:
                if not any(error_item["source"] == source for error_item in errors):
                    errors.append({"source": source, "code": error.code, "message": error.message})
                continue
            results.setdefault(source, []).extend(payload["items"])
            totals[term] = max(totals.get(term, 0), payload["totalCount"])

    merged: dict[str, dict] = {}
    for source in SOURCES:
        for item in results.get(source, []):
            merged.setdefault(item["id"], item)
    items = []
    for item in merged.values():
        match = score_criteria(item, criteria)
        if match["excluded"]:
            continue
        base_score = _score(item, cleaned)
        item["matchScore"] = round(base_score + match["score"], 2)
        item["aiMatch"] = {"hits": match["hits"], "allInclude": match["allInclude"]}
        items.append(item)
    items.sort(key=lambda item: item["id"])
    items.sort(key=lambda item: item["foundDate"], reverse=True)
    items.sort(key=lambda item: item["matchScore"], reverse=True)
    return {
        "query": cleaned,
        "apiKeywords": api_keywords,
        "matched": sum(1 for item in items if item["aiMatch"]["hits"]),
        "sources": [source for source in SOURCES if source in results],
        "total": max(totals.values()) if totals else 0,
        "items": items,
        "errors": errors,
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

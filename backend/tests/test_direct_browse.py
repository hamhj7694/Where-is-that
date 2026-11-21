from __future__ import annotations

from app import police_api


def row(identifier: str, date: str, **overrides) -> dict:
    item = {
        "id": identifier,
        "source": "police",
        "atcId": identifier,
        "fdSn": "1",
        "name": "지갑",
        "subject": "가죽 지갑",
        "category": "지갑 > 남성용 지갑",
        "color": "블랙(검정)",
        "imageUrl": None,
        "foundDate": date,
        "foundTime": "",
        "foundPlace": "서울",
        "storagePlace": "서울경찰서",
        "orgId": "O1",
        "orgName": "서울경찰서",
        "tel": "",
        "status": "보관중",
        "keepType": "관서보관",
        "notes": "특이사항",
        "address": "서울특별시",
        "detailLoaded": False,
    }
    item.update(overrides)
    return item


def test_browse_filters_whole_pool_and_recalculates_total(monkeypatch):
    pages = {
        1: [row("police:a", "2026-01-03", color="사용자정의색", matchScore=99.0)],
        2: [row("police:b", "2026-01-02", color="사용자정의색")],
        3: [row("police:c", "2026-01-01", color="사용자정의색")],
    }
    seen_pages: list[int] = []

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        seen_pages.append(page)
        return {"items": pages.get(page, []), "totalCount": 3000}

    monkeypatch.setattr(police_api, "search", fake_search)
    # 코드표에 없는 색상값은 전용 API 대신 이름 검색 + 텍스트 필터 폴백을 탄다.
    result = police_api.browse_all("", 2, 1, filters={"color": "사용자정의색"}, max_pages=3)

    assert sorted(set(seen_pages)) == [1, 2, 3]  # 현재 페이지가 아니라 전체 풀을 스캔(두 소스)
    assert result["total"] == 3  # API total(3000)이 아니라 필터 통과 건수
    assert [item["id"] for item in result["items"]] == ["police:b"]  # page 2
    assert result["filtersApplied"] == {"color": "사용자정의색"}
    assert result["filterApi"] is False
    assert result["scanned"] == 6  # 두 공개 소스 모두 스캔


def test_browse_keeps_public_api_order_without_ai_ranking(monkeypatch):
    page_rows = [
        row("police:old", "2026-01-01", matchScore=100.0),
        row("police:new", "2026-01-05", matchScore=0.1),
    ]

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": page_rows if page == 1 else [], "totalCount": 2}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, max_pages=1)

    assert [item["id"] for item in result["items"]] == ["police:new", "police:old"]


def test_browse_counts_same_item_once_before_pagination(monkeypatch):
    first = row("police:first", "2026-02-10")
    duplicate = row("portal:second", "2026-02-10", id="portal:second")

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [first, duplicate], "totalCount": 2}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, max_pages=1)

    assert result["total"] == 1
    assert [item["id"] for item in result["items"]] == ["police:first"]


def test_browse_applies_ai_criteria_across_pages_and_dedupes(monkeypatch):
    page_rows = {
        1: [
            row("police:keep", "2026-02-01", notes="가죽 지갑"),
            row("police:broken", "2026-02-02", notes="가죽 지갑 파손"),
        ],
        2: [row("police:keep", "2026-02-01", notes="가죽 지갑")],
    }

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": page_rows.get(page, []), "totalCount": 50}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all(
        "검은 가죽 지갑", 1, 10,
        hints={"apiKeywords": ["지갑"], "include": ["가죽"], "exclude": ["파손"]},
        max_pages=2,
    )

    assert result["criteriaApplied"] is True
    assert result["apiKeywords"] == ["지갑"]
    assert [item["id"] for item in result["items"]] == ["police:keep"]
    assert result["total"] == 1
    assert result["items"][0]["aiMatch"]["hits"] == ["가죽"]


def test_browse_unmatched_ai_condition_filters_out_item(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [row("police:item", "2026-03-01")] if page == 1 else [], "totalCount": 1}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, hints={"include": ["없는단어"]}, max_pages=1)

    # 직접 찾기는 AI 조건을 하드 필터로 적용하되 순위는 바꾸지 않는다.
    assert result["criteriaApplied"] is True
    assert result["total"] == 0
    assert result["items"] == []


def test_browse_uses_official_codes_and_reads_all_filtered_pages(monkeypatch):
    seen: list[tuple[str, dict, int]] = []

    def fake_search_filtered(source: str, params: dict, page: int = 1, rows: int = 20) -> dict:
        seen.append((source, dict(params), page))
        return {
            "items": [row(f"{source}:{page}", "2026-04-01", region="")] if page <= 3 else [],
            "totalCount": 3,
        }

    monkeypatch.setattr(police_api, "search_filtered", fake_search_filtered)
    result = police_api.browse_all(
        "지갑", 1, 10,
        filters={"category": "지갑 > 남성용 지갑", "region": "서울", "from": "2026-01-01"},
        max_pages=3,
    )

    assert result["filterApi"] is True
    assert seen
    assert seen[0][1]["PRDT_CL_CD_01"] == "PRH000"
    assert seen[0][1]["PRDT_CL_CD_02"] == "PRH200"
    assert seen[0][1]["N_FD_LCT_CD"] == "LCA000"
    assert seen[0][1]["START_YMD"] == "20260101"
    assert {page for _source, _params, page in seen} <= {1, 2, 3}
    assert result["total"] >= 1


def test_browse_keeps_text_region_check_when_region_has_no_official_code(monkeypatch):
    def fake_search_filtered(source: str, params: dict, page: int = 1, rows: int = 20) -> dict:
        assert "N_FD_LCT_CD" not in params
        return {"items": [row(f"{source}:{page}", "2026-04-01", region="")], "totalCount": 1}

    monkeypatch.setattr(police_api, "search_filtered", fake_search_filtered)
    result = police_api.browse_all(
        "지갑", 1, 10,
        filters={"category": "지갑 > 남성용 지갑", "region": "강남구"},
        max_pages=1,
    )

    # 분류는 코드로 좁혀졌지만 지역은 코드가 없으므로 텍스트 검사를 유지해야 한다.
    assert result["filterApi"] is True
    assert result["total"] == 0


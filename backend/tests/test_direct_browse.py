from __future__ import annotations

from types import SimpleNamespace

from app import ai_pipeline, main, police_api


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


def test_masked_name_matches_a_filled_in_query():
    # 공개 API가 '류*진'으로 가려도 사용자가 '류영진'·'류세진'을 쳐서 찾을 수 있다.
    assert police_api._term_matches("류영진", "이름 류*진 입니다")
    assert police_api._term_matches("류세진", "이름 류*진 입니다")
    assert police_api._term_matches("류*진", "이름 류영진 입니다")
    assert not police_api._term_matches("김영진", "이름 류*진 입니다")


def test_browse_scans_broad_when_keyword_returns_nothing(monkeypatch):
    hidden = row("police:hidden", "2026-11-22", name="류*진", subject="가죽 지갑")

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [hidden] if not keyword else [], "totalCount": 1 if not keyword else 0}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("류영진", 1, 10, max_pages=2)
    assert [item["id"] for item in result["items"]] == ["police:hidden"]
    assert result["items"][0]["matchTier"] == 2  # 가려진 이름이라도 검색어 일치로 올라온다


def test_visual_hints_boost_a_photo_item_outside_the_current_page(monkeypatch):
    payload = SimpleNamespace(
        keyword="치이카와", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
    )
    plain = row("police:plain", "2026-11-23")
    card = row("police:card", "2026-11-22", imageUrl="https://www.lost112.go.kr/a.jpg", name="신한카드")
    result = {"items": [plain], "allItems": [plain, card], "total": 2}

    def fake_match(request):
        assert request.externalProcessingConfirmed is True
        return SimpleNamespace(results=[
            SimpleNamespace(id="police:card", imageSimilarity=90, basis="photo"),
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    updated = main._apply_visual_hints(result, payload)
    assert updated["items"][0]["id"] == "police:card"
    assert updated["items"][0]["matchTier"] == 1  # 사진만 맞으면 텍스트 일치 바로 아래
    assert updated["items"][0]["visualScore"] == 90
    assert updated["visualAnalyzed"] is True


def test_visual_scan_starts_with_newest_and_stops_when_confident(monkeypatch):
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
    )
    items = [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(1, 11)
    ]
    items[9]["foundDate"] = "2026-11-22"  # 가장 최신 항목을 맨 뒤에 둔다.
    result = {"items": [items[0]], "allItems": items, "total": 10}
    batches: list[list[str]] = []

    def fake_match(request):
        batches.append([candidate.id for candidate in request.candidates])
        return SimpleNamespace(results=[
            SimpleNamespace(id=candidate.id, imageSimilarity=95, basis="photo")
            for candidate in request.candidates
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    main._apply_visual_hints(result, payload)
    assert len(batches) == 1  # 90점 이상이 나오면 더 오래된 묶음은 보지 않는다.
    assert batches[0][0] == "police:10"
    assert batches[0] == [f"police:{index}" for index in range(10, 2, -1)]


def test_visual_match_at_50_counts_without_stopping_older_photos(monkeypatch):
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
    )
    items = [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(1, 13)
    ]
    result = {"items": [items[0]], "allItems": items, "total": 12}
    batches: list[list[str]] = []

    def fake_match(request):
        batches.append([candidate.id for candidate in request.candidates])
        return SimpleNamespace(results=[
            SimpleNamespace(id=candidate.id, imageSimilarity=50, basis="photo")
            for candidate in request.candidates
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    main._apply_visual_hints(result, payload)
    assert len(batches) == 2  # 50점 하나로 멈추지 않고 오래된 묶음까지 본다.
    assert result["visualScanned"] == 12
    assert result["visualMore"] is False
    assert result["items"][0]["matchTier"] == 1  # 50점도 사진 특징 일치로 인정.


def test_look_deeper_skips_seen_photos_and_reports_remaining(monkeypatch):
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1, skipVisual=8,
    )
    items = [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(1, 81)
    ]
    result = {"items": [items[0]], "allItems": items, "total": 80}
    batches: list[list[str]] = []

    def fake_match(request):
        batches.append([candidate.id for candidate in request.candidates])
        return SimpleNamespace(results=[])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    main._apply_visual_hints(result, payload)
    assert batches[0][0] == "police:72"  # 최신 8장을 건너뛰고 그 다음부터 본다.
    assert result["visualScanned"] == 60
    assert result["visualMore"] is True  # 아직 더 오래된 사진이 남았다.


def test_deeper_search_keeps_the_score_found_earlier(monkeypatch):
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=3,
        skipVisual=8, priorVisualScores={"police:old": 96},
    )
    old = row("police:old", "2026-01-01", imageUrl="https://www.lost112.go.kr/a.jpg")
    items = [old] + [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(2, 21)
    ]
    result = {"items": [items[0]], "allItems": items, "total": 20}
    monkeypatch.setattr(
        ai_pipeline, "match_visual_features",
        lambda request: SimpleNamespace(results=[]),
    )
    main._apply_visual_hints(result, payload)
    assert result["items"][0]["id"] == "police:old"  # 앞서 찾은 사진이 맨 위에 남는다.
    assert result["items"][0]["visualScore"] == 96
    assert result["items"][0]["matchTier"] == 1


def test_title_match_outranks_photo_only_match(monkeypatch):
    """사진만 맞은 카드가 제목에 '치이카와'가 적힌 물건보다 위에 오면 안 된다."""
    payload = SimpleNamespace(
        keyword="치이카와",
        hints={
            "apiKeywords": ["치이카와"], "include": ["치이카와"],
            "any": [], "exclude": [], "imageFeatures": ["치이카와"],
        },
        page=1, rows=2,
    )
    exact = row(
        "portal:exact", "2026-11-16", name="신한카드 치이카와",
        matchTier=0, matchLabel="AI+검색어 일치",
    )
    photo = row(
        "police:photo", "2026-11-22", name="신한카드",
        imageUrl="https://www.lost112.go.kr/a.jpg",
        matchTier=5, matchLabel="공개 원문",
    )
    result = {"items": [photo, exact], "allItems": [photo, exact], "total": 2}
    monkeypatch.setattr(
        ai_pipeline, "match_visual_features",
        lambda request: SimpleNamespace(results=[
            SimpleNamespace(id="police:photo", imageSimilarity=96, basis="photo"),
        ]),
    )
    updated = main._apply_visual_hints(result, payload)
    assert [item["id"] for item in updated["items"]] == ["portal:exact", "police:photo"]
    assert updated["items"][0]["matchTier"] == 0
    assert updated["items"][1]["matchTier"] == 1
    assert updated["items"][1]["visualScore"] == 96


def test_more_title_terms_rank_first_within_same_tier(monkeypatch):
    """'치이카와 카드'는 두 말이 다 맞은 제목이 한 말만 맞은 제목보다 앞이다."""
    payload = SimpleNamespace(
        keyword="치이카와 카드",
        hints={"include": ["치이카와", "카드"], "imageFeatures": ["치이카와", "카드"]},
        page=1, rows=3,
    )
    both = row("portal:both", "2026-11-16", name="신한카드 치이카와", matchTier=0)
    one = row("portal:one", "2026-11-20", name="치이카와 목도리", matchTier=0)
    photo = row(
        "police:photo", "2026-11-22", name="신한카드",
        imageUrl="https://www.lost112.go.kr/a.jpg", matchTier=5,
    )
    result = {"items": [one, both, photo], "allItems": [one, both, photo], "total": 3}
    monkeypatch.setattr(
        ai_pipeline, "match_visual_features",
        lambda request: SimpleNamespace(results=[]),
    )
    updated = main._apply_visual_hints(result, payload)
    assert [item["id"] for item in updated["items"]] == ["portal:both", "portal:one", "police:photo"]


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


def test_browse_shows_unmatched_item_as_public_tier(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [row("police:item", "2026-03-01")] if page == 1 else [], "totalCount": 1}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, hints={"include": ["없는단어"]}, max_pages=1)

    # 조건에 안 맞아도 화면을 비우지 않고 공개 원문 등급으로 표시한다.
    assert result["criteriaApplied"] is True
    assert result["total"] == 1
    assert result["items"][0]["matchTier"] == 5
    assert result["items"][0]["matchLabel"] == "공개 원문"


def test_browse_keeps_exclude_even_when_showing_all_tiers(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {
            "items": [
                row("police:drop", "2026-03-02", notes="가죽 지갑 파손"),
                row("police:keep", "2026-03-01", notes="가죽 지갑"),
            ] if page == 1 else [],
            "totalCount": 2,
        }

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, hints={"include": ["없는단어"], "exclude": ["파손"]}, max_pages=1)

    assert [item["id"] for item in result["items"]] == ["police:keep"]


def test_browse_orders_by_match_tier_and_keeps_public_order_in_tier(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {
            "items": [
                row("police:public", "2026-03-05", notes="아무 글이나"),
                row("police:partial", "2026-03-04", notes="코발트 지갑"),
                row("police:keyword", "2026-03-03", notes="검은 가죽 지갑"),
                row("police:ai", "2026-03-02", notes="한정판 코발트 물건"),
                row("police:all", "2026-03-01", notes="한정판 검은 가죽 지갑 코발트"),
            ] if page == 1 else [],
            "totalCount": 5,
        }

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all(
        "검은 가죽 지갑", 1, 10,
        hints={"include": ["한정판"], "any": ["코발트"]},
        max_pages=1,
    )

    # 전부 표시하되 등급 순서: 모두 일치 → AI 조건 → 검색어 → 부분 일치 → 공개 원문
    assert [item["id"] for item in result["items"]] == [
        "police:all", "police:ai", "police:keyword", "police:partial", "police:public",
    ]
    assert [item["matchTier"] for item in result["items"]] == [0, 1, 2, 4, 5]


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

    # 분류는 코드로 좁혀졌지만 지역은 코드가 없으므로 텍스트 검사 결과가 등급에 반영된다.
    assert result["filterApi"] is True
    assert result["total"] == 1
    assert result["items"][0]["matchTier"] == 2  # 지역 불일치 → 조건 필터 등급이 아님


def test_filtered_browse_reads_enough_pages_for_the_visual_pool(monkeypatch):
    seen: list[int] = []

    def fake_search_filtered(source: str, params: dict, page: int = 1, rows: int = 20) -> dict:
        seen.append(page)
        return {
            "items": [row(f"{source}:{page}", "2026-04-01")] if page <= 8 else [],
            "totalCount": 3000,
        }

    monkeypatch.setattr(police_api, "search_filtered", fake_search_filtered)
    # 한 페이지만 필요한 요청이라도 사진 60장을 볼 만큼(4페이지×10건)은 읽어야 한다.
    police_api.browse_all(
        "지갑", 1, 10,
        filters={"category": "지갑 > 남성용 지갑"},
        max_pages=4, visual_need=40,
    )
    assert max(seen) >= 4


def test_prior_visual_scores_survive_when_ai_features_are_missing():
    old = row("police:old", "2026-01-01", imageUrl="https://www.lost112.go.kr/a.jpg")
    result = {"items": [old], "allItems": [old], "total": 1}
    payload = SimpleNamespace(
        keyword="카드", hints={}, page=1, rows=1, skipVisual=0,
        priorVisualScores={"police:old": 96},
    )
    updated = main._apply_visual_hints(result, payload)
    assert updated["items"][0]["visualScore"] == 96
    assert updated["items"][0]["matchTier"] == 1
    assert updated["visualScores"] == {"police:old": 96}


def test_same_result_is_not_scanned_twice(monkeypatch):
    items = [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(1, 11)
    ]
    result = {"items": [items[0]], "allItems": items, "total": 10}
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
        skipVisual=0, priorVisualScores={},
    )
    batches: list[list[str]] = []

    def fake_match(request):
        batches.append([candidate.id for candidate in request.candidates])
        return SimpleNamespace(results=[
            SimpleNamespace(id=candidate.id, imageSimilarity=95, basis="photo")
            for candidate in request.candidates
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    main._apply_visual_hints(result, payload)
    main._apply_visual_hints(result, payload)
    assert len(batches) == 1


def test_failed_visual_batch_is_not_counted_as_scanned(monkeypatch):
    items = [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(1, 13)
    ]
    result = {"items": [items[0]], "allItems": items, "total": 12}
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
        skipVisual=0, priorVisualScores={},
    )

    def fail_match(_request):
        raise RuntimeError("AI unavailable")

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fail_match)
    updated = main._apply_visual_hints(result, payload)
    assert updated["visualScanned"] == 0
    assert updated["visualAnalyzed"] is False
    assert updated["visualMore"] is True


def test_prior_high_score_does_not_stop_the_next_deeper_scan(monkeypatch):
    items = [
        row(f"police:{index:03d}", f"2026-01-{index % 28 + 1:02d}", imageUrl="https://www.lost112.go.kr/a.jpg")
        for index in range(1, 81)
    ]
    result = {"items": [items[0]], "allItems": items, "total": 80}
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
        skipVisual=60, priorVisualScores={"police:001": 96},
    )
    batches: list[int] = []

    def fake_match(request):
        batches.append(len(request.candidates))
        return SimpleNamespace(results=[])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    updated = main._apply_visual_hints(result, payload)
    assert len(batches) > 1  # 이전 점수 때문에 첫 묶음에서 멈추지 않는다.
    assert updated["items"][0]["visualScore"] == 96


def test_weak_photo_score_is_kept_without_promoting_the_tier(monkeypatch):
    item = row("police:weak", "2026-01-01", imageUrl="https://www.lost112.go.kr/a.jpg", matchTier=5)
    result = {"items": [item], "allItems": [item], "total": 1}
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
        skipVisual=0, priorVisualScores={},
    )
    monkeypatch.setattr(
        ai_pipeline, "match_visual_features",
        lambda request: SimpleNamespace(results=[
            SimpleNamespace(id="police:weak", imageSimilarity=45, basis="photo"),
        ]),
    )
    updated = main._apply_visual_hints(result, payload)
    assert updated["items"][0]["visualScore"] == 45
    assert updated["items"][0]["matchTier"] == 5


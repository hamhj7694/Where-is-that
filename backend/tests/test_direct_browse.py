from __future__ import annotations

from types import SimpleNamespace

from app import ai_pipeline, db, main, police_api
from app.schemas import LostFoundBrowseRequest


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


def test_two_letter_name_matches_masked_public_text():
    # 공개 원문이 '류*진'이어서 가려진 부분이 0글자여도 짧은 실명 '류진'과 맞아야 한다.
    assert police_api._term_matches("류진", "여성지갑(류*진)")
    assert police_api._term_matches("류*진", "이름 류진 입니다")


def test_browse_scans_broad_when_keyword_returns_nothing(monkeypatch):
    hidden = row("police:hidden", "2026-11-22", name="류*진", subject="가죽 지갑")

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [hidden] if not keyword else [], "totalCount": 1 if not keyword else 0}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("류영진", 1, 10, max_pages=2)
    assert [item["id"] for item in result["items"]] == ["police:hidden"]
    assert result["items"][0]["matchTier"] == 2  # 가려진 이름이라도 검색어 일치로 올라온다


def test_quick_search_keeps_only_public_text_matches_without_ai(monkeypatch):
    match = row("police:target", "2026-11-24", notes="별무늬")
    unrelated = row("police:other", "2026-11-23", name="안경")
    monkeypatch.setattr(police_api, "search", lambda *_: {"items": [match, unrelated], "totalCount": 2})
    result = police_api.browse_all("별무늬", rows=10, max_pages=1)
    assert [item["id"] for item in result["items"]] == ["police:target"]
    assert result["criteriaApplied"] is False


def test_lost_search_can_find_independent_photo_and_description_candidates(monkeypatch):
    photo = row("police:photo", "2026-11-22", name="교통카드", notes="", imageUrl="https://www.lost112.go.kr/a.jpg")
    description = row("police:text", "2026-11-22", name="습득 물건", notes="별무늬와 고리")
    unrelated = row("police:other", "2026-11-22", name="장갑", notes="")
    calls = []

    def name_search(source, keyword, page, rows):
        calls.append(keyword)
        return {"items": [], "totalCount": 0}

    def date_search(source, filters, page, rows):
        assert filters["START_YMD"] == filters["END_YMD"]
        return {"items": [photo, description, unrelated] if source == "police" else [], "totalCount": 3}

    monkeypatch.setattr(police_api, "search", name_search)
    monkeypatch.setattr(police_api, "search_filtered", date_search)
    result = police_api.search_all(
        "별무늬", original_query="별무늬 카드", photo_search=True,
        hints={"apiKeywords": ["교통카드"], "imageFeatures": ["별무늬"]},
    )
    assert result["items"] == []
    assert [item["id"] for item in result["photoItems"]] == ["police:photo"]
    assert [item["id"] for item in result["contextItems"]] == ["police:text"]
    assert set(calls) == {"별무늬", "카드", "교통카드", ""}


def test_explicit_ai_browse_prioritizes_independently_found_photo_even_without_ai_hints(monkeypatch):
    named = row("police:named", "2026-11-24", name="카드", imageUrl="https://www.lost112.go.kr/named.jpg")
    photo = row("police:photo", "2026-11-22", name="등록 물건", imageUrl="https://www.lost112.go.kr/photo.jpg")
    monkeypatch.setattr(police_api, "search", lambda *_: {"items": [named], "totalCount": 1})

    def recent_cards(source, filters, page, rows):
        assert filters["PRDT_CL_CD_01"]
        return {"items": [photo] if source == "police" else [], "totalCount": 1}

    monkeypatch.setattr(police_api, "search_filtered", recent_cards)
    result = police_api.browse_all("별무늬 카드", rows=10, max_pages=1, search_mode="ai")
    assert result["photoPriority"] == ["police:photo"]
    assert {item["id"] for item in result["items"]} == {"police:named", "police:photo"}

    monkeypatch.setattr(main, "VISUAL_BATCH_SIZE", 1)
    call_order = []
    def match(request):
        candidate = request.candidates[0]
        call_order.append(candidate.id)
        assert request.query == "별무늬 카드"
        return SimpleNamespace(results=[SimpleNamespace(
            id=candidate.id, imageSimilarity=95 if candidate.id == photo["id"] else 10, basis="photo",
        )])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", match)
    previews = []
    payload = LostFoundBrowseRequest(keyword="별무늬 카드", searchMode="ai")
    ranked = main._apply_visual_hints(result, payload, preview=lambda items: previews.append((len(call_order), items)))
    assert call_order == ["police:photo", "police:named"]
    assert previews[0][0] == 1
    assert previews[0][1][0]["id"] == photo["id"]
    assert ranked["items"][0]["id"] == photo["id"]


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


def test_official_color_does_not_erase_scores_from_photos(monkeypatch):
    payload = SimpleNamespace(
        keyword="하얀 신한카드", hints={"imageFeatures": ["하얀색"]}, page=1, rows=3,
    )
    black = row(
        "police:black", "2026-11-23", name="신한카드", color="블랙(검정)",
        imageUrl="https://www.lost112.go.kr/a.jpg", matchTier=5,
    )
    teal = row(
        "police:teal", "2026-11-22", name="신한카드", color="시안(청록)",
        imageUrl="https://www.lost112.go.kr/b.jpg", matchTier=5,
    )
    white = row(
        "police:white", "2026-11-21", name="신한카드", color="화이트(흰)",
        imageUrl="https://www.lost112.go.kr/c.jpg", matchTier=5,
    )
    result = {"items": [black, teal, white], "allItems": [black, teal, white], "total": 3}

    def fake_match(request):
        return SimpleNamespace(results=[
            SimpleNamespace(id="police:black", imageSimilarity=88, basis="photo"),
            SimpleNamespace(id="police:teal", imageSimilarity=80, basis="photo"),
            SimpleNamespace(id="police:white", imageSimilarity=60, basis="photo"),
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    updated = main._apply_visual_hints(result, payload)

    assert updated["visualScores"] == {"police:black": 88, "police:teal": 80, "police:white": 60}
    assert white["visualScore"] == 60
    assert white["matchTier"] == 1
    assert white["matchLabel"] == "AI 사진 일치"


def test_person_name_query_never_scores_an_unrelated_photo(monkeypatch):
    """이름은 공개 원문 텍스트 단서일 뿐, 사진 특징 점수 근거가 될 수 없다."""
    payload = SimpleNamespace(
        keyword="류진",
        hints={"apiKeywords": ["류진"], "include": ["류진"], "imageFeatures": ["류진"]},
        page=1, rows=2, priorVisualScores={"police:card": 90},
    )
    named = row(
        "police:named", "2026-11-22", name="여성지갑(류*진)",
        matchTier=0, matchLabel="AI+검색어 일치",
    )
    card = row(
        "police:card", "2026-11-22", imageUrl="https://www.lost112.go.kr/a.jpg",
        name="신한카드", matchTier=5, matchLabel="공개 원문",
    )
    result = {"items": [card, named], "allItems": [card, named], "total": 2}
    calls = []

    def must_not_call(request):
        calls.append(request)

    monkeypatch.setattr(ai_pipeline, "match_visual_features", must_not_call)
    updated = main._apply_visual_hints(result, payload)

    assert calls == []  # 이름만 있으면 사진을 들여다보지 않는다.
    assert updated["visualScores"] == {}
    assert updated["items"][0]["id"] == "police:named"
    assert updated["items"][1].get("visualScore") is None
    assert updated["items"][1]["matchTier"] == 5
    assert updated["items"][1]["matchLabel"] == "공개 원문"


def test_person_name_is_stripped_from_visual_query(monkeypatch):
    payload = SimpleNamespace(
        keyword="류진 지갑", hints={"imageFeatures": ["류진", "지갑"]}, page=1, rows=1,
    )
    item = row("police:bag", "2026-11-22", imageUrl="https://www.lost112.go.kr/a.jpg")
    result = {"items": [item], "allItems": [item], "total": 1}
    seen = {}

    def fake_match(request):
        seen["query"] = request.query
        seen["features"] = request.imageFeatures
        return SimpleNamespace(results=[])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    main._apply_visual_hints(result, payload)

    assert seen == {"query": "지갑", "features": ["지갑"]}


def test_visual_scan_starts_with_newest_and_checks_the_remaining_batch(monkeypatch):
    payload = SimpleNamespace(
        keyword="카드", hints={"imageFeatures": ["치이카와"]}, page=1, rows=1,
    )
    items = [
        row(f"police:{index}", f"2026-01-{index:02d}", imageUrl=f"https://www.lost112.go.kr/{index}.jpg")
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
    assert len(batches) == 2
    assert batches[0] == [f"police:{index}" for index in range(10, 2, -1)]
    assert batches[1] == ["police:2", "police:1"]


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


def test_deeper_browse_reuses_pages_and_compares_only_unseen_photos(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    monkeypatch.setattr(police_api, "configured", lambda: True)
    monkeypatch.setattr(main.config, "LOSTFOUND_BROWSE_PAGE_CAP", 1)
    monkeypatch.setattr(main, "_browse_jobs", {})
    monkeypatch.setattr(main, "_browse_executor", SimpleNamespace(submit=lambda fn, *args: fn(*args)))
    api_calls = []
    checked_ids = []

    def page(source, params, number, rows):
        api_calls.append((source, number))
        assert params["PRDT_CL_CD_01"]
        if source != "police":
            return {"items": [], "totalCount": 0}
        # 다음 페이지의 날짜가 더 최신이어도 기존 점수와 분석 기록을 유지한다.
        items = [
            row(f"police:{number}:{index}", f"2026-11-{number + 20:02d}",
                name=f"카드 {number}-{index}", category="카드 > 일반카드",
                imageUrl=f"https://www.lost112.go.kr/{number}-{index}.jpg")
            for index in (1, 2)
        ] if number <= 2 else []
        return {"items": items, "totalCount": 4}

    def match(request):
        checked_ids.extend(candidate.id for candidate in request.candidates)
        return SimpleNamespace(results=[
            SimpleNamespace(id=candidate.id, imageSimilarity={"police:1:1": 80, "police:2:1": 95}.get(candidate.id, 0), basis="photo")
            for candidate in request.candidates
        ])

    monkeypatch.setattr(police_api, "search_filtered", page)
    monkeypatch.setattr(ai_pipeline, "match_visual_features", match)
    payload = LostFoundBrowseRequest(keyword="카드", searchMode="ai", rows=2, filters={"category": "카드"})
    first_id = main.start_lostfound_browse_job(payload)["jobId"]
    first = main.get_lostfound_browse_job(first_id)["result"]
    assert first["visualMore"]
    assert len(first["allItems"]) == 2
    assert {number for _, number in api_calls} == {1}
    assert set(checked_ids) == {"police:1:1", "police:1:2"}

    api_calls.clear()
    checked_ids.clear()
    second_id = main.start_lostfound_browse_job(payload.model_copy(update={"previousJobId": first_id}))["jobId"]
    second = main.get_lostfound_browse_job(second_id)["result"]
    assert {number for _, number in api_calls} == {2}
    assert set(checked_ids) == {"police:2:1", "police:2:2"}
    assert len(second["allItems"]) == 4
    assert second["visualScores"] == {"police:1:1": 80, "police:2:1": 95}
    assert second["items"][0]["id"] == "police:2:1"
    assert not second["visualMore"]


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


def test_browse_cache_key_ignores_page():
    first = main._lostfound_browse_key(LostFoundBrowseRequest(keyword="바나나", page=1))
    second = main._lostfound_browse_key(LostFoundBrowseRequest(keyword="바나나", page=2))
    assert first == second


def test_rank_browse_result_returns_full_pool_for_instant_pagination():
    items = [row(f"police:{index}", f"2026-01-0{index}") for index in range(1, 4)]
    result = {"items": items[:1], "allItems": items, "total": len(items)}

    ranked = main._rank_browse_result(result, {}, "", 2, 1)

    assert ranked["total"] == 3
    assert len(ranked["allItems"]) == 3
    assert [item["id"] for item in ranked["items"]] == ["police:2"]


def test_browse_dedupes_same_title_and_image_even_when_details_differ(monkeypatch):
    first = row("police:first", "2026-02-10", imageUrl="https://www.lost112.go.kr/img/banana.jpg")
    duplicate = row(
        "portal:second", "2026-02-11", id="portal:second",
        imageUrl="https://www.lost112.go.kr/img/banana.jpg?utm_source=test",
        color="초록", storagePlace="다른지구대", orgName="다른지구대",
    )

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [first, duplicate], "totalCount": 2}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, max_pages=1)

    assert result["total"] == 1
    assert [item["id"] for item in result["items"]] == ["police:first"]


def test_browse_keeps_same_title_without_photos_as_separate_items(monkeypatch):
    first = row("police:first", "2026-02-10", name="바나나", color="노랑")
    second = row("police:second", "2026-02-11", name="바나나", color="초록")

    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {"items": [first, second], "totalCount": 2}

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, max_pages=1)

    assert result["total"] == 2


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
    assert [item["id"] for item in result["items"]] == ["police:keep", "police:broken"]
    assert result["total"] == 2
    assert result["items"][0]["aiMatch"]["hits"] == ["가죽"]


def test_inferred_category_ranks_ahead_without_filtering_other_categories(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {
            "items": [
                row("police:phone", "2026-03-03", name="검은색 휴대폰", subject="검은색 휴대폰", category="휴대폰 > 삼성휴대폰"),
                row("police:wallet", "2026-03-02", name="검은색 지갑", subject="검은색 지갑", category="지갑 > 남성용 지갑"),
            ] if page == 1 else [],
            "totalCount": 2,
        }

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all(
        "", 1, 10,
        hints={"include": ["지갑"], "any": ["검은색"], "prefer": ["지하철"]},
        max_pages=1,
    )

    assert [item["id"] for item in result["items"]] == ["police:wallet", "police:phone"]
    assert result["total"] == 2


def test_browse_falls_back_when_category_term_has_no_match(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {
            "items": [row("police:carrier", "2026-03-01", name="회색 캐리어", category="가방 > 기타가방")],
            "totalCount": 1,
        }

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all(
        "", 1, 10, hints={"include": ["노트북"], "any": ["회색"]}, max_pages=1,
    )

    # 해당 분류가 없으면 빈 화면 대신 부분 일치 결과를 보여준다.
    assert [item["id"] for item in result["items"]] == ["police:carrier"]
    assert result["items"][0]["matchTier"] == 4


def test_browse_keeps_modified_phrase_as_soft_condition(monkeypatch):
    def fake_search(source: str, keyword: str, page: int = 1, rows: int = 20) -> dict:
        return {
            "items": [
                row("police:branded", "2026-03-02", name="교촌 쇼핑백", category="쇼핑백 > 쇼핑백"),
                row("police:books", "2026-03-01", name="책이 든 쇼핑백", category="쇼핑백 > 쇼핑백"),
            ] if page == 1 else [],
            "totalCount": 2,
        }

    monkeypatch.setattr(police_api, "search", fake_search)
    result = police_api.browse_all("", 1, 10, hints={"include": ["교촌 쇼핑백"]}, max_pages=1)

    # 분류명에 수식어가 붙은 문구는 하드 필터로 쓰지 않는다.
    assert {item["id"] for item in result["items"]} == {"police:branded", "police:books"}


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


def test_inferred_exclusion_demotes_but_preserves_public_candidates(monkeypatch):
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

    assert [item["id"] for item in result["items"]] == ["police:keep", "police:drop"]


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

    # 명시한 지역은 코드가 없어도 지역 텍스트로 검사한다.
    assert result["filterApi"] is True
    assert result["total"] == 0


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
    batch_count = len(batches)
    main._apply_visual_hints(result, payload)
    assert len(batches) == batch_count == 2


def test_prefer_terms_rank_higher_without_filtering_out_others():
    near = row("police:near", "2026-01-02", subject="지하철에서 습득한 지갑", matchTier=1)
    far = row("police:far", "2026-01-01", subject="지갑", matchTier=1)
    result = {"items": [far, near], "allItems": [far, near], "total": 2}
    payload = SimpleNamespace(
        keyword="지갑", hints={"include": ["지갑"], "prefer": ["지하철"]},
        page=1, rows=2, skipVisual=0, priorVisualScores={},
    )

    updated = main._apply_visual_hints(result, payload)

    ids = [item["id"] for item in updated["items"]]
    assert ids[0] == "police:near"
    assert "police:far" in ids
    assert all(item["matchTier"] == 1 for item in updated["items"])


def test_duplicate_public_photo_is_sent_once_and_score_is_copied(monkeypatch):
    items = [
        row("police:first", "2026-01-01", imageUrl="https://www.lost112.go.kr/a.jpg?utm_source=test"),
        row("police:alias", "2026-01-02", imageUrl="https://www.lost112.go.kr/a.jpg"),
        row("police:other", "2026-01-03", imageUrl="https://www.lost112.go.kr/b.jpg"),
    ]
    result = {"items": items, "allItems": items, "total": 3}
    payload = SimpleNamespace(
        keyword="지갑", hints={"imageFeatures": ["지갑"]}, page=1, rows=3,
        skipVisual=0, priorVisualScores={},
    )
    batches: list[list[str]] = []

    def fake_match(request):
        batches.append([candidate.id for candidate in request.candidates])
        return SimpleNamespace(results=[
            SimpleNamespace(id=candidate.id, imageSimilarity=80, basis="photo")
            for candidate in request.candidates
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", fake_match)
    updated = main._apply_visual_hints(result, payload)

    # 같은 사진은 최신 기록 한 건만 모델에 보낸다.
    assert batches == [["police:other", "police:alias"]]
    scores = {item["id"]: item.get("visualScore") for item in updated["allItems"]}
    assert scores == {"police:first": 80, "police:alias": 80, "police:other": 80}


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


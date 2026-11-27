"""Reproducible retrieval and ranking cases with labelled public responses and model scores."""
from __future__ import annotations

from collections import Counter
from datetime import date
from itertools import product

import pytest

from app import ai_pipeline, gallery_rank, local_vision, main, police_api, search_period, web_reference
from app.ai_schemas import AiGalleryRankRequest, AiVisualMatchResponse
from app.schemas import LostFoundBrowseRequest

PRODUCTS = (
    ("하치와레 카드", "카드", "카드 > 신용(체크)카드"),
    ("짱구 그림 가방", "가방", "가방 > 기타가방"),
    ("고양이 지갑", "지갑", "지갑 > 남성용 지갑"),
    ("체크무늬 의류", "의류", "의류 > 여성의류"),
    ("별 그림 휴대폰", "휴대폰", "휴대폰 > 삼성휴대폰"),
    ("바다 그림 도서용품", "도서용품", "도서용품 > 소설"),
    ("빨간 쇼핑백", "쇼핑백", "쇼핑백 > 쇼핑백"),
    ("꽃무늬 서류", "서류", "서류 > 서류"),
    ("구름 스티커 컴퓨터", "컴퓨터", "컴퓨터 > LG노트북"),
    ("고래 모양 귀금속", "귀금속", "귀금속 > 반지"),
)
SCENARIOS = (
    "keyword", "priority", "wrong-category", "second-page", "no-photo",
    "photo-only-evidence", "source-retry", "duplicate-source-page", "date-boundary", "outside-period",
)
PUBLIC_CASES = [
    pytest.param(query, noun, category, scenario, id=f"{noun}-{scenario}")
    for (query, noun, category), scenario in product(PRODUCTS, SCENARIOS)
]

FROM = "2026-09-26"
TO = "2026-11-26"
SOURCES = ("police", "portal")
OFFICIAL_IMAGE = "https://www.lost112.go.kr/lostnfs/images/uploadImg/test"


def public_row(key, source, name, category, *, found="2026-10-22", photo=True, notes=""):
    return {
        "id": f"{source}:{key}", "source": source, "name": name, "category": category,
        "subject": "", "color": "", "foundDate": found, "foundPlace": "", "notes": notes,
        "imageUrl": f"{OFFICIAL_IMAGE}/{key}.jpg" if photo else None,
    }


def arrange_public(monkeypatch, query, noun, category, scenario):
    source = "portal" if scenario in ("source-retry", "no-photo") else "police"
    target = public_row("target", source, noun, category)
    if scenario == "wrong-category":
        target["category"] = "기타물품 > 기타"
    if scenario == "photo-only-evidence":
        target.update(name="사진 첨부 물건", category="기타물품 > 기타")
    if scenario == "no-photo":
        target.update(imageUrl=None, notes=query)
    if scenario == "date-boundary":
        target["foundDate"] = FROM
    if scenario == "outside-period":
        target["foundDate"] = "2026-09-25"
    decoys = {
        origin: [
            public_row(f"{origin}-different", origin, "다른 물건", "기타물품 > 기타"),
            public_row(f"{origin}-unrelated", origin, "별개 물품", "기타물품 > 기타"),
        ] for origin in SOURCES
    }
    if scenario in ("second-page", "source-retry"):
        decoys[source].append(target)
    elif scenario != "priority":
        decoys[source].insert(0, target)
    calls = Counter()

    def page(origin, params, number):
        assert params["START_YMD"] == "20260926"
        assert params["END_YMD"] == "20261126"
        preferred = "PRDT_CL_CD_01" in params
        key = (origin, preferred, number)
        calls[key] += 1
        if scenario == "source-retry" and origin == source and number == 1 and not preferred and calls[key] == 1:
            raise police_api.PoliceError("lostfound_timeout", "test timeout")
        data = decoys[origin] if not preferred else (
            [target] if origin == source and scenario in ("priority", "duplicate-source-page") else []
        )
        return {"items": data[(number - 1) * 2:number * 2], "totalCount": len(data)}

    def name_lookup(origin, term, number, rows):
        items = [target] if scenario == "keyword" and origin == source and term == noun and number == 1 else []
        return {"items": items, "totalCount": len(items)}

    monkeypatch.setattr(police_api, "PERIOD_PAGE_ROWS", 2)
    original_period = search_period.resolve_period
    monkeypatch.setattr(search_period, "resolve_period", lambda filters, hints, **kwargs: original_period(
        filters, hints, today=date(2026, 11, 26), **kwargs,
    ))
    monkeypatch.setattr(police_api, "_cached_period_page", page)
    monkeypatch.setattr(police_api, "search", name_lookup)
    return target, calls


@pytest.mark.parametrize("mode", ["lost", "direct-ai", "direct-basic"])
@pytest.mark.parametrize("query,noun,category,scenario", PUBLIC_CASES)
def test_public_search_dataset(monkeypatch, mode, query, noun, category, scenario):
    target, calls = arrange_public(monkeypatch, query, noun, category, scenario)
    filters = {"from": FROM, "to": TO}
    hints = {"apiKeywords": [noun], "include": [noun], "imageFeatures": [query.split()[0]]}
    pool = {}
    photo_ids = set()
    cursor = None
    for page in range(1, 5):
        if mode == "lost":
            result = police_api.search_in_period(
                noun, page, 40, hints, cursor, original_query=query, photo_category=noun, filters=filters,
            )
            photo_ids.update(row["id"] for row in result["photoItems"])
            candidates = result["items"] + result["photoItems"] + result["contextItems"]
        else:
            result = police_api.browse_all(
                noun, filters=filters, hints=hints, search_mode="ai" if mode == "direct-ai" else "basic",
                period_mode=True, period_cursor=cursor,
            )
            candidates = result["allItems"]
        pool.update((row["id"], row) for row in candidates)
        if page == 1 and scenario == "source-retry":
            assert not result["coverage"]["complete"]
            assert result["coverage"]["sources"]["portal"]["pagesRead"] == 0
            assert result["errors"][0]["code"] == "lostfound_timeout"
        cursor = result["periodCursor"]
        if not result["hasMore"]:
            break
    assert result["coverage"]["complete"]
    assert result["coverage"]["from"] == FROM and result["coverage"]["to"] == TO
    wanted = scenario != "outside-period" and not (
        mode == "direct-basic" and scenario in ("priority", "photo-only-evidence")
    )
    target_id = target["id"]
    assert (target_id in pool) is wanted
    if scenario == "source-retry":
        assert calls[("portal", False, 1)] == 2
        assert calls[("police", False, 1)] == 1
    if mode == "lost":
        assert (target_id in photo_ids) is (wanted and target["imageUrl"] is not None)
    elif wanted:
        # Ranking is evaluated separately from candidate inclusion with labelled visual evidence.
        ranked = {"allItems": list(pool.values())}
        if mode == "direct-ai" and target["imageUrl"]:
            main._restore_visual_scores(ranked, {target_id: 97})
        main._rank_browse_result(ranked, hints if mode == "direct-ai" else {}, noun, 1, 40)
        assert ranked["items"][0]["id"] == target_id


GALLERY_CASES = [
    pytest.param(group, variant, id=f"{group}-{variant}")
    for group, variant in product(
        ("travel", "family", "food", "notes", "calendar", "chat", "receipt", "hardware", "sign", "drawing"),
        range(10),
    )
]


@pytest.mark.parametrize("group,variant", GALLERY_CASES)
def test_local_gallery_ranking_dataset(monkeypatch, group, variant):
    mode = variant % 3
    target = f"{group}-target"
    candidates = [f"{group}-decoy-{i}" for i in range(18 + variant)]
    candidates.insert(variant * 3 % (len(candidates) + 1), target)
    # A close decoy still belongs in the pool; it must rank below the labelled match.
    close = (0.22 + variant * 0.01, 0.97, 0.0)
    reference = (1.0, 0.0, 0.0)
    text = (0.42, 0.91, 0.0)
    vector = reference if mode == 1 else text if mode == 0 else (0.94, 0.34, 0.0)
    monkeypatch.setattr(local_vision, "clip_available", lambda: True)
    monkeypatch.setattr(local_vision, "embed_text", lambda _: text)
    monkeypatch.setattr(local_vision, "embed_gallery_images", lambda images: {
        item_id: reference if item_id == "reference" else vector if item_id == target
        else close if item_id.endswith("-4") else (0.0, 0.0, 1.0)
        for item_id in images
    })
    image = "data:image/jpeg;base64,AAAA"
    rows = []
    for start in range(0, len(candidates), 16):
        request = AiGalleryRankRequest(
            queryPrompt="" if mode == 1 else group,
            reference=None if mode == 0 else image,
            candidates=[{"id": row, "image": image} for row in candidates[start:start + 16]],
        )
        rows.extend(gallery_rank.rank_gallery_batch(request)["results"])
    assert {row["id"] for row in rows} == set(candidates)
    assert max(rows, key=lambda row: row["score"])["id"] == target


@pytest.mark.parametrize(("filters", "hints", "query", "expected"), [
    ({}, {}, "", ("2026-09-26", "2026-11-26", "default", False)),
    ({}, {"fromDate": "2026-10-01"}, "파란 지갑", ("2026-09-26", "2026-11-26", "default", False)),
    ({}, {}, "지난주 찾은 가방", ("2026-11-06", TO, "inferred", False)),
    ({}, {}, "지난달 카드", ("2026-09-21", TO, "inferred", False)),
    ({}, {}, "2026년 11월 24일에 잃어버린 접이식 우산", ("2026-11-14", TO, "inferred", False)),
    ({}, {}, "어제 잃어버린 우산", ("2026-11-15", TO, "inferred", False)),
    ({}, {"fromDate": "2026-07-03", "toDate": "2026-07-08"}, "한 달 전", ("2026-06-23", TO, "inferred", False)),
    ({}, {"toDate": "2026-07-08"}, "한 달 전", ("2026-06-28", TO, "inferred", False)),
    ({}, {}, "2025년 12월 25일 잃어버린 가방", ("2025-12-15", "2026-06-15", "inferred", True)),
    ({}, {}, "2026년 12월 1일 지갑", ("2026-11-16", TO, "inferred", False)),
    ({"from": "2026-11-24", "to": "2026-11-24"}, {}, "어제 잃어버린 우산", ("2026-11-24", "2026-11-24", "explicit", False)),
    ({"from": "2024-02-29", "to": TO}, {"fromDate": "2026-09-25"}, "어제", ("2026-05-26", TO, "explicit", True)),
    ({"from": FROM, "to": "2026-02-30"}, {}, "", (FROM, TO, "explicit", False)),
    ({"from": TO, "to": FROM}, {}, "", (FROM, TO, "explicit", False)),
    ({"to": "2024-02-29"}, {}, "", ("2023-12-29", "2024-02-29", "explicit", False)),
])
def test_date_policy(filters, hints, query, expected):
    result = search_period.resolve_period(filters, hints, today=date(2026, 11, 26), query=query)
    assert tuple(result[key] for key in ("from", "to", "basis", "clipped")) == expected


@pytest.mark.parametrize("mode", ["lost", "direct-ai"])
def test_natural_loss_date_fetches_earlier_and_later_public_items(monkeypatch, mode):
    query = "2026년 11월 24일에 잃어버린 접이식 우산"
    hints = {"apiKeywords": ["우산"], "include": ["우산"]}
    earlier = public_row("earlier", "police", "접이식 우산", "기타물품", found="2026-11-14")
    later = public_row("late", "portal", "접이식 우산", "기타물품", found="2026-11-27")
    outside = public_row("older", "police", "접이식 우산", "기타물품", found="2026-11-13")
    calls = []
    original_period = search_period.resolve_period
    monkeypatch.setattr(search_period, "resolve_period", lambda filters, hints, **kwargs: original_period(
        filters, hints, today=date(2026, 11, 27), **kwargs,
    ))

    def public_page(source, params, number):
        calls.append((source, params["START_YMD"], params["END_YMD"]))
        items = [earlier, outside] if source == "police" else [later]
        return {"items": items, "totalCount": len(items)}

    monkeypatch.setattr(police_api, "_cached_period_page", public_page)
    monkeypatch.setattr(police_api, "search", lambda *_: {"items": [], "totalCount": 0})
    if mode == "lost":
        result = police_api.search_in_period(
            "우산", 1, 40, hints, None, original_query=query, photo_category="", filters={},
        )
        candidates = result["photoItems"]
    else:
        result = police_api.browse_all(query, hints=hints, search_mode="ai", period_mode=True)
        candidates = result["allItems"]

    assert set(calls) == {("police", "20261114", "20261127"), ("portal", "20261114", "20261127")}
    assert {candidate["id"] for candidate in candidates} == {earlier["id"], later["id"]}
    assert result["coverage"]["dateBufferDays"] == 10


def test_direct_job_continues_period_even_with_no_current_photo():
    payload = LostFoundBrowseRequest(keyword="지갑", searchMode="ai", periodSearch=True)
    output = main._apply_visual_hints({"coverage": {}, "hasMore": True, "items": []}, payload)
    assert output["hasMore"] is True


def test_default_period_samples_recent_days_without_excluding_broad_pool(monkeypatch):
    target = public_row("target", "police", "신한카드", "카드 > 신용(체크)카드", found="2026-11-22")
    decoy = public_row("other", "police", "다른 물품", "기타물품 > 기타")
    calls = []

    def page(source, params, number):
        calls.append((source, params.copy(), number))
        if source == "police" and params["START_YMD"] == params["END_YMD"] == "20261122":
            return {"items": [target], "totalCount": 1}
        if source == "police" and "PRDT_CL_CD_01" not in params:
            return {"items": [decoy], "totalCount": 1000}
        return {"items": [], "totalCount": 0}

    monkeypatch.setattr(police_api, "_cached_period_page", page)
    monkeypatch.setattr(police_api, "PERIOD_PAGE_ROWS", 1)
    period = search_period.resolve_period({}, {}, today=date(2026, 11, 26))
    cursor = None
    for _ in range(3):
        result = police_api._period_candidates(period, {}, {"PRDT_CL_CD_01": "PRP000"}, cursor)
        cursor = result["periodCursor"]
    assert target["id"] in result["photoPriority"]
    assert decoy in result["bySource"]["police"]
    assert result["coverage"]["sources"]["police"] == {"pagesRead": 3, "complete": False}
    assert sum(source == "police" and params["START_YMD"] == "20261126" for source, params, _ in calls) == 1


def test_direct_visual_progress_counts_returned_photo_scores_and_prioritizes_untried(monkeypatch):
    monkeypatch.setattr(web_reference, "enrich", lambda features: (features, []))
    monkeypatch.setattr(main, "VISUAL_SCAN_CAP", 2)
    batches = []

    def match(request):
        ids = [value.id for value in request.candidates]
        batches.append(ids)
        return AiVisualMatchResponse(source="multimodal", usedFeatures=[], results=[
            {"id": ids[0], "basis": "photo", "imageSimilarity": 81},
        ])

    monkeypatch.setattr(ai_pipeline, "match_visual_features", match)
    items = [public_row(key, "police", "카드", "카드", found=f"2026-10-{day:02d}")
             for key, day in (("fresh", 3), ("failed", 2), ("good", 1))]
    payload = LostFoundBrowseRequest(keyword="카드", searchMode="ai", periodSearch=True, skipVisual=60)
    result = {"coverage": {"complete": False}, "hasMore": True, "allItems": items[:2]}
    first = main._apply_visual_hints(result, payload)
    assert first["visualScanned"] == 1
    assert first["visualMore"]
    assert first["_visualSeenIds"] == ["police:fresh"]
    next_result = {"coverage": {"complete": True}, "hasMore": False, "allItems": items}
    next_result = main._apply_visual_hints(next_result, payload, previous=first)
    assert batches == [["police:fresh", "police:failed"], ["police:good", "police:failed"]]
    assert next_result["visualScanned"] == 1
    assert next_result["visualScores"] == {"police:fresh": 81, "police:good": 81}

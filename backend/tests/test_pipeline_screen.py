from __future__ import annotations

import json
import re

from fastapi.testclient import TestClient

from app import main
from app.ai_schemas import AiFilters


def test_pipeline_algorithms_are_public_and_complete():
    client = TestClient(main.app)
    response = client.get("/api/pipeline/algorithms")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) >= 12
    assert len({item["id"] for item in items}) == len(items)
    for item in items:
        assert item["pipeline"] in main.PIPELINE_IDS
        for key in ("kind", "title", "summary", "input", "steps", "output", "rules", "scopes"):
            assert key in item
        assert item["id"] in main.PIPELINE_TARGETS
    # 키·토큰은 설명에도, 응답에도 담지 않는다. apiKeywords는 공개 탐색어 필드라 허용한다.
    payload = json.dumps(items, ensure_ascii=False)
    pattern = r"\b(api_key|apikey|access_token|secret_key|service_key)\b"
    assert not re.search(pattern, payload, flags=re.IGNORECASE)


def test_pipeline_request_keeps_target_and_rejects_unknown_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "PIPELINE_DIR", tmp_path)
    client = TestClient(main.app)

    saved = client.post("/api/pipeline/request", json={
        "pipeline": "direct-search",
        "target": "algo-ranking",
        "scope": "사진 가중",
        "message": "제목 일치를 더 우선해 주세요.",
    })
    assert saved.status_code == 200
    assert saved.json()["id"].startswith("req-")

    rows = json.loads((tmp_path / "requests.json").read_text(encoding="utf-8"))
    assert rows[0]["target"] == "algo-ranking"
    assert rows[0]["scope"] == "사진 가중"
    assert rows[0]["status"] == "pending"
    assert client.get("/api/pipeline/requests").json()["items"] == rows

    bad_target = client.post("/api/pipeline/request", json={
        "pipeline": "direct-search",
        "target": "없는알고리즘",
        "message": "검증용",
    })
    assert bad_target.status_code == 400
    assert bad_target.json()["code"] == "invalid_target"

    bad_pipeline = client.post("/api/pipeline/request", json={
        "pipeline": "unknown-pipeline",
        "message": "검증용",
    })
    assert bad_pipeline.status_code == 400
    assert bad_pipeline.json()["code"] == "invalid_pipeline"

    # 잘못된 요청은 파일을 바꾸지 않는다.
    assert json.loads((tmp_path / "requests.json").read_text(encoding="utf-8")) == rows

    first = client.post("/api/pipeline/request", json={"pipeline": "direct-search", "message": "하나"})
    second = client.post("/api/pipeline/request", json={"pipeline": "direct-search", "message": "둘"})
    assert first.json()["id"] != second.json()["id"]


def test_ai_dates_are_normalized_and_never_reversed():
    filters = AiFilters(fromDate="2026/11/1", toDate="2026.11.20")
    assert (filters.fromDate, filters.toDate) == ("2026-11-01", "2026-11-20")

    filters = AiFilters(fromDate="약 한 달 전", toDate="2026-11-20")
    assert filters.fromDate == ""

    reversed_range = AiFilters(fromDate="2026-11-20", toDate="2026-11-01")
    assert (reversed_range.fromDate, reversed_range.toDate) == ("2026-11-01", "2026-11-20")

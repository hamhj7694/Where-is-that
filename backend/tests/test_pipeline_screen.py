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


def test_pipeline_issues_reflect_requests_in_real_time(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "PIPELINE_DIR", tmp_path)
    client = TestClient(main.app)
    before = client.get("/api/pipeline/issues")
    assert before.status_code == 200
    issues = before.json()["items"]
    assert len({issue["id"] for issue in issues}) == len(issues)
    assert {issue["priority"] for issue in issues} >= {"필수", "추천", "선택"}
    assert {issue["page"] for issue in issues} >= {"home", "algo-detail", "audit"}
    for issue in issues:
        assert issue["pipeline"] in main.PIPELINE_IDS
        assert not issue["target"] or issue["target"] in main.PIPELINE_TARGETS
        assert issue["requested"] is False
        assert issue["requestCount"] == 0

    selected = next(issue for issue in issues if issue["priority"] == "필수")
    saved = client.post("/api/pipeline/request", json={
        "pipeline": selected["pipeline"],
        "target": selected["target"],
        "scope": selected["priority"],
        "issueId": selected["id"],
        "message": selected["title"] + " — " + selected["detail"],
    })
    assert saved.status_code == 200
    rows = json.loads((tmp_path / "requests.json").read_text(encoding="utf-8"))
    assert rows[0]["issueId"] == selected["id"]

    after = client.get("/api/pipeline/issues").json()["items"]
    updated = next(issue for issue in after if issue["id"] == selected["id"])
    assert updated["requested"] is True
    assert updated["state"] == "requested"
    assert updated["requestCount"] == 1
    assert sum(issue["requested"] for issue in after) == 1

    # AI가 요청을 완료로 바꾸면 다음 폴링에서 목록도 '완료'로 바뀐다.
    rows[0]["status"] = "done"
    (tmp_path / "requests.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    done = next(i for i in client.get("/api/pipeline/issues").json()["items"] if i["id"] == selected["id"])
    assert done["state"] == "done"

    bad = client.post("/api/pipeline/request", json={
        "pipeline": "direct-search", "issueId": "없는항목", "message": "검증용",
    })
    assert bad.status_code == 400
    assert bad.json()["code"] == "invalid_issue"


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


def test_pipeline_screen_exposes_clickable_node_flow_map():
    client = TestClient(main.app)
    response = client.get("/pipeline")
    assert response.status_code == 200
    html = response.text
    assert 'data-go="flow-map"' in html
    assert 'id="flow-map"' in html
    # React Flow(@xyflow/react) 노드 그래프 번들을 사용한다.
    assert 'id="flow-react-root"' in html
    assert 'id="model-map"' in html
    assert '/api/pipeline/models' in html
    assert '/pipeline/flow-map.js' in html
    assert '/pipeline/flow-map.css' in html
    assert "pipeline-node-select" in html
    assert "function selectFlowNode(" in html
    for lane in ("A · 갤러리에서 찾기", "B · 물건 찾기", "C · 직접 찾기", "D · 공통 / 점검", "E · 개별 AI 모델"):
        assert lane in html

    # 번들 파일도 같은 경로로 서빙되어야 한다.
    script = client.get("/pipeline/flow-map.js")
    style = client.get("/pipeline/flow-map.css")
    assert script.status_code == 200 and len(script.content) > 1000
    assert style.status_code == 200 and len(style.content) > 100


def test_pipeline_search_evidence_has_a_capture_for_each_case():
    client = TestClient(main.app)
    html = client.get("/pipeline").text
    assert 'data-go="tests"' in html
    assert 'id="tests"' in html
    assert 'id="home-tests-title"' not in html

    response = client.get("/pipeline/search-test-results.json")
    assert response.status_code == 200
    cases = response.json()["cases"]
    assert len(cases) == len({case["screenshot"] for case in cases}) >= 8
    for case in cases:
        assert len(case["rows"]) == min(case["visibleCount"], 5)
        capture = client.get("/pipeline/" + case["screenshot"])
        assert capture.status_code == 200
        assert capture.headers["content-type"] == "image/jpeg"
        assert capture.content.startswith(b"\xff\xd8")


def test_pipeline_model_map_uses_runtime_settings_without_exposing_paths(monkeypatch):
    monkeypatch.setattr(main.config, "AI_MULTIMODAL_MODEL", "runtime-vlm")
    monkeypatch.setattr(main.config, "AI_MULTIMODAL_API_KEY", "sensitive-example-key")
    monkeypatch.setattr(main.config, "AI_LLM_MODEL", "runtime-text")
    monkeypatch.setattr(main.config, "LOCAL_CLIP_MODEL", "local-vit")
    monkeypatch.setattr(main.config, "LOCAL_CLIP_PRETRAINED", "local-weights")
    monkeypatch.setattr(main.config, "YOLOE_MODEL", r"C:\private\models\custom-yolo.pt")
    monkeypatch.setattr(main.local_vision, "yoloe_available", lambda: True)

    response = TestClient(main.app).get("/api/pipeline/models")
    assert response.status_code == 200
    models = response.json()["items"]
    assert models["model-multimodal"]["model"] == "runtime-vlm"
    assert models["model-multimodal"]["overrides"][0]["model"] == "runtime-text"
    assert models["model-similarity"]["model"] == "local-vit"
    assert models["model-similarity"]["weights"] == "local-weights"
    assert models["model-yoloe"]["model"] == "custom-yolo.pt"
    assert models["model-yoloe"]["state"] == "conditional"
    assert models["model-mobileclip"]["state"] in {"weights-only", "unlinked"}
    assert "sensitive-example-key" not in response.text and "private" not in response.text


def test_ai_dates_are_normalized_and_never_reversed():
    filters = AiFilters(fromDate="2026/11/1", toDate="2026.11.20")
    assert (filters.fromDate, filters.toDate) == ("2026-11-01", "2026-11-20")

    filters = AiFilters(fromDate="약 한 달 전", toDate="2026-11-20")
    assert filters.fromDate == ""

    reversed_range = AiFilters(fromDate="2026-11-20", toDate="2026-11-01")
    assert (reversed_range.fromDate, reversed_range.toDate) == ("2026-11-01", "2026-11-20")

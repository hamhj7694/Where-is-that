import json

import pytest
from fastapi.testclient import TestClient

from app import ai_pipeline, config, db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "ai-test.db")
    with TestClient(main.app) as test_client:
        yield test_client


def test_ai_status_does_not_expose_keys(client, monkeypatch):
    monkeypatch.setattr(config, "AI_LLM_API_KEY", "secret")
    monkeypatch.setattr(config, "AI_VLM_API_KEY", "secret")
    monkeypatch.setattr(config, "AI_VISION_API_KEY", "secret")

    response = client.get("/api/ai/status")

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert response.json()["roles"]["llm"]["model"] == "gpt-6-luna"
    assert "secret" not in response.text


def test_ai_prepare_requires_explicit_external_processing_consent(client):
    response = client.post("/api/ai/search/prepare", json={"mode": "lost", "query": "검은 지갑"})

    assert response.status_code == 422
    assert "동의" in response.json()["message"]


def test_ai_prepare_returns_mode_specific_plan(client, monkeypatch):
    monkeypatch.setattr(config, "AI_VLM_API_KEY", "")
    monkeypatch.setattr(config, "OPENAI_API_KEY", "")
    monkeypatch.setattr(config, "AI_LLM_API_KEY", "test-key")
    responses = iter([
        '{"channels":{"combined":{"query":"검은 지갑","keywords":["검은","지갑"]},"image":{"query":"","keywords":[]},"context":{"query":"검은 지갑","keywords":["검은","지갑"]}},"filters":{"category":"지갑","region":"","view":"","fromDate":"","toDate":""},"clarificationQuestions":[]}',
    ])
    monkeypatch.setattr(ai_pipeline, "_completion", lambda _role, _messages: next(responses))

    response = client.post("/api/ai/search/prepare", json={
        "mode": "lost",
        "query": "검은 지갑",
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    plan = response.json()
    assert plan["originalQuery"] == "검은 지갑"
    assert plan["channels"]["combined"]["query"] == "검은 지갑"
    assert plan["filters"]["category"] == "지갑"


def test_ai_prepare_describes_images_before_interpreting(client, monkeypatch):
    calls = []

    def fake_completion(role, _messages):
        calls.append(role)
        if role == "vlm":
            return '{"descriptions":["검은색 가죽 지갑"]}'
        return '{"channels":{"combined":{"query":"검은 지갑","keywords":["검은","지갑"]},"image":{"query":"검은색 가죽 지갑","keywords":["검은색","가죽"]},"context":{"query":"","keywords":[]}},"filters":{"category":"","region":"","view":"","fromDate":"","toDate":""},"clarificationQuestions":[]}'

    monkeypatch.setattr(ai_pipeline, "_completion", fake_completion)
    response = client.post("/api/ai/search/prepare", json={
        "mode": "gallery",
        "query": "검은 지갑",
        "images": ["data:image/png;base64,YQ=="],
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    assert calls == ["vlm", "llm"]
    assert response.json()["imageDescriptions"] == ["검은색 가죽 지갑"]


def test_ai_prepare_returns_boolean_and_image_criteria(client, monkeypatch):
    monkeypatch.setattr(config, "AI_VLM_API_KEY", "")
    monkeypatch.setattr(ai_pipeline, "_completion", lambda _role, _messages: json.dumps({
        "channels": {
            "combined": {"query": "검은 가죽 지갑", "keywords": ["가죽", "지갑"]},
            "image": {"query": "", "keywords": []},
            "context": {"query": "", "keywords": []},
        },
        "filters": {"category": "", "region": "", "view": "", "fromDate": "", "toDate": ""},
        "criteria": {
            "apiKeywords": ["지갑"],
            "include": ["가죽", "지갑"],
            "any": ["검정", "블랙"],
            "exclude": ["파손"],
            "imageFeatures": ["박음질", "지폐"],
        },
        "clarificationQuestions": [],
    }, ensure_ascii=False))

    response = client.post("/api/ai/search/prepare", json={
        "mode": "lost",
        "query": "검은 가죽 지갑",
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    assert response.json()["criteria"] == {
        "apiKeywords": ["지갑"],
        "include": ["가죽", "지갑"],
        "any": ["검정", "블랙"],
        "exclude": ["파손"],
        "imageFeatures": ["박음질", "지폐"],
    }


def test_ai_prepare_falls_back_to_channel_plan_without_criteria(client, monkeypatch):
    monkeypatch.setattr(config, "AI_VLM_API_KEY", "")
    monkeypatch.setattr(ai_pipeline, "_completion", lambda _role, _messages: json.dumps({
        "channels": {
            "combined": {"query": "검은 지갑", "keywords": ["검은", "지갑"]},
            "image": {"query": "", "keywords": []},
            "context": {"query": "", "keywords": []},
        },
        "filters": {"category": "", "region": "", "view": "", "fromDate": "", "toDate": ""},
        "clarificationQuestions": [],
    }, ensure_ascii=False))

    response = client.post("/api/ai/search/prepare", json={
        "mode": "lost",
        "query": "검은 지갑",
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    criteria = response.json()["criteria"]
    assert criteria["apiKeywords"] == ["검은 지갑", "검은", "지갑"]
    assert criteria["include"] == ["검은", "지갑"]
    assert criteria["exclude"] == []


def test_ai_compare_validates_and_sorts_all_candidate_scores(client, monkeypatch):
    monkeypatch.setattr(ai_pipeline, "_completion", lambda _role, _messages: (
        '{"results":['
        '{"id":"second","score":40,"imageSimilarity":20,"contextRelevance":70,"reasons":[]},'
        '{"id":"first","score":90,"imageSimilarity":95,"contextRelevance":80,"reasons":["색상 유사"]}'
        ']}'
    ))
    image = "data:image/png;base64,YQ=="

    response = client.post("/api/ai/vision/compare", json={
        "mode": "direct",
        "query": "검은 지갑",
        "candidates": [{"id": "first", "image": image}, {"id": "second", "image": image}],
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    results = response.json()["results"]
    assert [item["id"] for item in results] == ["first", "second"]
    assert results[1]["imageSimilarity"] == 20
    assert results[1]["contextRelevance"] == 70


def test_ai_compare_fills_missing_axis_scores_for_legacy_response(client, monkeypatch):
    monkeypatch.setattr(ai_pipeline, "_completion", lambda _role, _messages: (
        '{"results":[{"id":"only","score":55,"reasons":[]}]}'
    ))
    image = "data:image/png;base64,YQ=="

    response = client.post("/api/ai/vision/compare", json={
        "mode": "gallery",
        "query": "바다 사진",
        "candidates": [{"id": "only", "image": image}],
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["imageSimilarity"] == 55
    assert result["contextRelevance"] == 55


def test_ai_compare_analyzes_reference_photo_before_scoring(client, monkeypatch):
    calls = []

    def fake_completion(role, messages):
        calls.append((role, json.dumps(messages, ensure_ascii=False)))
        if role == "vlm":
            return '{"descriptions":["검정 가죽 지갑에 카드와 동전이 보임"]}'
        return '{"results":[{"id":"only","score":90,"imageSimilarity":88,"contextRelevance":70,"reasons":[]}]}'

    monkeypatch.setattr(ai_pipeline, "_completion", fake_completion)
    image = "data:image/png;base64,YQ=="

    response = client.post("/api/ai/vision/compare", json={
        "mode": "gallery",
        "query": "이 지갑과 비슷한 사진",
        "references": [image],
        "candidates": [{"id": "only", "image": image}],
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    assert [role for role, _ in calls] == ["vlm", "vision"]
    assert response.json()["referenceDescriptions"] == ["검정 가죽 지갑에 카드와 동전이 보임"]
    assert "referenceDescriptions" in calls[1][1]
    assert "검정 가죽 지갑에 카드와 동전이 보임" in calls[1][1]


def _context_candidate(candidate_id: str) -> dict:
    return {
        "id": candidate_id,
        "name": "검정 카드지갑",
        "subject": "앞면에 작은 금색 로고가 있어요.",
        "notes": "교통카드 포함",
        "category": "지갑 > 기타 지갑",
        "color": "검정",
        "foundDate": "2026-11-19",
        "foundTime": "21",
        "foundPlace": "서울 관악구 신림동",
        "storagePlace": "관악경찰서",
        "orgName": "서울관악경찰서",
        "address": "서울특별시 관악구",
        "status": "보관중",
        "keepType": "경찰관서",
        "placeName": "관악경찰서",
        "placeAddress": "서울특별시 관악구",
        "placeRoadAddress": "",
        "placeCategory": "경찰서",
    }


def test_context_rank_requires_candidate_data_consent(client):
    response = client.post("/api/ai/search/rank-context", json={
        "originalQuery": "신림역 근처 검은 지갑",
        "candidates": [_context_candidate("one")],
    })

    assert response.status_code == 422
    assert "후보 정보" in response.json()["message"]


def test_context_rank_sends_full_candidate_text_and_sorts_results(client, monkeypatch):
    captured = {}

    def fake_completion(role, messages):
        captured["role"] = role
        captured["input"] = json.loads(messages[1]["content"])
        return json.dumps({"results": [
            {"id": "second", "score": 40, "reasons": ["장소 근거가 부족함"], "locationRelation": "uncertain", "locationEvidence": "주소 정보 없음", "uncertainty": "주소가 없음"},
            {"id": "first", "score": 90, "reasons": ["상세 설명에 금색 로고가 있음"], "locationRelation": "possible_nearby", "locationEvidence": "습득 장소: 서울 관악구 신림동", "uncertainty": "보관기관 위치가 습득 위치와 다를 수 있음"},
        ]}, ensure_ascii=False)

    monkeypatch.setattr(ai_pipeline, "_completion", fake_completion)
    response = client.post("/api/ai/search/rank-context", json={
        "originalQuery": "정확하지는 않지만 신림역 인근에서 잃어버린 검은 지갑",
        "searchQuery": "신림역 검은 지갑",
        "filters": {"region": "서울"},
        "candidates": [_context_candidate("first"), _context_candidate("second")],
        "candidateDataProcessingConfirmed": True,
    })

    assert response.status_code == 200
    assert captured["role"] == "llm"
    assert captured["input"]["candidates"][0]["subject"] == "앞면에 작은 금색 로고가 있어요."
    assert captured["input"]["candidates"][0]["notes"] == "교통카드 포함"
    assert captured["input"]["candidates"][0]["foundPlace"] == "서울 관악구 신림동"
    assert captured["input"]["candidates"][0]["storagePlace"] == "관악경찰서"
    assert captured["input"]["candidates"][0]["address"] == "서울특별시 관악구"
    assert [item["id"] for item in response.json()["results"]] == ["first", "second"]


def test_context_rank_rejects_missing_candidate_ids(client, monkeypatch):
    monkeypatch.setattr(ai_pipeline, "_completion", lambda _role, _messages: json.dumps({"results": [
        {"id": "first", "score": 90, "reasons": ["장소 근거가 부족함"], "locationRelation": "uncertain", "locationEvidence": "주소 정보 없음", "uncertainty": "장소를 확인할 수 없음"},
    ]}))
    response = client.post("/api/ai/search/rank-context", json={
        "originalQuery": "검은 지갑",
        "candidates": [_context_candidate("first"), _context_candidate("second")],
        "candidateDataProcessingConfirmed": True,
    })

    assert response.status_code == 502
    assert "누락되거나 중복" in response.json()["message"]


def test_ai_prepare_reports_missing_server_key(client, monkeypatch):
    monkeypatch.setattr(config, "AI_LLM_API_KEY", "")
    monkeypatch.setattr(config, "OPENAI_API_KEY", "")

    response = client.post("/api/ai/search/prepare", json={
        "mode": "direct",
        "query": "검은 지갑",
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 503
    assert response.json()["code"] == "ai_not_configured"


def test_provider_request_disables_response_storage(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "{}"}}]}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr(config, "AI_LLM_API_KEY", "test-key")
    monkeypatch.setattr(ai_pipeline.httpx, "post", fake_post)

    result = ai_pipeline._completion("llm", [{"role": "user", "content": "text"}])

    assert result == "{}"
    assert captured["json"]["model"] == "gpt-6-luna"
    assert captured["json"]["store"] is False
    # gpt-6-luna는 기본 temperature만 지원하므로 재전송하면 400→502가 난다.
    assert "temperature" not in captured["json"]

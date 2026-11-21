import json

import pytest
from fastapi.testclient import TestClient

from app import ai_pipeline, config, db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "ai-test.db")
    # 기본 로컬 CLIP은 무거운 모델을 로드하므로 기존 회귀 테스트는 멀티모달 폴백으로 고정한다.
    monkeypatch.setattr(config, "AI_SIMILARITY_PROVIDER", "none")
    with TestClient(main.app) as test_client:
        yield test_client


def test_ai_status_does_not_expose_keys(client, monkeypatch):
    monkeypatch.setattr(config, "AI_MULTIMODAL_API_KEY", "secret")
    monkeypatch.setattr(config, "AI_SIMILARITY_API_KEY", "secret")

    response = client.get("/api/ai/status")

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert response.json()["roles"]["multimodal"]["model"] == "gpt-6-luna"
    assert "secret" not in response.text


def test_ai_status_reports_image_similarity_role(client, monkeypatch):
    monkeypatch.setattr(config, "AI_SIMILARITY_PROVIDER", "openai-compatible")
    monkeypatch.setattr(config, "AI_SIMILARITY_MODEL", "voyage-multimodal-3")
    monkeypatch.setattr(config, "AI_SIMILARITY_API_KEY", "secret")

    response = client.get("/api/ai/status")

    assert response.status_code == 200
    role = response.json()["roles"]["imageSimilarity"]
    assert role["available"] is True
    assert role["provider"] == "openai-compatible"
    assert role["source"] == "vision-model"
    assert "secret" not in response.text


def test_ai_prepare_requires_explicit_external_processing_consent(client):
    response = client.post("/api/ai/search/prepare", json={"mode": "lost", "query": "검은 지갑"})

    assert response.status_code == 422
    assert "동의" in response.json()["message"]


def test_ai_prepare_returns_mode_specific_plan(client, monkeypatch):
    monkeypatch.setattr(config, "AI_VLM_API_KEY", "")
    monkeypatch.setattr(config, "OPENAI_API_KEY", "")
    monkeypatch.setattr(config, "AI_MULTIMODAL_API_KEY", "test-key")
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
        if len(calls) == 1:
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
    assert calls == ["vlm", "multimodal"]
    assert response.json()["imageDescriptions"] == ["검은색 가죽 지갑"]


def test_ai_prepare_without_images_uses_llm_only(client, monkeypatch):
    roles = []

    def fake_completion(role, _messages):
        roles.append(role)
        return json.dumps({
            "channels": {
                "combined": {"query": "검은 지갑", "keywords": ["검은", "지갑"]},
                "image": {"query": "", "keywords": []},
                "context": {"query": "검은 지갑", "keywords": ["지갑"]},
            },
            "filters": {"category": "", "region": "", "view": "", "fromDate": "", "toDate": ""},
            "clarificationQuestions": [],
        }, ensure_ascii=False)

    monkeypatch.setattr(ai_pipeline, "_completion", fake_completion)
    response = client.post("/api/ai/search/prepare", json={
        "mode": "lost", "query": "검은 지갑", "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    assert roles == ["llm"]


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
        if len(calls) == 1:
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
    assert [role for role, _ in calls] == ["vlm", "multimodal"]
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
    monkeypatch.setattr(config, "AI_VLM_API_KEY", "")
    monkeypatch.setattr(config, "AI_MULTIMODAL_API_KEY", "")
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

    monkeypatch.setattr(config, "AI_MULTIMODAL_API_KEY", "test-key")
    monkeypatch.setattr(ai_pipeline.httpx, "post", fake_post)

    result = ai_pipeline._completion("multimodal", [{"role": "user", "content": "text"}])

    assert result == "{}"
    assert captured["json"]["model"] == "gpt-6-luna"
    assert captured["json"]["store"] is False
    # gpt-6-luna는 기본 temperature만 지원하므로 재전송하면 400→502가 난다.
    assert "temperature" not in captured["json"]


def test_interpret_prompt_reads_visual_traits_from_words_without_photo():
    prompt = (config.AI_PROMPT_DIR / "interpret_search.txt").read_text(encoding="utf-8")

    assert "even when there is no reference photo" in prompt
    assert "딸기가 그려진 지갑" in prompt


def test_match_public_images_scores_photos_and_descriptions_together(client, monkeypatch):
    calls = []
    monkeypatch.setattr(
        ai_pipeline, "_fetch_public_image",
        lambda url: "data:image/jpeg;base64,YQ==" if url.endswith("photo.do") else None,
    )
    monkeypatch.setattr(
        ai_pipeline, "_multimodal_visual_scores",
        lambda query, features, references, images: (calls.append(list(images)) or {"with-photo": 92}),
    )

    response = client.post("/api/ai/vision/match-public", json={
        "query": "딸기가 그려진 지갑",
        "imageFeatures": ["딸기 그림", "지갑"],
        "candidates": [
            {"id": "description-only", "text": "지갑에 딸기 그림이 있어요"},
            {"id": "with-photo", "imageUrl": "https://minwon24.police.go.kr/photo.do"},
            {"id": "no-trait", "text": "일반 지갑"},
        ],
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    body = response.json()
    assert calls == [["with-photo"]]
    assert body["source"] == "multimodal"
    assert body["usedFeatures"] == ["딸기 그림", "지갑"]
    results = {item["id"]: item for item in body["results"]}
    assert results["with-photo"]["basis"] == "photo"
    assert results["with-photo"]["imageSimilarity"] == 92
    assert results["description-only"]["basis"] == "description"
    assert results["description-only"]["imageSimilarity"] == 100
    assert results["no-trait"]["imageSimilarity"] == 50
    assert [item["id"] for item in body["results"]][0] == "description-only"


def test_match_public_images_without_photo_uses_only_text(client, monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("사진이 없으면 멀티모달 사진 분석을 호출하지 않아야 한다")

    monkeypatch.setattr(ai_pipeline, "_multimodal_visual_scores", fail_if_called)
    response = client.post("/api/ai/vision/match-public", json={
        "query": "딸기가 그려진 지갑",
        "imageFeatures": ["딸기 그림"],
        "candidates": [{"id": "text-only", "text": "딸기 그림이 있는 지갑"}],
        "externalProcessingConfirmed": True,
    })

    assert response.status_code == 200
    assert response.json()["results"][0]["imageSimilarity"] == 100


def test_match_public_images_requires_consent(client):
    response = client.post("/api/ai/vision/match-public", json={
        "query": "딸기가 그려진 지갑",
        "candidates": [{"id": "one", "text": "지갑"}],
    })

    assert response.status_code == 422


def test_fetch_public_image_rejects_unallowed_host_without_request(client, monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("허용되지 않은 호스트는 요청하지 않아야 한다")

    monkeypatch.setattr(ai_pipeline.httpx, "get", fail_if_called)

    assert ai_pipeline._fetch_public_image("https://example.com/photo.jpg") is None


def test_fetch_public_image_downscales_large_public_photo(client, monkeypatch):
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (2400, 1800), "red").save(buffer, format="JPEG")
    original = buffer.getvalue()

    class FakeResponse:
        status_code = 200
        url = "https://minwon24.police.go.kr/photo.do"
        headers = {"content-type": "image/jpeg"}
        content = original

        def raise_for_status(self):
            return None

    monkeypatch.setattr(ai_pipeline.httpx, "get", lambda *_args, **_kwargs: FakeResponse())

    result = ai_pipeline._fetch_public_image("https://minwon24.police.go.kr/photo.do")

    assert result is not None
    assert result.startswith("data:image/jpeg;base64,")
    # 원본 2400px 사진이 AI 전송용 소형 썸네일로 줄었다.
    assert len(result) < len(original)


from fastapi.testclient import TestClient

from app import gallery_rank, local_vision, main

IMAGE = "data:image/jpeg;base64,AAAA"
ENDPOINT = "/api/ai/vision/gallery-local"


def test_gallery_candidate_batches_use_local_embeddings(monkeypatch):
    monkeypatch.setattr(local_vision, "clip_available", lambda: True)
    monkeypatch.setattr(local_vision, "embed_text", lambda _: (1.0, 0.0))

    def embeddings(images):
        return {
            item_id: (1.0, 0.0) if item_id == "target" else (0.0, 1.0)
            for item_id in images if item_id != "unreadable"
        }

    def unexpected_provider_call(*_):
        raise AssertionError("A ranking batch must stay on the device")

    monkeypatch.setattr(local_vision, "embed_gallery_images", embeddings)
    monkeypatch.setattr(gallery_rank, "_completion", unexpected_provider_call)
    client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 55412))
    first = client.post(ENDPOINT, json={
        "queryPrompt": "a metal hex nut",
        "candidates": [{"id": f"other-{index}", "image": IMAGE} for index in range(16)],
    })
    last = client.post(ENDPOINT, json={
        "queryPrompt": "a metal hex nut",
        "candidates": [{"id": item_id, "image": IMAGE} for item_id in ["target", "unreadable"]],
    })

    assert first.status_code == last.status_code == 200
    assert len(first.json()["results"]) == 16
    assert last.json()["results"] == [{
        "id": "target", "score": 100, "imageSimilarity": 100, "contextRelevance": 100,
    }]
    assert all(result["score"] == 0 for result in first.json()["results"])


def test_gallery_ranking_requires_local_connection():
    client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("192.0.2.1", 55412))
    response = client.post(ENDPOINT, json={"queryPrompt": "wallet", "candidates": [{"id": "photo", "image": IMAGE}]})
    assert response.status_code == 403
    assert response.json()["code"] == "local_gallery_required"


def test_gallery_intent_sends_only_query_text(monkeypatch):
    def completion(role, messages):
        assert role == "llm"
        assert messages[1] == {"role": "user", "content": "작은 금색 로고가 있는 지갑"}
        return '{"prompt":"a wallet with a small gold logo"}'

    monkeypatch.setattr(gallery_rank, "_completion", completion)
    client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 55412))
    response = client.post("/api/ai/vision/gallery-intent", json={"query": "작은 금색 로고가 있는 지갑"})
    assert response.status_code == 200
    assert response.json()["prompt"] == "a wallet with a small gold logo"

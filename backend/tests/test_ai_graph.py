import json
from types import SimpleNamespace

from app import ai_graph, ai_pipeline, config, image_similarity, local_vision


IMAGE = "data:image/png;base64,YQ=="


def _state():
    return {
        "request": SimpleNamespace(
            references=[IMAGE],
            imageFeatures=["지갑"],
            query="지갑",
            candidates=[],
        ),
        "photo_images": {},
        "description_texts": {},
        "target_hints": "지갑",
        "basis": {},
        "vlm_multi": {},
        "computed": {},
        "notes": {},
        "scores": {},
        "source": "multimodal",
    }


def test_route_calls_vlm_census_only_on_configured_local_clip_path(monkeypatch):
    monkeypatch.setattr(config, "VLM_CROP_CENSUS", True)
    monkeypatch.setattr(config, "AI_SIMILARITY_PROVIDER", "local-clip")
    monkeypatch.setattr(image_similarity, "is_configured", lambda: True)
    monkeypatch.setattr(local_vision, "yoloe_available", lambda: True)
    monkeypatch.setattr(ai_graph, "_vlm_available", lambda: True)
    state = _state()
    state["photo_images"] = {"one": IMAGE}

    assert ai_graph._visual_route_after_fetch(state) == "census"

    monkeypatch.setattr(image_similarity, "is_configured", lambda: False)
    assert ai_graph._visual_route_after_fetch(state) == "fallback"

    monkeypatch.setattr(image_similarity, "is_configured", lambda: True)
    monkeypatch.setattr(config, "VLM_CROP_CENSUS", False)
    assert ai_graph._visual_route_after_fetch(state) == "select"


def test_vlm_census_maps_ids_back_to_images(monkeypatch):
    captured = {}
    public_image = "data:image/jpeg;base64,Yg=="

    def fake_completion(role, messages):
        captured["role"] = role
        captured["messages"] = messages
        return json.dumps({"results": [
            {"id": "r0", "objectCount": 1, "objectTypes": ["wallet"]},
            {"id": "c0", "objectCount": 2, "objectTypes": ["wallet", "key"]},
            {"id": "unknown", "objectCount": 9, "objectTypes": ["x", "y"]},
        ]})

    monkeypatch.setattr(ai_pipeline, "_completion", fake_completion)
    state = _state()
    state["photo_images"] = {"one": public_image}

    hints = ai_graph._visual_census(state)["vlm_multi"]

    assert captured["role"] == "vlm"
    assert captured["messages"][1]["content"][-1]["image_url"]["url"] == public_image
    assert hints == {IMAGE: False, public_image: True}


def test_vlm_census_failure_keeps_yolo_gating(monkeypatch):
    def fail(*_args, **_kwargs):
        raise ai_pipeline.AiPipelineError(503, "ai_not_configured", "not configured")

    monkeypatch.setattr(ai_pipeline, "_completion", fail)
    state = _state()
    state["photo_images"] = {"one": "data:image/jpeg;base64,Yg=="}

    assert ai_graph._visual_census(state) == {"vlm_multi": {}}


def test_embed_passes_vlm_flags_to_local_clip(monkeypatch):
    captured = {}

    def fake_score(texts, candidates, targets, vlm_multi=None):
        captured["vlm_multi"] = vlm_multi
        return {"one": 70}

    monkeypatch.setattr(image_similarity, "score_text_image_similarity", fake_score)
    monkeypatch.setattr(image_similarity, "crop_notes", lambda *_args, **_kwargs: {})
    state = _state()
    state["request"].references = []
    state["scoped"] = {"one": IMAGE}
    state["vlm_multi"] = {IMAGE: True}

    ai_graph._visual_embed(state)

    assert captured["vlm_multi"] == {IMAGE: True}

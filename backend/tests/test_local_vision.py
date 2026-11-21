import base64
import io

import pytest
from PIL import Image, ImageDraw

from app import config, image_similarity, local_vision


def _encode(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _data_url(size=(200, 200)):
    return _encode(Image.new("RGB", size, "red"))


def _busy_data_url(size=(200, 200)):
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    for offset in range(0, size[0], 20):
        draw.rectangle([offset, 0, offset + 10, size[1]], fill=(offset % 255, 60, 90))
    return _encode(image)


@pytest.fixture(autouse=True)
def clear_caches():
    for function in (
        local_vision.target_labels,
        local_vision.text_prompts,
        local_vision.scope_keywords,
        local_vision.crop_target,
        local_vision.embed_image,
        local_vision.embed_text,
    ):
        function.cache_clear()
    yield
    for function in (
        local_vision.target_labels,
        local_vision.text_prompts,
        local_vision.scope_keywords,
        local_vision.crop_target,
        local_vision.embed_image,
        local_vision.embed_text,
    ):
        function.cache_clear()


def test_target_labels_translate_korean_nouns_to_english():
    labels = local_vision.target_labels("딸기가 그려진 검은 지갑")

    assert set(labels) == {"wallet", "strawberry"}
    assert len(labels) <= 6


def test_target_labels_keep_english_features_and_drop_colors():
    labels = local_vision.target_labels("black leather wallet with strawberry drawing")

    assert "wallet" in labels
    assert "black" not in labels


def test_crop_target_without_labels_returns_original():
    original = _data_url()

    assert local_vision.crop_target(original, ()) == (original, False)


def test_crop_target_keeps_only_detected_bounding_box(monkeypatch):
    class FakeBoxes:
        cls = [0]
        conf = [0.9]
        xyxy = [[10, 10, 100, 100]]

        def __len__(self):
            return 1

    class FakeResult:
        boxes = FakeBoxes()
        names = {0: "wallet"}

    class FakeModel:
        def set_classes(self, labels):
            self.labels = labels

        def predict(self, image, **_kwargs):
            return [FakeResult()]

    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: FakeModel())
    cropped, changed = local_vision.crop_target(_busy_data_url(), ("wallet",))

    assert changed is True
    assert cropped.startswith("data:image/jpeg;base64,")
    with Image.open(io.BytesIO(base64.b64decode(cropped.split(",", 1)[1]))) as image:
        assert image.size == (99, 99)


def test_crop_target_falls_back_when_detector_fails(monkeypatch):
    class BrokenModel:
        def set_classes(self, _labels):
            raise RuntimeError("detector unavailable")

    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: BrokenModel())
    original = _busy_data_url()

    assert local_vision.crop_target(original, ("wallet",)) == (original, False)


def test_plain_background_skips_detector_entirely(monkeypatch):
    def fail_if_called():
        raise AssertionError("단순 배경이면 YOLOE를 호출하지 않아야 한다")

    monkeypatch.setattr(local_vision, "_yoloe_model", fail_if_called)
    original = _data_url()

    assert local_vision.crop_target(original, ("wallet",)) == (original, False)


def test_scope_candidates_only_keeps_category_matches():
    candidates = {"wallet-photo": "a", "desk-photo": "b", "unknown": "c"}
    texts = {
        "wallet-photo": "검은 가죽 지갑",
        "desk-photo": "책상과 컴퓨터",
        "unknown": "",
    }

    scoped = local_vision.scope_candidates(candidates, texts, "지갑")

    assert scoped == {"wallet-photo": "a", "unknown": "c"}


def test_text_similarity_uses_english_prompts_and_crops(monkeypatch):
    prompts = []

    def fake_embed_text(prompt):
        prompts.append(prompt)
        return (1.0, 0.0)

    monkeypatch.setattr(local_vision, "embed_text", fake_embed_text)
    monkeypatch.setattr(local_vision, "embed_image", lambda _image: (1.0, 0.0))
    monkeypatch.setattr(local_vision, "yoloe_available", lambda: True)
    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: None)
    monkeypatch.setattr(local_vision, "crop_target", lambda image, _labels: (image, False))

    scores = local_vision.score_text_image_similarity(
        ["딸기 그림", "지갑"], {"one": _data_url()}, "딸기가 그려진 지갑"
    )

    assert scores == {"one": 100}
    assert "a photo of wallet" in prompts
    assert "a photo of strawberry" in prompts


def test_clip_score_calibrates_typical_similarity_range():
    reference = (0.25, 0.9682458365518543)

    assert local_vision._score((1.0, 0.0), [reference]) == 43
    assert local_vision._score((1.0, 0.0), [(0.0, 1.0)]) == 0


def test_local_status_reports_crop_without_exposing_keys(monkeypatch):
    monkeypatch.setattr(config, "AI_SIMILARITY_PROVIDER", "local-clip")
    monkeypatch.setattr(config, "AI_SIMILARITY_API_KEY", "secret")
    monkeypatch.setattr(local_vision, "clip_available", lambda: True)
    monkeypatch.setattr(local_vision, "yoloe_available", lambda: True)

    role = image_similarity.status_payload()

    assert role["provider"] == "local-clip"
    assert role["available"] is True
    assert role["source"] == "vision-model"
    assert role["crop"]["enabled"] is True
    assert "secret" not in str(role)

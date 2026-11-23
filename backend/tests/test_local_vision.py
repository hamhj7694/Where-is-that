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


def _fake_model(detections):
    """(name, confidence, xyxy) 목록을 반환하는 YOLOE 대역."""
    class FakeBoxes:
        cls = [index for index, _ in enumerate(detections)]
        conf = [item[1] for item in detections]
        xyxy = [item[2] for item in detections]

        def __len__(self):
            return len(detections)

    class FakeResult:
        boxes = FakeBoxes()
        names = {index: item[0] for index, item in enumerate(detections)}

    class FakeModel:
        def set_classes(self, labels):
            self.labels = labels

        def predict(self, image, **_kwargs):
            return [FakeResult()]

    return FakeModel()


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
    # 지갑 + 열쇠 2개가 함께 찍힌 사진이면 지갑 박스만 남긴다.
    detections = [
        ("wallet", 0.9, [10, 10, 100, 100]),
        ("key", 0.8, [130, 130, 160, 160]),
    ]
    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: _fake_model(detections))
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


def test_single_object_photo_is_not_cropped(monkeypatch):
    # 객체가 하나뿐이면 호출은 했더라도 원본을 그대로 쓴다.
    detections = [("wallet", 0.9, [10, 10, 100, 100])]
    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: _fake_model(detections))
    original = _busy_data_url()

    assert local_vision.crop_target(original, ("wallet",)) == (original, False)


def test_two_object_types_trigger_crop(monkeypatch):
    detections = [
        ("wallet", 0.9, [10, 10, 100, 100]),
        ("key", 0.8, [120, 120, 150, 150]),
    ]
    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: _fake_model(detections))

    assert local_vision.needs_crop(Image.new("RGB", (200, 200)), ("wallet",)) is True


def test_single_object_type_does_not_trigger_crop(monkeypatch):
    detections = [("wallet", 0.9, [10, 10, 100, 100])]
    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: _fake_model(detections))

    assert local_vision.needs_crop(Image.new("RGB", (200, 200)), ("wallet",)) is False


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
    monkeypatch.setattr(local_vision, "crop_target", lambda image, _labels, _vlm=False: (image, False))

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


def test_image_score_does_not_saturate_same_category_photos():
    # 지갑 사진끼리는 코사인 0.8까지 올라간다. 텍스트 보정치를 쓰면 모두 100점이 된다.
    similar = (0.8, 0.6)
    identical = (1.0, 0.0)

    assert local_vision._score(identical, [similar], image=True) == 64
    assert local_vision._score(identical, [identical], image=True) == 100
    assert local_vision._score(identical, [similar]) == 100


def test_text_prompts_translate_korean_visual_features():
    prompts = local_vision.text_prompts(("검은 가죽 지갑",), "")

    assert "a photo of wallet" in prompts
    assert "a photo of wallet with black" in prompts
    assert "a photo of wallet with leather" in prompts


def test_text_prompts_translate_hayan_as_white():
    prompts = local_vision.text_prompts(("하얀색",), "하얀 신한카드 하얀색")

    assert "a photo of card with white" in prompts


def test_official_color_labels_map_to_standard_words():
    assert local_vision.colors_from_label("화이트(흰)") == ("white",)
    assert local_vision.colors_from_label("블랙(검정)") == ("black",)
    assert "teal" in local_vision.colors_from_label("시안(청록)")
    assert "blue" in local_vision.colors_from_label("딥스카이블루(새파란하늘)")
    assert local_vision.colors_from_label("") == ()


def test_requested_color_caps_generic_object_score(monkeypatch):
    """파란 카드에 '하얀 카드'라고 하면 카드 종류 점수만으로 1등급이 되지 않는다."""
    monkeypatch.setattr(local_vision, "yoloe_available", lambda: False)
    monkeypatch.setattr(local_vision, "embed_image", lambda _image: (1.0, 0.0))

    def fake_embed_text(prompt):
        return (0.0, 1.0) if " with white" in prompt else (1.0, 0.0)

    monkeypatch.setattr(local_vision, "embed_text", fake_embed_text)
    scores = local_vision.score_text_image_similarity(
        ["하얀색"], {"card": _data_url()}, "하얀 신한카드 하얀색"
    )

    assert scores == {"card": 0}


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


def test_vlm_multi_forces_crop_for_single_detection(monkeypatch):
    # YOLOE는 지갑 하나만 봤지만 VLM이 객체 종류 2가지라고 판정하면 자른다.
    monkeypatch.setattr(
        local_vision, "_yoloe_model",
        lambda: _fake_model([("wallet", 0.9, [10, 10, 100, 100])]),
    )
    original = _busy_data_url()

    cropped, changed = local_vision.crop_target(original, ("wallet",), True)

    assert changed is True
    assert cropped != original


def test_vlm_false_does_not_override_yolo_multi(monkeypatch):
    # VLM이 단일 객체라고 해도 YOLOE가 여러 객체를 보면 크롭을 유지한다(OR 조건).
    detections = [
        ("wallet", 0.9, [10, 10, 100, 100]),
        ("key", 0.8, [120, 120, 150, 150]),
    ]
    monkeypatch.setattr(local_vision, "_yoloe_model", lambda: _fake_model(detections))

    assert local_vision.crop_target(_busy_data_url(), ("wallet",), False)[1] is True


def test_vlm_flags_reach_clip_scoring(monkeypatch):
    seen: dict[str, bool] = {}

    def fake_crop(image, _labels, vlm=False):
        seen[image] = vlm
        return image, vlm

    monkeypatch.setattr(local_vision, "clip_available", lambda: True)
    monkeypatch.setattr(local_vision, "embed_text", lambda _prompt: (1.0, 0.0))
    monkeypatch.setattr(local_vision, "embed_image", lambda _image: (1.0, 0.0))
    monkeypatch.setattr(local_vision, "crop_target", fake_crop)
    image = _data_url()

    local_vision.score_text_image_similarity(["지갑"], {"one": image}, "지갑", {image: True})

    assert seen[image] is True

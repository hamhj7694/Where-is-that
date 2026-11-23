from app import config, web_reference


def test_enrich_adds_web_features_and_reference_photo(monkeypatch):
    monkeypatch.setattr(config, "WEB_REFERENCE_ENABLED", True)
    calls = []

    def fake_lookup(term):
        calls.append(term)
        return {
            "term": term,
            "features": [term, "흰색 동그란 캐릭터"],
            "image": "data:image/jpeg;base64,ZmFrZQ==",
        }

    monkeypatch.setattr(web_reference, "lookup", fake_lookup)
    features, references = web_reference.enrich(["치이카와", "카드"])

    assert calls == ["치이카와"]  # 일반 명사 '카드'는 웹에서 찾지 않는다
    assert "흰색 동그란 캐릭터" in features
    assert references == ["data:image/jpeg;base64,ZmFrZQ=="]


def test_enrich_uses_web_found_reference_photos(monkeypatch):
    monkeypatch.setattr(config, "WEB_REFERENCE_ENABLED", True)
    monkeypatch.setattr(web_reference, "lookup", lambda term: {
        "features": [term],
        "images": ["data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yg=="],
    })
    features, references = web_reference.enrich(["치이카와"])
    assert features == ["치이카와"]
    assert len(references) == 2


def test_enrich_keeps_existing_reference_photo(monkeypatch):
    monkeypatch.setattr(config, "WEB_REFERENCE_ENABLED", True)
    monkeypatch.setattr(web_reference, "lookup", lambda term: {})
    existing = ["data:image/jpeg;base64,b2xk"]
    features, references = web_reference.enrich(["짱구"], existing)
    assert features == ["짱구"]
    assert references == existing


def test_generic_terms_are_skipped():
    assert web_reference.is_generic("카드")
    assert web_reference.is_generic("하늘색")
    assert not web_reference.is_generic("치이카와")

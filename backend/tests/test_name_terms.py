from app import name_terms


def test_person_names_are_text_clues_only():
    assert name_terms.is_person_name("류진")
    assert name_terms.is_person_name("류영진")
    assert name_terms.is_person_name("김철수")


def test_characters_brands_and_objects_are_not_person_names():
    assert not name_terms.is_person_name("치이카와")
    assert not name_terms.is_person_name("하치와레")
    assert not name_terms.is_person_name("짱구")
    assert not name_terms.is_person_name("신한카드")
    assert not name_terms.is_person_name("카드")
    assert not name_terms.is_person_name("안경")
    assert not name_terms.is_person_name("하트")


def test_person_names_are_removed_from_visual_features_and_query():
    assert name_terms.without_person_names(["류진", "카드", "검정색"]) == ["카드", "검정색"]
    assert name_terms.strip_person_names("류진") == ""
    assert name_terms.strip_person_names("류진 지갑") == "지갑"
    assert name_terms.strip_person_names("치이카와 카드") == "치이카와 카드"

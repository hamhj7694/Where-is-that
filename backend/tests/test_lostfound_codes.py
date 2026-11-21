from __future__ import annotations

from app import lostfound_codes as codes


def _date(value: str) -> str:
    return value.replace("-", "")


def test_official_code_tables_cover_all_filter_dimensions():
    assert codes.CATEGORY_CODES["지갑 > 남성용 지갑"] == ("PRH000", "PRH200")
    assert codes.CATEGORY_CODES["지갑 > 여성용 지갑"] == ("PRH000", "PRH100")
    assert codes.CATEGORY_CODES["지갑 > 기타 지갑"] == ("PRH000", "PRH300")
    assert "CL1002" in codes.COLOR_CODES["블랙(검정)"]
    assert "CL1043" in codes.COLOR_CODES["블랙(검정)"]
    assert "CL1001" in codes.COLOR_CODES["화이트(흰)"]
    assert codes.REGION_CODES["서울"] == "LCA000"
    assert codes.REGION_CODES["제주"] == "LCP000"


def test_filters_become_official_api_params():
    assert codes.filter_param_sets(
        {"category": "지갑 > 남성용 지갑", "region": "서울", "from": "2026-01-01"},
        _date,
    ) == [{
        "PRDT_CL_CD_01": "PRH000",
        "PRDT_CL_CD_02": "PRH200",
        "N_FD_LCT_CD": "LCA000",
        "START_YMD": "20260101",
    }]


def test_black_expands_to_every_official_color_code():
    params = codes.filter_param_sets({"color": "블랙(검정)"}, _date)
    assert [entry["FD_COL_CD"] for entry in params] == list(codes.COLOR_CODES["블랙(검정)"])


def test_unknown_filter_value_falls_back_to_text_filter():
    assert codes.filter_param_sets({"color": "사용자정의색"}, _date) == []
    assert codes.filter_param_sets({}, _date) == []

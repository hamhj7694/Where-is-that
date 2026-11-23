"""UI 문자열을 경찰청 습득물 API 공식 코드로 바꾸는 매핑표.

공공데이터포털 getLosfundInfoAccToClAreaPd 계열 API의 실호출 결과로 확인했다.
코드가 없는 값은 매핑하지 않고 기존 텍스트 필터 폴백에 맡긴다.
"""

# "대분류 > 소분류" 전체 문자열 -> (대분류 코드, 소분류 코드).
CATEGORY_CODES: dict[str, tuple[str, str]] = {
    "가방 > 기타가방": ("PRA000", "PRA300"),
    "가방 > 남성용가방": ("PRA000", "PRA200"),
    "가방 > 여성용가방": ("PRA000", "PRA100"),
    "귀금속 > 귀걸이": ("PRO000", "PRO300"),
    "귀금속 > 목걸이": ("PRO000", "PRO200"),
    "귀금속 > 반지": ("PRO000", "PRO100"),
    "기타물품 > 기타": ("PRZ000", "PRZ100"),
    "기타물품 > 매장문화재": ("PRZ000", "PRZ200"),
    "도서용품 > 소설": ("PRB000", "PRB200"),
    "도서용품 > 컴퓨터서적": ("PRB000", "PRB300"),
    "도서용품 > 학습서적": ("PRB000", "PRB100"),
    "무주물 > 무주물": ("PRY000", "PRY100"),
    "산업용품 > 기타물품": ("PRD000", "PRD100"),
    "서류 > 기타물품": ("PRC000", "PRC200"),
    "서류 > 서류": ("PRC000", "PRC100"),
    "쇼핑백 > 쇼핑백": ("PRQ000", "PRQ100"),
    "스포츠용품 > 스포츠용품": ("PRE000", "PRE100"),
    "악기 > 건반악기": ("PRR000", "PRR100"),
    "악기 > 관악기": ("PRR000", "PRR200"),
    "유가증권 > 상품권": ("PRM000", "PRM200"),
    "유가증권 > 어음": ("PRM000", "PRM100"),
    "유류품 > 유류품": ("PRX000", "PRX100"),
    "의류 > 남성의류": ("PRK000", "PRK200"),
    "의류 > 아기의류": ("PRK000", "PRK300"),
    "의류 > 여성의류": ("PRK000", "PRK100"),
    "자동차 > 자동차번호판": ("PRF000", "PRF300"),
    "자동차 > 자동차열쇠": ("PRF000", "PRF100"),
    "전자기기 > MP3": ("PRG000", "PRG200"),
    "증명서 > 면허증": ("PRN000", "PRN200"),
    "증명서 > 신분증": ("PRN000", "PRN100"),
    "증명서 > 여권": ("PRN000", "PRN300"),
    "지갑 > 기타 지갑": ("PRH000", "PRH300"),
    "지갑 > 남성용 지갑": ("PRH000", "PRH200"),
    "지갑 > 여성용 지갑": ("PRH000", "PRH100"),
    "카드 > 기타카드": ("PRP000", "PRP300"),
    "카드 > 신용(체크)카드": ("PRP000", "PRP100"),
    "카드 > 일반카드": ("PRP000", "PRP200"),
    "컴퓨터 > LG노트북": ("PRI000", "PRI200"),
    "컴퓨터 > 삼성노트북": ("PRI000", "PRI100"),
    "현금 > 기타": ("PRL000", "PRL300"),
    "현금 > 수표": ("PRL000", "PRL200"),
    "현금 > 현금": ("PRL000", "PRL100"),
    "휴대폰 > LG휴대폰": ("PRJ000", "PRJ200"),
    "휴대폰 > 삼성휴대폰": ("PRJ000", "PRJ100"),
    "휴대폰 > 스카이휴대폰": ("PRJ000", "PRJ300"),
}

def is_category_term(term: str) -> bool:
    """'지갑'·'노트북'처럼 공식 분류명 그대로인 품목어인지 본다.

    '교촌 쇼핑백'처럼 분류명에 수식어가 붙은 표현은 해당하지 않는다.
    이런 말을 하드 필터로 쓰면 수식어가 적히지 않은 공개 원문을 놓친다.
    """
    value = term.strip().lower()
    if not value:
        return False
    return any(value in part for category in CATEGORY_CODES for part in category.split(" > ") if part)


# 색상 표시명 -> 공식 색상 코드 목록(같은 이름이 여러 코드로 나뉜다).
COLOR_CODES: dict[str, tuple[str, ...]] = {
    "그레이(암회)": ('CL1025',),
    "그레이(회)": ('CL1019', 'CL1020', 'CL1022', 'CL1024', 'CL1026', 'CL1027', 'CL1034', 'CL1035', 'CL1036', 'CL1037', 'CL1038', 'CL1039', 'CL1040', 'CL1041', 'CL1042',),
    "그린(초록)": ('CL1006', 'CL1014', 'CL1030', 'CL1065', 'CL1082',),
    "네온그린(형광초록)": ('CL1049',),
    "다크시안(어두운청록)": ('CL1083',),
    "딥스카이블루(새파란하늘)": ('CL1052', 'CL1068',),
    "라이트그레이(옅은회)": ('CL1021',),
    "라임(라임)": ('CL1048',),
    "레드(빨강)": ('CL1003', 'CL1012',),
    "레드(연한레드)": ('CL1059',),
    "레드(연한빨강)": ('CL1075',),
    "로열블루(밝은남)": ('CL1054', 'CL1070',),
    "마젠타(자홍)": ('CL1017',),
    "바이올렛(보라)": ('CL1009', 'CL1056', 'CL1072', 'CL1088',),
    "브라운(갈)": ('CL1008',),
    "블랙(검정)": ('CL1002', 'CL1043',),
    "블루(어두운파랑)": ('CL1071',),
    "블루(파랑)": ('CL1007', 'CL1016', 'CL1032', 'CL1055', 'CL1087',),
    "샤르트뢰즈(역녹)": ('CL1064', 'CL1080',),
    "스트롱시안(진한청록)": ('CL1067',),
    "시안(청록)": ('CL1031', 'CL1051',),
    "실버(은)": ('CL1023',),
    "씨그린(노르스름한녹)": ('CL1050', 'CL1066',),
    "알리자린(홍)": ('CL1028',),
    "에메랄드(선녹)": ('CL1081',),
    "엘로우(노랑)": ('CL1005', 'CL1013', 'CL1029',),
    "엘로우(밝은노랑)": ('CL1047', 'CL1063',),
    "오렌지(선명한오렌지)": ('CL1078',),
    "오렌지(연한오렌지)": ('CL1062',),
    "오렌지(주황)": ('CL1004',),
    "코럴(산호)": ('CL1044', 'CL1045', 'CL1060', 'CL1061', 'CL1077',),
    "코발트(밝은남)": ('CL1069',),
    "코발트(짙은청록)": ('CL1053', 'CL1085', 'CL1086',),
    "터키오이스(옥)": ('CL1015',),
    "퓨시아(자홍)": ('CL1057', 'CL1073', 'CL1089',),
    "피치오렌지(오렌지)": ('CL1046',),
    "핑크(분홍)": ('CL1011', 'CL1033',),
    "핑크(연한핑크)": ('CL1058', 'CL1074',),
    "화이트(흰)": ('CL1001', 'CL1018',),
}

# 17개 시도 -> 습득지역 코드.
REGION_CODES: dict[str, str] = {
    "서울": "LCA000",
    "부산": "LCT000",
    "대구": "LCR000",
    "인천": "LCV000",
    "광주": "LCQ000",
    "대전": "LCS000",
    "울산": "LCU000",
    "세종": "LCW000",
    "경기": "LCI000",
    "강원": "LCH000",
    "충북": "LCO000",
    "충남": "LCN000",
    "전북": "LCM000",
    "전남": "LCL000",
    "경북": "LCK000",
    "경남": "LCJ000",
    "제주": "LCP000",
}


def category_params(value: str) -> dict[str, str]:
    """분류 필터값을 API 파라미터로 바꾼다."""
    cleaned = (value or "").strip()
    if not cleaned:
        return {}
    codes = CATEGORY_CODES.get(cleaned)
    if codes:
        return {"PRDT_CL_CD_01": codes[0], "PRDT_CL_CD_02": codes[1]}
    # 소분류 코드가 없으면 대분류라도 적용한다.
    for name, (major, _minor) in CATEGORY_CODES.items():
        if name.startswith(cleaned + " >"):
            return {"PRDT_CL_CD_01": major}
    for name, (major, _minor) in CATEGORY_CODES.items():
        if cleaned.startswith(name.split(" >")[0] + " >"):
            return {"PRDT_CL_CD_01": major}
    return {}


def color_param_values(value: str) -> tuple[str, ...]:
    """색상 필터값에 해당하는 모든 코드를 반환한다."""
    return COLOR_CODES.get((value or "").strip(), ())


def region_param(value: str) -> str:
    """지역 필터값을 API 파라미터로 바꾼다."""
    cleaned = (value or "").strip()
    if not cleaned:
        return ""
    for name, code in REGION_CODES.items():
        if name in cleaned or cleaned in name:
            return code
    return ""


def filter_param_sets(filters: dict | None, date_format) -> list[dict[str, str]]:
    """UI 필터를 API 요청 파라미터 묶음으로 바꾼다(색상 코드가 여러 개면 각각 요청)."""
    values = filters if isinstance(filters, dict) else {}
    base: dict[str, str] = {}
    base.update(category_params(str(values.get("category") or "")))
    region = region_param(str(values.get("region") or ""))
    if region:
        base["N_FD_LCT_CD"] = region
    start = date_format(str(values.get("from") or ""))
    end = date_format(str(values.get("to") or ""))
    if start:
        base["START_YMD"] = start
    if end:
        base["END_YMD"] = end
    if not base and not color_param_values(str(values.get("color") or "")):
        return []
    colors = color_param_values(str(values.get("color") or ""))
    if colors:
        return [{**base, "FD_COL_CD": code} for code in colors]
    return [base]

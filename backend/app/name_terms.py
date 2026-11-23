"""사람 이름처럼 보이는 단어를 시각 단서에서 걸러낸다.

류진·류영진처럼 성씨로 시작하는 2~3글자 단어는 공개 원문(제목·설명·특이사항)에서
찾는 텍스트 단서다. 사진에서 그 글자를 읽은 근거가 없는데 시각 특징·웹 참고·사진 비교
프롬프트에 넣으면, 무관한 카드 사진이 "류진"과 90점으로 맞는다고 나온다.

성씨로 시작하는 색상어('하얀색', '노란색', '하늘색')도 사람이 아니므로 시각 특징으로 남긴다.
"""

from __future__ import annotations

import re

# 자주 쓰는 성씨. 2~3글자 단어가 이 중 하나로 시작하면 사람 이름 후보다.
SURNAMES = frozenset(
    "김이박최정강조윤장임한오서신권황안송전홍류유고문양손배백허남심노하곽성차주우구나지엄채원천방공현함변염여추도소석선설마길연위표명기반라사"
)

# 성씨로 시작하지만 사람 이름이 아닌 물건·색상·캐릭터.
NON_PERSON_TERMS = frozenset({
    "안경", "이불", "신발", "유리", "고무", "문구", "장난감", "박스", "김치",
    "오리", "고양이", "호랑이", "박쥐", "우산", "우표", "연필", "노트",
    "하트", "하늘", "남색", "백색", "유니콘", "이모지", "이모", "진주",
    "민트", "홍삼", "유아", "오락", "기관", "차량", "주머니", "우주",
    "지갑", "지우개", "지폐", "지도", "장갑", "반지",
    # 성씨로 시작해 사람 이름으로 오인되던 색상·재질 표현.
    "하얀", "노랑", "하늘색", "하늘빛", "남색", "홍색", "유색", "백색",
})

_NAME_PATTERN = re.compile(r"^[가-힣]{2,3}$")


def is_person_name(term: str) -> bool:
    """공개 원문에서만 써야 하는 사람 이름처럼 보이는 단어인지 판단한다."""
    value = term.strip()
    return (
        bool(_NAME_PATTERN.fullmatch(value))
        and value[0] in SURNAMES
        and value not in NON_PERSON_TERMS
        # '노란색', '하늘색'처럼 색상 접미어가 붙은 말은 사람 이름이 아니다.
        and not value.endswith(("색", "빛", "색상"))
    )


def without_person_names(terms: list[str] | tuple[str, ...]) -> list[str]:
    return [term for term in terms if isinstance(term, str) and not is_person_name(term)]


def strip_person_names(text: str) -> str:
    """시각 비교에 넘길 검색어에서 사람 이름만 떼어낸다."""
    return " ".join(
        token for token in (text or "").split()
        if not is_person_name(token)
    )

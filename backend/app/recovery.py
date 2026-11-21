from __future__ import annotations

RECOVERY_QUESTIONS = [
    "가장 기억에 남는 여행지는?",
    "어릴 적 별명은 무엇이었나요?",
    "첫 번째 반려동물의 이름은?",
    "가장 좋아하는 음식은?",
    "졸업한 학교 이름은?",
]


def normalize_answer(value: str) -> str:
    return " ".join(value.strip().lower().split())

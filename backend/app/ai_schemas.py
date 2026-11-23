from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .schemas import RequiredImageDataUrl

SearchMode = Literal["gallery", "lost", "direct"]


class AiSearchRequest(BaseModel):
    mode: SearchMode
    query: str = Field(default="", max_length=300)
    images: list[RequiredImageDataUrl] = Field(default_factory=list, max_length=6)
    filters: dict[str, str] = Field(default_factory=dict, max_length=12)
    externalProcessingConfirmed: bool = False

    @field_validator("filters")
    @classmethod
    def validate_filters(cls, value: dict[str, str]) -> dict[str, str]:
        if any(len(key) > 40 or len(item) > 100 for key, item in value.items()):
            raise ValueError("검색 조건을 확인해 주세요.")
        return value

    @model_validator(mode="after")
    def validate_search_input(self) -> AiSearchRequest:
        if not self.query.strip() and not self.images:
            raise ValueError("검색어 또는 참고 사진을 입력해 주세요.")
        if not self.externalProcessingConfirmed:
            raise ValueError("외부 AI 전송에 동의해 주세요.")
        return self


class AiRankCandidate(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    image: RequiredImageDataUrl


class AiRankRequest(BaseModel):
    mode: SearchMode
    query: str = Field(default="", max_length=300)
    references: list[RequiredImageDataUrl] = Field(default_factory=list, max_length=6)
    candidates: list[AiRankCandidate] = Field(min_length=1, max_length=12)
    externalProcessingConfirmed: bool = False

    @model_validator(mode="after")
    def validate_consent_and_query(self) -> AiRankRequest:
        if not self.externalProcessingConfirmed:
            raise ValueError("외부 AI 전송에 동의해 주세요.")
        if not self.query.strip() and not self.references:
            raise ValueError("검색어 또는 참고 사진을 입력해 주세요.")
        return self


class AiContextCandidate(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(default="", max_length=200)
    subject: str = Field(default="", max_length=1000)
    notes: str = Field(default="", max_length=2000)
    category: str = Field(default="", max_length=100)
    color: str = Field(default="", max_length=50)
    foundDate: str = Field(default="", max_length=20)
    foundTime: str = Field(default="", max_length=20)
    foundPlace: str = Field(default="", max_length=200)
    storagePlace: str = Field(default="", max_length=200)
    orgName: str = Field(default="", max_length=200)
    address: str = Field(default="", max_length=300)
    status: str = Field(default="", max_length=80)
    keepType: str = Field(default="", max_length=80)
    placeName: str = Field(default="", max_length=200)
    placeAddress: str = Field(default="", max_length=300)
    placeRoadAddress: str = Field(default="", max_length=300)
    placeCategory: str = Field(default="", max_length=100)


class AiContextRankRequest(BaseModel):
    originalQuery: str = Field(default="", max_length=300)
    searchQuery: str = Field(default="", max_length=300)
    imageDescriptions: list[str] = Field(default_factory=list, max_length=6)
    filters: dict[str, str] = Field(default_factory=dict, max_length=12)
    candidates: list[AiContextCandidate] = Field(min_length=1, max_length=12)
    candidateDataProcessingConfirmed: bool = False

    @field_validator("imageDescriptions")
    @classmethod
    def validate_image_descriptions(cls, value: list[str]) -> list[str]:
        if any(len(item) > 300 for item in value):
            raise ValueError("검색 사진 설명을 확인해 주세요.")
        return value

    @field_validator("filters")
    @classmethod
    def validate_context_filters(cls, value: dict[str, str]) -> dict[str, str]:
        if any(len(key) > 40 or len(item) > 100 for key, item in value.items()):
            raise ValueError("검색 조건을 확인해 주세요.")
        return value

    @model_validator(mode="after")
    def validate_consent_query_and_candidates(self) -> AiContextRankRequest:
        if not self.candidateDataProcessingConfirmed:
            raise ValueError("후보 정보의 외부 AI 분석에 동의해 주세요.")
        if not self.originalQuery.strip() and not self.searchQuery.strip() and not self.imageDescriptions:
            raise ValueError("검색어나 참고 사진 특징이 필요해요.")
        ids = [candidate.id for candidate in self.candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("후보 식별자가 중복됐어요.")
        return self


class AiChannelPlan(BaseModel):
    query: str = Field(max_length=100)
    keywords: list[str] = Field(default_factory=list, max_length=12)


class AiSearchCriteria(BaseModel):
    """자연어·사진에서 분리해 공개 API 응답 JSON에 적용하는 맞춤 검색 조건."""

    apiKeywords: list[str] = Field(default_factory=list, max_length=3)
    include: list[str] = Field(default_factory=list, max_length=8)
    any: list[str] = Field(default_factory=list, max_length=8)
    exclude: list[str] = Field(default_factory=list, max_length=8)
    imageFeatures: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("apiKeywords", "include", "any", "exclude", "imageFeatures")
    @classmethod
    def validate_terms(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            term = re.sub(r"\s+", " ", item.strip())[:40]
            if term and term not in cleaned:
                cleaned.append(term)
        return cleaned


class AiFilters(BaseModel):
    category: str = Field(default="", max_length=60)
    region: str = Field(default="", max_length=30)
    view: str = Field(default="", max_length=30)
    fromDate: str = Field(default="", max_length=10)
    toDate: str = Field(default="", max_length=10)


class AiSearchPlan(BaseModel):
    originalQuery: str = Field(max_length=300)
    imageDescriptions: list[str] = Field(default_factory=list, max_length=6)
    channels: dict[Literal["combined", "image", "context"], AiChannelPlan]
    filters: AiFilters = Field(default_factory=AiFilters)
    criteria: AiSearchCriteria = Field(default_factory=AiSearchCriteria)
    clarificationQuestions: list[str] = Field(default_factory=list, max_length=3)


class AiRankedCandidate(BaseModel):
    """score=종합 관련성, imageSimilarity=이미지 유사도, contextRelevance=맥락 관련성."""

    id: str
    score: int = Field(ge=0, le=100)
    imageSimilarity: int = Field(ge=0, le=100)
    contextRelevance: int = Field(ge=0, le=100)
    reasons: list[str] = Field(default_factory=list, max_length=4)

    @model_validator(mode="before")
    @classmethod
    def fill_axis_scores(cls, value: object) -> object:
        # 이전 프롬프트/응답은 score만 보냈다. 누락된 축은 종합 점수로 채워 호환성을 유지한다.
        if isinstance(value, dict) and "score" in value:
            filled = dict(value)
            filled.setdefault("imageSimilarity", filled["score"])
            filled.setdefault("contextRelevance", filled["score"])
            return filled
        return value


class AiRankResponse(BaseModel):
    results: list[AiRankedCandidate]
    # 참고 사진에서 AI가 읽은 대상·요소 설명(검색 문장과 함께 3축 채점에 반영).
    referenceDescriptions: list[str] = Field(default_factory=list, max_length=6)
    # 이미지 유사도를 전용 비전 임베딩으로 계산했는지, 멀티모달 추론에 맡겼는지.
    imageSimilaritySource: Literal["vision-model", "multimodal"] = "multimodal"

    @field_validator("referenceDescriptions")
    @classmethod
    def validate_reference_descriptions(cls, value: list[str]) -> list[str]:
        if any(len(item) > 300 for item in value):
            raise ValueError("참고 사진 분석 내용을 확인해 주세요.")
        return value


class AiVisualMatchCandidate(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    # 사진이 없는 공개 항목도 설명만으로 점수를 받을 수 있도록 둘 다 허용한다.
    imageUrl: str = Field(default="", max_length=500)
    text: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_candidate_payload(self) -> AiVisualMatchCandidate:
        if not self.imageUrl and not self.text.strip():
            raise ValueError("사진 주소 또는 설명이 있는 후보만 분석할 수 있어요.")
        return self


class AiVisualMatchRequest(BaseModel):
    query: str = Field(default="", max_length=300)
    imageFeatures: list[str] = Field(default_factory=list, max_length=8)
    references: list[RequiredImageDataUrl] = Field(default_factory=list, max_length=6)
    candidates: list[AiVisualMatchCandidate] = Field(min_length=1, max_length=12)
    externalProcessingConfirmed: bool = False
    # 서버 내부에서 이미 웹 참고를 붙였으면 중복 검색하지 않는다.
    webReferenceApplied: bool = False

    @model_validator(mode="after")
    def validate_visual_match_input(self) -> AiVisualMatchRequest:
        if not self.externalProcessingConfirmed:
            raise ValueError("외부 AI 전송에 동의해 주세요.")
        features = [term.strip()[:40] for term in self.imageFeatures if isinstance(term, str) and term.strip()]
        if not features and not self.query.strip() and not self.references:
            raise ValueError("검색어 또는 시각 특징이 필요해요.")
        self.imageFeatures = list(dict.fromkeys(features))[:8]
        return self


class AiVisualMatchResult(BaseModel):
    id: str
    imageSimilarity: int = Field(ge=0, le=100)
    # photo=공개 사진을 분석, description=사진 없이 설명 텍스트를 분석.
    basis: Literal["photo", "description"] = "photo"
    reason: str = Field(default="", max_length=160)


class AiVisualMatchResponse(BaseModel):
    results: list[AiVisualMatchResult]
    source: Literal["vision-model", "multimodal"]
    usedFeatures: list[str] = Field(default_factory=list, max_length=8)


class AiContextRankedCandidate(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    score: int = Field(ge=0, le=100)
    reasons: list[str] = Field(min_length=1, max_length=4)
    locationRelation: Literal["direct_match", "possible_nearby", "regional_context", "uncertain", "not_applicable"]
    locationEvidence: str = Field(default="", max_length=240)
    uncertainty: str = Field(min_length=1, max_length=240)

    @model_validator(mode="after")
    def validate_location_evidence(self) -> AiContextRankedCandidate:
        if self.locationRelation != "not_applicable" and not self.locationEvidence.strip():
            raise ValueError("장소 관계의 근거가 필요해요.")
        return self


class AiContextRankResponse(BaseModel):
    results: list[AiContextRankedCandidate] = Field(min_length=1, max_length=12)

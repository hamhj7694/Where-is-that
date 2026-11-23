from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, field_validator

EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
IMAGE_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$")
REMOTE_IMAGE_URL = re.compile(r"^https://[^\s]+$|^http://[^\s]+$")
MAX_IMAGE_VALUE_LENGTH = 12_000_000
ACCOUNT_DELETE_CONFIRMATION = "계정을 탈퇴합니다"


def _image_data_url(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if len(value) > MAX_IMAGE_VALUE_LENGTH or not IMAGE_DATA_URL.fullmatch(value):
        raise ValueError("이미지 데이터를 확인해 주세요.")
    return value


def _required_image_data_url(value: str) -> str:
    checked = _image_data_url(value)
    if not checked:
        raise ValueError("이미지 데이터를 확인해 주세요.")
    return checked


ImageDataUrl = Annotated[str | None, AfterValidator(_image_data_url)]
RequiredImageDataUrl = Annotated[str, AfterValidator(_required_image_data_url)]


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_PATTERN.fullmatch(email):
        raise ValueError("올바른 이메일 주소를 입력해 주세요.")
    return email


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=64)
    nickname: str | None = Field(default=None, max_length=20)
    recoveryQuestion: str = Field(min_length=1, max_length=100)
    recoveryAnswer: str = Field(min_length=2, max_length=100)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("nickname")
    @classmethod
    def validate_nickname(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return normalize_email(value)


class KakaoStartRequest(BaseModel):
    returnTo: str = Field(default="/valuables", max_length=256)


class KakaoCallbackRequest(BaseModel):
    code: str = Field(min_length=1, max_length=512)
    state: str = Field(min_length=1, max_length=256)


class KakaoUser(BaseModel):
    id: str
    nickname: str
    email: str
    profileImage: str = ""


class FindEmailRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=20)
    recoveryQuestion: str = Field(min_length=1, max_length=100)
    recoveryAnswer: str = Field(min_length=2, max_length=100)


class ResetPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    recoveryQuestion: str = Field(min_length=1, max_length=100)
    recoveryAnswer: str = Field(min_length=2, max_length=100)
    newPassword: str = Field(min_length=8, max_length=64)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return normalize_email(value)


class UserResponse(BaseModel):
    id: int
    email: str
    nickname: str
    provider: str = "local"
    created_at: str
    profile_image: str = ""
    last_visit_at: str | None = None


class KakaoCallbackResponse(BaseModel):
    user: UserResponse
    returnTo: str


class ProfileUpdateRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=20)
    profileImage: str = Field(default="", max_length=MAX_IMAGE_VALUE_LENGTH)

    @field_validator("nickname")
    @classmethod
    def validate_nickname(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("닉네임을 입력해 주세요.")
        return cleaned

    @field_validator("profileImage")
    @classmethod
    def validate_profile_image(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            return ""
        if cleaned.startswith("data:"):
            return _required_image_data_url(cleaned)
        if not REMOTE_IMAGE_URL.fullmatch(cleaned) or len(cleaned) > 1000:
            raise ValueError("프로필 이미지를 확인해 주세요.")
        return cleaned


class DeleteAccountRequest(BaseModel):
    confirmation: str = Field(max_length=100)


class ContentImageFile(BaseModel):
    name: str = Field(max_length=200)
    dataUrl: RequiredImageDataUrl


class ContentPhoto(BaseModel):
    id: str = Field(max_length=120)
    name: str = Field(max_length=200)
    dataUrl: ImageDataUrl = None
    sampleUrl: str | None = Field(default=None, max_length=500)
    kind: Literal["photo", "screenshot"] = "photo"
    photoView: str | None = Field(default=None, max_length=20)
    path: str | None = Field(default=None, max_length=500)
    updatedAt: int | None = None


class ContentValuable(BaseModel):
    id: str = Field(max_length=120)
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=2000)
    category: str = Field(default="기타", max_length=50)
    status: Literal["kept", "lost", "found"]
    photos: list[ContentPhoto] = Field(default_factory=list, max_length=200)
    createdAt: int | None = None
    viewedAt: int | None = None
    updatedAt: int


class ContentDraft(BaseModel):
    query: str = Field(default="", max_length=4000)
    photoDataUrl: ImageDataUrl = None
    photoName: str = Field(default="", max_length=200)
    photos: list[ContentImageFile] = Field(default_factory=list, max_length=6)
    photoViews: list[str] = Field(default_factory=list, max_length=6)


class ContentGallery(BaseModel):
    name: str = Field(max_length=200)
    files: list[ContentImageFile] = Field(default_factory=list, max_length=300)


class ContentRecord(BaseModel):
    id: str = Field(max_length=120)
    mode: Literal["gallery", "lost"]
    createdAt: int
    draft: ContentDraft
    gallery: ContentGallery | None = None
    assistant: dict[str, Any] | None = None
    parentRecordId: str | None = Field(default=None, max_length=120)
    assistantBaseQuery: str | None = Field(default=None, max_length=4000)

    @field_validator("assistant")
    @classmethod
    def validate_assistant(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and len(json.dumps(value, ensure_ascii=False)) > 100_000:
            raise ValueError("검색 도우미 정보를 확인해 주세요.")
        return value


class ContentPayload(BaseModel):
    valuables: list[ContentValuable] = Field(default_factory=list, max_length=500)
    records: list[ContentRecord] = Field(default_factory=list, max_length=500)


class LostFoundSearchRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)
    page: int = Field(default=1, ge=1, le=100)
    rows: int = Field(default=20, ge=1, le=40)
    hints: dict[str, Any] | None = None

    @field_validator("hints")
    @classmethod
    def validate_hints(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and len(json.dumps(value, ensure_ascii=False)) > 4000:
            raise ValueError("검색 조건을 확인해 주세요.")
        return value


class LostFoundListRequest(BaseModel):
    page: int = Field(default=1, ge=1, le=100)
    rows: int = Field(default=20, ge=1, le=40)


class LostFoundBrowseRequest(BaseModel):
    """직접 찾기: 필터와 AI 조건을 서버 전체 스캔에 적용한 뒤 페이지를 돌려준다."""

    keyword: str = Field(default="", max_length=100)
    page: int = Field(default=1, ge=1, le=1000)
    rows: int = Field(default=40, ge=1, le=40)
    maxPages: int = Field(default=200, ge=1, le=1000)
    hints: dict[str, Any] | None = None
    filters: dict[str, str] = Field(default_factory=dict)
    # 더 찾아보기: 이미 분석한 최신 사진 수만큼 건너뛰고 오래된 사진을 본다.
    skipVisual: int = Field(default=0, ge=0, le=600)
    # 앞선 탐색에서 이미 찾은 사진 점수. 새 탐색에서 사라지지 않도록 되살린다.
    priorVisualScores: dict[str, int] = Field(default_factory=dict, max_length=200)

    @field_validator("hints")
    @classmethod
    def validate_browse_hints(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and len(json.dumps(value, ensure_ascii=False)) > 4000:
            raise ValueError("검색 조건을 확인해 주세요.")
        return value

    @field_validator("filters")
    @classmethod
    def validate_browse_filters(cls, value: dict[str, str]) -> dict[str, str]:
        allowed = {"category", "color", "region", "from", "to"}
        cleaned: dict[str, str] = {}
        for key, item in value.items():
            if key in allowed and isinstance(item, str) and len(item.strip()) <= 100:
                cleaned[key] = item.strip()
        return cleaned


class AiMatchInfo(BaseModel):
    """공개 JSON에 AI 맞춤 조건을 적용한 결과(근거·AND 충족 여부)."""

    hits: list[str] = Field(default_factory=list)
    allInclude: bool = False


class FoundItem(BaseModel):
    id: str
    source: Literal["police", "portal"]
    atcId: str
    fdSn: str
    name: str
    subject: str = ""
    category: str = ""
    color: str = ""
    imageUrl: str | None = None
    foundDate: str = ""
    foundTime: str = ""
    foundPlace: str = ""
    storagePlace: str = ""
    orgId: str = ""
    orgName: str = ""
    tel: str = ""
    status: str = ""
    keepType: str = ""
    notes: str = ""
    address: str = ""
    mapQuery: str = ""
    matchScore: float = 0
    matchTier: int = 5
    matchLabel: str = ""
    visualScore: int | None = None
    detailLoaded: bool = False
    display: dict[str, str] = Field(default_factory=dict)
    aiMatch: AiMatchInfo | None = None


class PlaceInfo(BaseModel):
    """카카오 Local API가 주는 보관기관 장소 정보(영업시간 필드는 없음)."""

    name: str = ""
    phone: str = ""
    address: str = ""
    roadAddress: str = ""
    category: str = ""
    placeUrl: str | None = None
    openingHours: str | None = None


class FoundItemDetail(FoundItem):
    lat: float | None = None
    lng: float | None = None
    mapUrl: str | None = None
    place: PlaceInfo | None = None


class LostFoundSearchResponse(BaseModel):
    query: str
    sources: list[str] = Field(default_factory=list)
    total: int = 0
    items: list[FoundItem] = Field(default_factory=list)
    errors: list[dict[str, Any]] = Field(default_factory=list)
    apiKeywords: list[str] = Field(default_factory=list)
    matched: int = 0


class LostFoundBrowseResponse(LostFoundSearchResponse):
    page: int = 1
    rows: int = 40
    scanned: int = 0
    pagesScanned: int = 0
    filterApi: bool = False
    scanLimitReached: bool = False
    criteriaApplied: bool = False
    filtersApplied: dict[str, str] = Field(default_factory=dict)
    visualAnalyzed: bool = False
    visualScanned: int = 0
    visualMore: bool = False


class BrowseJobStart(BaseModel):
    """직접 찾기 백그라운드 작업 시작 응답."""

    jobId: str
    status: str = "pending"


class BrowseJobStatus(BaseModel):
    """백그라운드 작업 진행 상태. 끝나면 result에 완성된 목록이 들어간다."""

    jobId: str
    status: str
    result: LostFoundBrowseResponse | None = None
    error: str | None = None
    visualScanned: int = 0
    visualTotal: int = 0
    visualMore: bool = False


class MapConfigResponse(BaseModel):
    javascriptKey: str = ""
    available: bool = False


class OriginRequest(BaseModel):
    query: str = Field(min_length=1, max_length=100)


class OriginResponse(BaseModel):
    name: str
    lat: float
    lng: float
    address: str = ""


class RouteRequest(BaseModel):
    originLat: float = Field(ge=-90, le=90)
    originLng: float = Field(ge=-180, le=180)
    destinationLat: float = Field(ge=-90, le=90)
    destinationLng: float = Field(ge=-180, le=180)
    destinationName: str = Field(default="보관기관", min_length=1, max_length=100)
    originName: str = Field(default="현재 위치", min_length=1, max_length=100)


class RouteResponse(BaseModel):
    distance: int
    duration: int
    mapUrl: str
    path: list[list[float]] = Field(default_factory=list)

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


def _data_dir() -> Path:
    configured = os.environ.get("GEUGEO_DATA_DIR", "").strip()
    return Path(configured) if configured else BACKEND_DIR / "data"


DATA_DIR = _data_dir()
DB_PATH = DATA_DIR / "app.db"


def _allowed_origins() -> list[str]:
    raw = os.environ.get(
        "GEUGEO_ALLOWED_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173",
    )
    return [item.strip() for item in raw.split(",") if item.strip()]


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


ALLOWED_ORIGINS = _allowed_origins()
SESSION_COOKIE_NAME = "geugeo_eodi_session"
SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14
COOKIE_SECURE = os.environ.get("GEUGEO_COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
MAX_CONTENT_BYTES = 64 * 1024 * 1024

# REST·서비스키는 서버 전용. JS 키만 사용자 승인(DML-074)으로 클라이언트에 전달한다.
KAKAO_JAVASCRIPT_KEY = os.environ.get("KAKAO_JAVASCRIPT_KEY", "").strip()
KAKAO_REST_API_KEY = os.environ.get("KAKAO_REST_API_KEY", "").strip()
KAKAO_CLIENT_SECRET = os.environ.get("KAKAO_CLIENT_SECRET", "").strip()
KAKAO_REDIRECT_URI = (
    os.environ.get("KAKAO_REDIRECT_URI", "").strip()
    or "http://127.0.0.1:5173/auth/kakao/callback"
)
KAKAO_STATE_COOKIE = "geugeo_kakao_state"
KAKAO_STATE_MAX_AGE_SECONDS = 10 * 60

# 카카오와 동일하게 경찰청 서비스키도 서버 .env에만 둔다.
POLICE_SERVICE_KEY = os.environ.get("POLICE_SERVICE_KEY", "").strip()
# 공개 API가 느려질 때 8초로는 대부분 502가 됐다. 실제 응답을 기다릴 만큼 늘린다.
POLICE_API_TIMEOUT = _float_env("POLICE_API_TIMEOUT", 45.0)
# 직접 찾기 전체 스캔은 페이지별 요청이 많다. 연결 재사용 + 제한된 동시성으로
# 공개 API에 무리를 주지 않으면서 스캔 시간을 줄인다.
POLICE_API_MAX_CONNECTIONS = max(2, _int_env("GEUGEO_POLICE_API_MAX_CONNECTIONS", 16))
BROWSE_MAX_WORKERS = max(2, min(32, _int_env("GEUGEO_BROWSE_MAX_WORKERS", 12)))
# 공개 API가 느려지면 200페이지 스캔이 몇 분씩 걸려 화면이 로딩에서 나오지 않는다.
# 직접 찾기는 한 번에 이만큼만 읽고 나머지는 다음 요청에서 이어서 가져온다.
LOSTFOUND_BROWSE_PAGE_CAP = max(1, _int_env("GEUGEO_LOSTFOUND_BROWSE_PAGE_CAP", 8))
# 전용 필터 API는 서버에서 분류·지역·색상·기간을 좁혀 주므로 이름 검색보다 넓게 스캔한다.
# 0이면 필터 결과의 마지막 페이지까지 모두 읽는다.
LOSTFOUND_MAX_PAGES = max(0, _int_env("GEUGEO_LOSTFOUND_MAX_PAGES", 200))
LOSTFOUND_SEARCH_MAX_PAGES = 100
LOSTFOUND_SEARCH_TTL = _int_env("LOSTFOUND_SEARCH_TTL", 300)
LOSTFOUND_DETAIL_TTL = _int_env("LOSTFOUND_DETAIL_TTL", 86400)
GEO_CACHE_TTL = _int_env("GEO_CACHE_TTL", 2592000)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
AI_LLM_PROVIDER = os.environ.get("GEUGEO_AI_LLM_PROVIDER", "openai-compatible").strip().lower()
AI_LLM_API_KEY = os.environ.get("GEUGEO_AI_LLM_API_KEY", "").strip() or OPENAI_API_KEY
AI_LLM_BASE_URL = os.environ.get("GEUGEO_AI_LLM_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
AI_LLM_MODEL = os.environ.get("GEUGEO_AI_LLM_MODEL", "gpt-6-luna").strip()
AI_VLM_PROVIDER = os.environ.get("GEUGEO_AI_VLM_PROVIDER", "openai-compatible").strip().lower()
AI_VLM_API_KEY = os.environ.get("GEUGEO_AI_VLM_API_KEY", "").strip() or OPENAI_API_KEY
AI_VLM_BASE_URL = os.environ.get("GEUGEO_AI_VLM_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
AI_VLM_MODEL = os.environ.get("GEUGEO_AI_VLM_MODEL", "gpt-6-luna").strip()
AI_VISION_PROVIDER = os.environ.get("GEUGEO_AI_VISION_PROVIDER", "openai-compatible").strip().lower()
AI_VISION_API_KEY = os.environ.get("GEUGEO_AI_VISION_API_KEY", "").strip() or OPENAI_API_KEY
AI_VISION_BASE_URL = os.environ.get("GEUGEO_AI_VISION_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
AI_VISION_MODEL = os.environ.get("GEUGEO_AI_VISION_MODEL", "gpt-6-luna").strip()

# 멀티모달 한 역할이 자연어·이미지·자연어+이미지 joint 해석을 모두 맡는다.
# 기존 LLM/VLM/VISION 설정은 호환용 별칭으로 남기고, 새 설정이 우선한다.
AI_MULTIMODAL_PROVIDER = os.environ.get("GEUGEO_AI_MULTIMODAL_PROVIDER", "openai-compatible").strip().lower()
AI_MULTIMODAL_API_KEY = os.environ.get("GEUGEO_AI_MULTIMODAL_API_KEY", "").strip() or AI_VLM_API_KEY or OPENAI_API_KEY
AI_MULTIMODAL_BASE_URL = (
    os.environ.get("GEUGEO_AI_MULTIMODAL_BASE_URL", "").strip().rstrip("/")
    or AI_VLM_BASE_URL
)
AI_MULTIMODAL_MODEL = os.environ.get("GEUGEO_AI_MULTIMODAL_MODEL", "").strip() or AI_VLM_MODEL or "gpt-6-luna"

# 이미지 유사도만 추적하는 전용 비전. 미설정(none)이면 멀티모달 점수를 그대로 사용한다.
# local-clip은 사전학습 가중치를 서버에서 직접 띄운다(별도 학습 불필요).
AI_SIMILARITY_PROVIDER = os.environ.get("GEUGEO_AI_SIMILARITY_PROVIDER", "local-clip").strip().lower()
AI_SIMILARITY_API_KEY = os.environ.get("GEUGEO_AI_SIMILARITY_API_KEY", "").strip() or OPENAI_API_KEY
AI_SIMILARITY_BASE_URL = (
    os.environ.get("GEUGEO_AI_SIMILARITY_BASE_URL", "").strip().rstrip("/")
    or "https://api.openai.com/v1"
)
AI_SIMILARITY_MODEL = os.environ.get("GEUGEO_AI_SIMILARITY_MODEL", "").strip()
AI_SIMILARITY_INPUT_STYLE = os.environ.get("GEUGEO_AI_SIMILARITY_INPUT_STYLE", "image_url").strip().lower()
AI_SIMILARITY_TIMEOUT = _float_env("GEUGEO_AI_SIMILARITY_TIMEOUT", 20.0)

# 로컬 사전학습 비전: YOLOE가 관심 물건만 크롭하고 CLIP이 벡터 유사도를 계산한다.
# 별도 파인튜닝 없이 공개 가중치만 사용한다.
LOCAL_VISION_ENABLED = os.environ.get("GEUGEO_LOCAL_VISION_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
LOCAL_CLIP_MODEL = os.environ.get("GEUGEO_LOCAL_CLIP_MODEL", "ViT-B-32").strip() or "ViT-B-32"
LOCAL_CLIP_PRETRAINED = os.environ.get("GEUGEO_LOCAL_CLIP_PRETRAINED", "laion2b_s34b_b79k").strip() or "laion2b_s34b_b79k"
LOCAL_CLIP_BATCH_SIZE = max(1, _int_env("GEUGEO_LOCAL_CLIP_BATCH_SIZE", 16))
YOLOE_ENABLED = os.environ.get("GEUGEO_YOLOE_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
YOLOE_MODEL = os.environ.get("GEUGEO_YOLOE_MODEL", "").strip() or str(DATA_DIR / "models" / "yoloe-11s-seg.pt")
YOLOE_CONFIDENCE = _float_env("GEUGEO_YOLOE_CONFIDENCE", 0.12)
YOLOE_MAX_DETECTIONS = max(1, _int_env("GEUGEO_YOLOE_MAX_DETECTIONS", 10))
# 사진에 객체가 여러 개(또는 여러 종류)일 때만 타깃을 크롭한다.
# 단일 객체 사진은 원본이 이미 관심 물건이므로 자르지 않는다.
CROP_MIN_OBJECTS = max(1, _int_env("GEUGEO_CROP_MIN_OBJECTS", 2))
CROP_MIN_OBJECT_TYPES = max(1, _int_env("GEUGEO_CROP_MIN_OBJECT_TYPES", 2))
# 객체 수·종류를 셀 때는 일반 탐지보다 높은 신뢰도를 써 오탐으로 크롭하지 않게 한다.
CROP_CENSUS_CONFIDENCE = _float_env("GEUGEO_CROP_CENSUS_CONFIDENCE", 0.25)
# 물건이 이미 화면 대부분을 차지하면 크롭 대신 원본을 쓴다.
CROP_MAX_BOX_RATIO = _float_env("GEUGEO_CROP_MAX_BOX_RATIO", 0.60)
# YOLOE가 놓친 '서로 다른 객체 종류'를 VLM이 사진별로 판정해 OR 조건에 더한다.
# 한 번의 멀티모달 호출로 후보 사진 전체를 세고, 실패하면 YOLOE 게이팅만 쓴다.
VLM_CROP_CENSUS = _bool_env("GEUGEO_VLM_CROP_CENSUS", True)
# 사진 없이 텍스트 특징만으로 비교할 때 CLIP 점수가 평평하면 멀티모달 폴백을 쓴다.
# 실측에서 짧은 한국어 설명은 대부분 같은 '지갑' 프롬프트로 수렴해 순위가 무작위였다.
TEXT_FALLBACK_MAX_SCORE = _int_env("GEUGEO_TEXT_FALLBACK_MAX_SCORE", 70)
TEXT_FALLBACK_MIN_GAP = _int_env("GEUGEO_TEXT_FALLBACK_MIN_GAP", 5)
VISUAL_MATCH_MAX_COMPARE = max(1, _int_env("GEUGEO_VISUAL_MATCH_MAX_COMPARE", 8))

# 공개 습득물 사진을 서버에서 받아 분석할 때의 출처 제한(SSRF 방지).
# 경찰청/포털기관 이미지는 lost112 와 minwon24 두 호스트로 내려온다.
VISUAL_MATCH_ALLOWED_HOSTS = {
    host.strip().lower()
    for host in os.environ.get(
        "GEUGEO_VISUAL_MATCH_ALLOWED_HOSTS",
        "www.lost112.go.kr,lost112.go.kr,minwon24.police.go.kr",
    ).split(",")
    if host.strip()
}
VISUAL_MATCH_FETCH_TIMEOUT = _float_env("GEUGEO_VISUAL_MATCH_FETCH_TIMEOUT", 10.0)
VISUAL_MATCH_MAX_BYTES = _int_env("GEUGEO_VISUAL_MATCH_MAX_BYTES", 12 * 1024 * 1024)
# 원본이 수 MB여도 AI 전송용으로 최대 변 길이 512px JPEG로 줄인다.
VISUAL_MATCH_THUMBNAIL_SIDE = _int_env("GEUGEO_VISUAL_MATCH_THUMBNAIL_SIDE", 512)
VISUAL_MATCH_THUMBNAIL_QUALITY = _int_env("GEUGEO_VISUAL_MATCH_THUMBNAIL_QUALITY", 70)

# 낯선 고유명사(치이카와·짱구 등)를 인터넷에서 찾아 참고 이미지·특징을 만든다.
# 공개 위키 문서·이미지 검색만 읽고 키는 저장하지 않는다.
WEB_REFERENCE_ENABLED = _bool_env("GEUGEO_WEB_REFERENCE_ENABLED", True)
WEB_REFERENCE_TIMEOUT = _float_env("GEUGEO_WEB_REFERENCE_TIMEOUT", 20.0)
WEB_REFERENCE_MAX_IMAGES = max(1, _int_env("GEUGEO_WEB_REFERENCE_MAX_IMAGES", 2))
WEB_REFERENCE_TTL = max(60, _int_env("GEUGEO_WEB_REFERENCE_TTL", 7 * 24 * 60 * 60))

AI_TIMEOUT = _float_env("GEUGEO_AI_TIMEOUT", 45.0)
AI_PROMPT_DIR = BACKEND_DIR / "prompts"

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
POLICE_API_TIMEOUT = _float_env("POLICE_API_TIMEOUT", 8.0)
# 직접 찾기 전체 스캔은 페이지별 요청이 많다. 연결 재사용 + 제한된 동시성으로
# 공개 API에 무리를 주지 않으면서 스캔 시간을 줄인다.
POLICE_API_MAX_CONNECTIONS = max(2, _int_env("GEUGEO_POLICE_API_MAX_CONNECTIONS", 16))
BROWSE_MAX_WORKERS = max(2, min(32, _int_env("GEUGEO_BROWSE_MAX_WORKERS", 12)))
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
AI_SIMILARITY_PROVIDER = os.environ.get("GEUGEO_AI_SIMILARITY_PROVIDER", "none").strip().lower()
AI_SIMILARITY_API_KEY = os.environ.get("GEUGEO_AI_SIMILARITY_API_KEY", "").strip() or OPENAI_API_KEY
AI_SIMILARITY_BASE_URL = (
    os.environ.get("GEUGEO_AI_SIMILARITY_BASE_URL", "").strip().rstrip("/")
    or "https://api.openai.com/v1"
)
AI_SIMILARITY_MODEL = os.environ.get("GEUGEO_AI_SIMILARITY_MODEL", "").strip()
AI_SIMILARITY_INPUT_STYLE = os.environ.get("GEUGEO_AI_SIMILARITY_INPUT_STYLE", "image_url").strip().lower()
AI_SIMILARITY_TIMEOUT = _float_env("GEUGEO_AI_SIMILARITY_TIMEOUT", 20.0)

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

AI_TIMEOUT = _float_env("GEUGEO_AI_TIMEOUT", 45.0)
AI_PROMPT_DIR = BACKEND_DIR / "prompts"

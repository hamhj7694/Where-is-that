from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import ai_api, config, db, geo, kakao, police_api, recovery, security
from .schemas import (
    ACCOUNT_DELETE_CONFIRMATION,
    ContentPayload,
    DeleteAccountRequest,
    FindEmailRequest,
    FoundItemDetail,
    KakaoCallbackRequest,
    KakaoCallbackResponse,
    KakaoStartRequest,
    LoginRequest,
    LostFoundBrowseRequest,
    LostFoundBrowseResponse,
    LostFoundListRequest,
    LostFoundSearchRequest,
    LostFoundSearchResponse,
    MapConfigResponse,
    OriginRequest,
    OriginResponse,
    ProfileUpdateRequest,
    RouteRequest,
    RouteResponse,
    ResetPasswordRequest,
    SignupRequest,
    UserResponse,
)

SAFE_RETURN = re.compile(r"^/(gallery|lost-found|history|valuables|settings|account)(/|\?|$)")

# 파이프라인 확인용 로컬 문서/요청함. 서버 코드와 같은 저장소에 두고 HTML에서 직접 불러온다.
PIPELINE_DIR = Path(__file__).resolve().parents[2] / "파이프라인"
PIPELINE_FILE = re.compile(r"^[A-Za-z0-9가-힣_\-.]+$")
PIPELINE_IDS = {
    "search-prepare",
    "public-visual-match",
    "candidate-compare",
    "context-rank",
    "direct-search",
    "data-collect",
    "audit",
}
PIPELINE_REQUEST_LOCK = threading.Lock()


class PipelineRequestPayload(BaseModel):
    pipeline: str = Field(min_length=1, max_length=60)
    scope: str = Field(default="전체", max_length=120)
    message: str = Field(min_length=1, max_length=4000)


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_return(value: str) -> str:
    return value if SAFE_RETURN.match(value) else "/valuables"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="그거어디? 인증 API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)
app.include_router(ai_api.router)


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@app.exception_handler(HTTPException)
async def handle_http_error(_: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict) and "message" in detail:
        return JSONResponse(status_code=exc.status_code, content=detail, headers=exc.headers)
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": "error", "message": str(detail)},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    errors = exc.errors()
    message = "입력값을 확인해 주세요."
    if errors:
        raw = str(errors[0].get("ctx", {}).get("error", errors[0].get("msg", "")))
        if "required" in raw.lower():
            message = "필수 항목을 입력해 주세요."
        elif raw:
            message = raw
    return JSONResponse(status_code=422, content={"code": "validation", "message": message})


@app.middleware("http")
async def check_origin(request: Request, call_next):
    if (
        request.method in {"POST", "PUT", "PATCH", "DELETE"}
        and request.url.path.startswith("/api/")
        and not request.url.path.startswith("/api/pipeline/")
    ):
        origin = request.headers.get("origin")
        if origin and origin not in config.ALLOWED_ORIGINS:
            return JSONResponse(
                status_code=403,
                content={"code": "origin", "message": "허용되지 않은 요청 출처예요."},
            )
    if request.url.path == "/api/me/content" and request.method == "PUT":
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > config.MAX_CONTENT_BYTES:
            return JSONResponse(
                status_code=413,
                content={"code": "content_too_large", "message": "저장할 내용이 너무 커요. 사진을 줄인 뒤 다시 시도해 주세요."},
            )
    return await call_next(request)


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=config.SESSION_COOKIE_NAME,
        value=token,
        max_age=config.SESSION_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=config.COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=config.SESSION_COOKIE_NAME, path="/")


def set_state_cookie(response: Response, nonce: str) -> None:
    response.set_cookie(
        key=config.KAKAO_STATE_COOKIE,
        value=nonce,
        max_age=config.KAKAO_STATE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=config.COOKIE_SECURE,
        path="/",
    )


def clear_state_cookie(response: Response) -> None:
    response.delete_cookie(key=config.KAKAO_STATE_COOKIE, path="/")


def user_payload(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "nickname": row["nickname"],
        "provider": row["provider"],
        "created_at": row["created_at"],
        "profile_image": row["profile_image"] or "",
        "last_visit_at": row["last_visit_at"] or row["created_at"],
    }


def touch_visit(user_id: int) -> None:
    with closing(db.connect()) as connection:
        with connection:
            connection.execute(
                "UPDATE users SET last_visit_at = ? WHERE id = ?", (utc_now(), user_id)
            )


def require_user(request: Request) -> sqlite3.Row:
    row = current_user(request)
    if not row:
        raise api_error(401, "unauthenticated", "로그인이 필요해요.")
    return row


def create_session(connection: sqlite3.Connection, user_id: int) -> str:
    token = security.new_session_token()
    now = int(time.time())
    with connection:
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (security.hash_token(token), user_id, now + config.SESSION_MAX_AGE_SECONDS),
        )
    return token


def current_user(request: Request) -> sqlite3.Row | None:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    if not token:
        return None
    with closing(db.connect()) as connection:
        return connection.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """,
            (security.hash_token(token), int(time.time())),
        ).fetchone()


@app.get("/api/health")
def health() -> dict:
    return {"service": "geugeo-eodi-auth", "version": 1}


# 외부 폴러가 /health를 찌르므로 같은 응답을 별도 스키마 없이 노출한다.
@app.get("/health", include_in_schema=False)
def root_health() -> dict:
    return health()


def _pipeline_file(filename: str) -> Path:
    if not PIPELINE_FILE.fullmatch(filename):
        raise api_error(400, "invalid_pipeline_file", "파일 이름을 확인해 주세요.")
    path = (PIPELINE_DIR / filename).resolve()
    if path.parent != PIPELINE_DIR.resolve() or not path.is_file():
        raise api_error(404, "pipeline_file_not_found", "파일을 찾을 수 없어요.")
    return path


@app.get("/pipeline", include_in_schema=False)
def pipeline_index() -> FileResponse:
    return FileResponse(_pipeline_file("index.html"), media_type="text/html; charset=utf-8")


@app.get("/pipeline/{filename}", include_in_schema=False)
def pipeline_asset(filename: str) -> FileResponse:
    return FileResponse(_pipeline_file(filename))


def _read_pipeline_requests() -> list[dict]:
    path = PIPELINE_DIR / "requests.json"
    if not path.is_file():
        return []
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return rows if isinstance(rows, list) else []


@app.get("/api/pipeline/requests", include_in_schema=False)
def pipeline_requests() -> dict:
    return {"items": _read_pipeline_requests()}


@app.post("/api/pipeline/request", include_in_schema=False)
def create_pipeline_request(payload: PipelineRequestPayload) -> dict:
    """파이프라인 화면의 수정 요청을 로컬 파일에 적는다. 비밀값은 받지 않는다."""
    pipeline = payload.pipeline.strip()
    if pipeline not in PIPELINE_IDS:
        raise api_error(400, "invalid_pipeline", "알 수 없는 파이프라인이에요.")
    item = {
        "id": f"req-{int(time.time() * 1000)}",
        "createdAt": utc_now(),
        "status": "pending",
        "pipeline": pipeline,
        "scope": payload.scope.strip() or "전체",
        "message": payload.message.strip(),
    }
    with PIPELINE_REQUEST_LOCK:
        PIPELINE_DIR.mkdir(parents=True, exist_ok=True)
        path = PIPELINE_DIR / "requests.json"
        rows = _read_pipeline_requests()
        rows.append(item)
        path.write_text(
            json.dumps(rows[-200:], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return {"ok": True, "id": item["id"], "savedAt": item["createdAt"]}


@app.post("/api/auth/signup", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
def signup(payload: SignupRequest, response: Response) -> dict:
    with closing(db.connect()) as connection:
        existing = connection.execute(
            "SELECT id FROM users WHERE provider = 'local' AND email = ?",
            (payload.email,),
        ).fetchone()
        if existing:
            raise api_error(409, "email_taken", "이미 가입된 이메일이에요.")
        nickname = payload.nickname or payload.email.split("@", 1)[0][:20]
        now = utc_now()
        cursor = connection.execute(
            """
            INSERT INTO users (
                email, nickname, password_hash, provider,
                recovery_question, recovery_answer_hash, created_at, last_visit_at
            )
            VALUES (?, ?, ?, 'local', ?, ?, ?, ?)
            """,
            (
                payload.email,
                nickname,
                security.hash_password(payload.password),
                payload.recoveryQuestion,
                security.hash_password(recovery.normalize_answer(payload.recoveryAnswer)),
                now,
                now,
            ),
        )
        user_id = cursor.lastrowid
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        token = create_session(connection, user_id)
    set_session_cookie(response, token)
    return user_payload(row)


@app.post("/api/auth/login", response_model=UserResponse)
def login(payload: LoginRequest, response: Response) -> dict:
    with closing(db.connect()) as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE provider = 'local' AND email = ?",
            (payload.email,),
        ).fetchone()
        if not row or not security.verify_password(payload.password, row["password_hash"]):
            raise api_error(401, "invalid_credentials", "이메일 또는 비밀번호가 올바르지 않아요.")
        token = create_session(connection, row["id"])
        user_id = row["id"]
    touch_visit(user_id)
    with closing(db.connect()) as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    set_session_cookie(response, token)
    return user_payload(row)


@app.get("/api/auth/me", response_model=UserResponse)
def me(request: Request, response: Response):
    row = current_user(request)
    if not row:
        result = JSONResponse(
            status_code=401,
            content={"code": "unauthenticated", "message": "로그인이 필요해요."},
        )
        clear_session_cookie(result)
        return result
    touch_visit(row["id"])
    with closing(db.connect()) as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    return user_payload(row)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    if token:
        with closing(db.connect()) as connection:
            with connection:
                connection.execute(
                    "DELETE FROM sessions WHERE token_hash = ?",
                    (security.hash_token(token),),
                )
    clear_session_cookie(response)
    return {"ok": True}


@app.patch("/api/me/profile", response_model=UserResponse)
def update_profile(payload: ProfileUpdateRequest, request: Request) -> dict:
    row = require_user(request)
    with closing(db.connect()) as connection:
        with connection:
            connection.execute(
                "UPDATE users SET nickname = ?, profile_image = ? WHERE id = ?",
                (payload.nickname, payload.profileImage, row["id"]),
            )
        updated = connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    return user_payload(updated)


@app.get("/api/me/content", response_model=ContentPayload)
def get_content(request: Request) -> dict:
    row = require_user(request)
    with closing(db.connect()) as connection:
        stored = connection.execute(
            "SELECT payload_json FROM user_content WHERE user_id = ?", (row["id"],)
        ).fetchone()
    return json.loads(stored["payload_json"]) if stored else {"valuables": [], "records": []}


@app.put("/api/me/content", response_model=ContentPayload)
def put_content(payload: ContentPayload, request: Request) -> dict:
    row = require_user(request)
    content = payload.model_dump()
    with closing(db.connect()) as connection:
        with connection:
            connection.execute(
                """
                INSERT INTO user_content (user_id, payload_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (
                    row["id"],
                    json.dumps(content, ensure_ascii=False, separators=(",", ":")),
                    int(time.time()),
                ),
            )
    return content


@app.delete("/api/me")
def delete_account(payload: DeleteAccountRequest, request: Request, response: Response) -> dict:
    row = require_user(request)
    if payload.confirmation != ACCOUNT_DELETE_CONFIRMATION:
        raise api_error(
            400,
            "confirmation_mismatch",
            f"‘{ACCOUNT_DELETE_CONFIRMATION}’를 정확히 입력해 주세요.",
        )
    with closing(db.connect()) as connection:
        with connection:
            connection.execute("DELETE FROM users WHERE id = ?", (row["id"],))
    clear_session_cookie(response)
    return {"ok": True}


def _lostfound_search_key(payload: LostFoundSearchRequest) -> str:
    raw = json.dumps(
        {
            "keyword": payload.keyword.strip(),
            "page": payload.page,
            "rows": payload.rows,
            "hints": payload.hints or {},
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return "search:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _lostfound_list_key(payload: LostFoundListRequest) -> str:
    raw = json.dumps({"page": payload.page, "rows": payload.rows}, sort_keys=True)
    return "list:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _lostfound_browse_key(payload: LostFoundBrowseRequest) -> str:
    raw = json.dumps(
        {
            "keyword": payload.keyword.strip(),
            "page": payload.page,
            "rows": payload.rows,
            "maxPages": payload.maxPages,
            "hints": payload.hints or {},
            "filters": payload.filters,
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return "browse:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _lostfound_detail_key(source: str, atc_id: str, fd_sn: str) -> str:
    return "detail:" + hashlib.sha256(
        f"{source}:{atc_id}:{fd_sn}".encode("utf-8")
    ).hexdigest()


@app.post("/api/lostfound/list", response_model=LostFoundSearchResponse)
def lostfound_list(payload: LostFoundListRequest) -> dict:
    """직접 찾기용: 검색어 없이 공개 API의 전체 목록을 페이지 단위로 가져온다."""
    if not police_api.configured():
        raise api_error(
            503,
            "lostfound_not_configured",
            "경찰청 유실물 조회 설정이 필요해요. 서버 .env를 확인해 주세요.",
        )
    cache_key = _lostfound_list_key(payload)
    with closing(db.connect()) as connection:
        cached = db.cache_get(connection, "lostfound", cache_key, config.LOSTFOUND_SEARCH_TTL)
    if cached is not None:
        return cached
    try:
        result = police_api.search_all("", payload.page, payload.rows, allow_empty=True)
    except police_api.PoliceError as error:
        raise api_error(400 if "invalid" in error.code else 502, error.code, error.message)
    if not result["sources"]:
        first = result["errors"][0] if result["errors"] else None
        code = first["code"] if first else "lostfound_upstream"
        message = first["message"] if first else "경찰청 유실물 정보를 가져오지 못했어요."
        raise api_error(502, code, message)
    if not result["errors"]:
        with closing(db.connect()) as connection:
            db.cache_set(connection, "lostfound", cache_key, result)
    return result


@app.post("/api/lostfound/browse", response_model=LostFoundBrowseResponse)
def lostfound_browse(payload: LostFoundBrowseRequest) -> dict:
    """직접 찾기: 여러 페이지를 스캔해 필터·AI 조건을 적용하고 필터 기준 건수/페이지를 반환한다."""
    if not police_api.configured():
        raise api_error(
            503,
            "lostfound_not_configured",
            "경찰청 유실물 조회 설정이 필요해요. 서버 .env를 확인해 주세요.",
        )
    cache_key = _lostfound_browse_key(payload)
    with closing(db.connect()) as connection:
        cached = db.cache_get(connection, "lostfound", cache_key, config.LOSTFOUND_SEARCH_TTL)
    if cached is not None:
        return cached
    try:
        result = police_api.browse_all(
            payload.keyword,
            payload.page,
            payload.rows,
            filters=payload.filters,
            hints=payload.hints,
            max_pages=payload.maxPages,
        )
    except police_api.PoliceError as error:
        raise api_error(400 if "invalid" in error.code else 502, error.code, error.message)
    if not result["sources"]:
        first = result["errors"][0] if result["errors"] else None
        code = first["code"] if first else "lostfound_upstream"
        message = first["message"] if first else "경찰청 유실물 정보를 가져오지 못했어요."
        raise api_error(502, code, message)
    if not result["errors"]:
        with closing(db.connect()) as connection:
            db.cache_set(connection, "lostfound", cache_key, result)
    return result


@app.post("/api/lostfound/search", response_model=LostFoundSearchResponse)
def lostfound_search(payload: LostFoundSearchRequest) -> dict:
    if not police_api.configured():
        raise api_error(
            503,
            "lostfound_not_configured",
            "경찰청 유실물 조회 설정이 필요해요. 서버 .env를 확인해 주세요.",
        )
    cache_key = _lostfound_search_key(payload)
    with closing(db.connect()) as connection:
        cached = db.cache_get(connection, "lostfound", cache_key, config.LOSTFOUND_SEARCH_TTL)
    if cached is not None:
        return cached
    try:
        result = police_api.search_all(payload.keyword, payload.page, payload.rows, hints=payload.hints)
    except police_api.PoliceError as error:
        raise api_error(400 if "invalid" in error.code else 502, error.code, error.message)
    if not result["sources"]:
        first = result["errors"][0] if result["errors"] else None
        code = first["code"] if first else "lostfound_upstream"
        message = first["message"] if first else "경찰청 유실물 정보를 가져오지 못했어요."
        raise api_error(502, code, message)
    # 한 소스가 실패한 부분 결과는 캐시하지 않는다(승인/장애 복구 즉시 반영).
    if not result["errors"]:
        with closing(db.connect()) as connection:
            db.cache_set(connection, "lostfound", cache_key, result)
    return result


@app.get("/api/lostfound/{source}/{atc_id}/{fd_sn}", response_model=FoundItemDetail)
def lostfound_detail(
    source: Literal["police", "portal"], atc_id: str, fd_sn: str
) -> dict:
    if not police_api.configured():
        raise api_error(
            503,
            "lostfound_not_configured",
            "경찰청 유실물 조회 설정이 필요해요. 서버 .env를 확인해 주세요.",
        )
    cache_key = _lostfound_detail_key(source, atc_id, fd_sn)
    with closing(db.connect()) as connection:
        cached = db.cache_get(connection, "lostfound", cache_key, config.LOSTFOUND_DETAIL_TTL)
    if cached is not None:
        return cached
    try:
        item = police_api.detail(source, atc_id, fd_sn)
    except police_api.PoliceError as error:
        status_code = {
            "lostfound_invalid_id": 400,
            "lostfound_invalid_source": 400,
            "lostfound_not_found": 404,
            "lostfound_timeout": 504,
        }.get(error.code, 502)
        raise api_error(status_code, error.code, error.message)

    map_query = item.get("mapQuery") or ""
    place_key = "place:" + hashlib.sha256(map_query.encode("utf-8")).hexdigest()
    geo_key = "geo:" + hashlib.sha256(map_query.encode("utf-8")).hexdigest()
    with closing(db.connect()) as connection:
        place_result = db.cache_get(connection, "geo", place_key, config.GEO_CACHE_TTL)
        geo_result = db.cache_get(connection, "geo", geo_key, config.GEO_CACHE_TTL)
        if place_result is None:
            place_result = geo.place(map_query) or {}
            # 실패/결과 없음은 캐시하지 않는다(30일 동안 좌표가 영구히 비는 것 방지).
            if place_result:
                db.cache_set(connection, "geo", place_key, place_result)
        if geo_result is None and not place_result:
            geo_result = geo.geocode(map_query) or {}
            if geo_result.get("lat") is not None and geo_result.get("lng") is not None:
                db.cache_set(connection, "geo", geo_key, geo_result)
    if place_result:
        item["lat"] = place_result["lat"]
        item["lng"] = place_result["lng"]
        item["place"] = {key: value for key, value in place_result.items() if key not in ("lat", "lng")}
        if not item.get("address"):
            item["address"] = place_result.get("roadAddress") or place_result.get("address") or ""
        if not item.get("tel"):
            item["tel"] = place_result.get("phone") or ""
    elif geo_result.get("lat") is not None and geo_result.get("lng") is not None:
        item["lat"] = geo_result["lat"]
        item["lng"] = geo_result["lng"]
        if not item.get("address"):
            item["address"] = geo_result.get("address") or ""
    if item.get("lat") is not None and item.get("lng") is not None:
        item["mapUrl"] = geo.map_url(
            (item.get("place") or {}).get("name")
            or item.get("name")
            or item.get("storagePlace")
            or "습득물",
            item["lat"],
            item["lng"],
        )
    with closing(db.connect()) as connection:
        db.cache_set(connection, "lostfound", cache_key, item)
    return item


@app.get("/api/lostfound/map-config", response_model=MapConfigResponse)
def lostfound_map_config() -> dict:
    """지도 SDK용 공개 JS 키만 반환한다(REST·서비스키는 절대 반환하지 않음)."""
    javascript_key = geo.javascript_key()
    return {"javascriptKey": javascript_key, "available": bool(javascript_key)}


@app.post("/api/lostfound/geocode", response_model=OriginResponse)
def lostfound_geocode(payload: OriginRequest) -> dict:
    result = geo.resolve_origin(payload.query)
    if not result:
        raise api_error(404, "origin_not_found", "출발지를 찾지 못했어요. 장소명·주소 또는 '위도,경도'로 입력해 주세요.")
    return result


@app.post("/api/lostfound/route", response_model=RouteResponse)
def lostfound_route(payload: RouteRequest) -> dict:
    result = geo.route(
        payload.originLat,
        payload.originLng,
        payload.destinationLat,
        payload.destinationLng,
        payload.destinationName,
        payload.originName,
    )
    if not result:
        raise api_error(502, "map_route_failed", "길안내 정보를 불러오지 못했어요.")
    return result


@app.get("/api/auth/recovery-questions")
def recovery_questions() -> dict:
    return {"questions": recovery.RECOVERY_QUESTIONS}


@app.post("/api/auth/find-email")
def find_email(payload: FindEmailRequest) -> dict:
    with closing(db.connect()) as connection:
        rows = connection.execute(
            "SELECT * FROM users WHERE provider = 'local' AND nickname = ?",
            (payload.nickname.strip(),),
        ).fetchall()
    answer = recovery.normalize_answer(payload.recoveryAnswer)
    emails = [
        row["email"] for row in rows
        if row["recovery_question"] == payload.recoveryQuestion
        and security.verify_password(answer, row["recovery_answer_hash"])
    ]
    if not emails:
        raise api_error(404, "recovery_mismatch", "입력한 정보와 일치하는 계정이 없어요.")
    return {"emails": emails}


@app.post("/api/auth/reset-password")
def reset_password(payload: ResetPasswordRequest) -> dict:
    with closing(db.connect()) as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE provider = 'local' AND email = ?",
            (payload.email,),
        ).fetchone()
        if (
            not row
            or row["recovery_question"] != payload.recoveryQuestion
            or not security.verify_password(
                recovery.normalize_answer(payload.recoveryAnswer),
                row["recovery_answer_hash"],
            )
        ):
            raise api_error(403, "recovery_mismatch", "입력한 정보가 올바르지 않아요.")
        with connection:
            connection.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (security.hash_password(payload.newPassword), row["id"]),
            )
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
    return {"ok": True}


@app.post("/api/auth/kakao/start")
def kakao_start(payload: KakaoStartRequest, response: Response) -> dict:
    if not kakao.configured():
        raise api_error(503, "kakao_not_configured", "카카오 로그인 설정이 필요해요. 서버 .env를 확인해 주세요.")
    nonce = security.new_session_token()
    with closing(db.connect()) as connection:
        with connection:
            now = int(time.time())
            connection.execute("DELETE FROM oauth_states WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO oauth_states (nonce_hash, return_to, expires_at) VALUES (?, ?, ?)",
                (
                    security.hash_token(nonce),
                    safe_return(payload.returnTo),
                    now + config.KAKAO_STATE_MAX_AGE_SECONDS,
                ),
            )
    set_state_cookie(response, nonce)
    return {"authorizeUrl": kakao.build_authorize_url(nonce)}


@app.post("/api/auth/kakao/callback", response_model=KakaoCallbackResponse)
def kakao_callback(payload: KakaoCallbackRequest, request: Request, response: Response) -> dict:
    received = request.cookies.get(config.KAKAO_STATE_COOKIE)
    if not received or received != payload.state:
        raise api_error(400, "invalid_state", "로그인 요청이 만료됐어요. 다시 시도해 주세요.")
    with closing(db.connect()) as connection:
        with connection:
            state_row = connection.execute(
                "SELECT * FROM oauth_states WHERE nonce_hash = ? AND expires_at > ?",
                (security.hash_token(received), int(time.time())),
            ).fetchone()
            connection.execute(
                "DELETE FROM oauth_states WHERE nonce_hash = ?",
                (security.hash_token(received),),
            )
        clear_state_cookie(response)
        if not state_row:
            raise api_error(400, "invalid_state", "로그인 요청이 만료됐어요. 다시 시도해 주세요.")
        return_to = state_row["return_to"]
        try:
            access_token = kakao.exchange_code(payload.code)
            kakao_user = kakao.fetch_user(access_token)
        except kakao.KakaoError as exc:
            raise api_error(502, exc.code, exc.message)
        with connection:
            row = connection.execute(
                "SELECT * FROM users WHERE provider = 'kakao' AND provider_id = ?",
                (kakao_user.id,),
            ).fetchone()
            if row:
                user_id = row["id"]
            else:
                now = utc_now()
                user_id = connection.execute(
                    """
                    INSERT INTO users (
                        email, nickname, provider, provider_id, profile_image, created_at, last_visit_at
                    )
                    VALUES (?, ?, 'kakao', ?, ?, ?, ?)
                    """,
                    (
                        kakao_user.email,
                        kakao_user.nickname,
                        kakao_user.id,
                        kakao_user.profileImage,
                        now,
                        now,
                    ),
                ).lastrowid
            row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            token = create_session(connection, user_id)
    touch_visit(user_id)
    with closing(db.connect()) as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    set_session_cookie(response, token)
    return {"user": user_payload(row), "returnTo": safe_return(return_to)}

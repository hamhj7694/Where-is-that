from __future__ import annotations

import json
import logging
import re
from urllib.parse import urlencode

import httpx

from . import config
from .schemas import KakaoUser

logger = logging.getLogger(__name__)

AUTHORIZE_URL = "https://kauth.kakao.com/oauth/authorize"
TOKEN_URL = "https://kauth.kakao.com/oauth/token"
USER_INFO_URL = "https://kapi.kakao.com/v2/user/me"
SCOPE = "profile_nickname,profile_image"


class KakaoError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def configured() -> bool:
    return bool(config.KAKAO_JAVASCRIPT_KEY and config.KAKAO_REST_API_KEY)


def build_authorize_url(state: str) -> str:
    params = {
        "client_id": config.KAKAO_JAVASCRIPT_KEY,
        "redirect_uri": config.KAKAO_REDIRECT_URI,
        "response_type": "code",
        "state": state,
        "scope": SCOPE,
    }
    return AUTHORIZE_URL + "?" + urlencode(params)


def exchange_code(code: str) -> str:
    data = {
        "grant_type": "authorization_code",
        "client_id": config.KAKAO_REST_API_KEY,
        "redirect_uri": config.KAKAO_REDIRECT_URI,
        "code": code,
    }
    if config.KAKAO_CLIENT_SECRET:
        data["client_secret"] = config.KAKAO_CLIENT_SECRET
    try:
        with httpx.Client(timeout=10) as client:
            response = client.post(TOKEN_URL, data=data)
    except httpx.HTTPError:
        raise KakaoError("kakao_network", "카카오 인증 서버에 연결하지 못했어요.")
    if response.status_code != 200:
        error_code = ""
        try:
            payload = response.json()
            error_code = str(payload.get("error_code") or payload.get("error") or "")
        except ValueError:
            pass
        logger.warning(
            "kakao token exchange failed: status=%s body=%s",
            response.status_code,
            response.text[:300],
        )
        suffix = f" ({error_code})" if error_code and len(error_code) <= 24 else ""
        raise KakaoError("kakao_token", "카카오 토큰을 받지 못했어요." + suffix)
    token = response.json().get("access_token")
    if not isinstance(token, str) or not token:
        raise KakaoError("kakao_token", "카카오 토큰을 받지 못했어요.")
    return token


def fetch_user(access_token: str) -> KakaoUser:
    try:
        with httpx.Client(timeout=10) as client:
            response = client.get(
                USER_INFO_URL,
                headers={"Authorization": "Bearer " + access_token},
                params={
                    "property_keys": json.dumps(
                        ["kakao_account.profile"], separators=(",", ":")
                    )
                },
            )
    except httpx.HTTPError:
        raise KakaoError("kakao_user", "카카오 사용자 정보를 가져오지 못했어요.")
    if response.status_code != 200:
        error_code = ""
        try:
            payload = response.json()
            error_code = str(payload.get("code") or payload.get("error") or "")
        except ValueError:
            pass
        logger.warning(
            "kakao user info failed: status=%s body=%s",
            response.status_code,
            response.text[:300],
        )
        suffix = f" ({error_code})" if error_code and len(error_code) <= 24 else ""
        raise KakaoError("kakao_user", "카카오 사용자 정보를 가져오지 못했어요." + suffix)
    payload = response.json()
    kakao_id = payload.get("id")
    if not isinstance(kakao_id, (int, str)):
        raise KakaoError("kakao_user", "카카오 사용자 정보를 확인하지 못했어요.")
    account = payload.get("kakao_account") or {}
    profile = account.get("profile") or {}
    profile_image = profile.get("profile_image_url") or profile.get("thumbnail_image_url") or ""
    if not isinstance(profile_image, str) or not re.fullmatch(r"https?://[^\s]+", profile_image):
        profile_image = ""
    return KakaoUser(
        id=str(kakao_id),
        nickname=str(profile.get("nickname") or "카카오 사용자")[:20],
        email=str(account.get("email") or ""),
        profileImage=profile_image[:1000],
    )

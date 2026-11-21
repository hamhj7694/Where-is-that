from __future__ import annotations

import logging
import re
from urllib.parse import quote

import httpx

from . import config

logger = logging.getLogger(__name__)

GEOCODE_URL = "https://dapi.kakao.com/v2/local/search/address.json"
PLACE_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
MOBILITY_URL = "https://apis-navi.kakaomobility.com/v1/directions"
COORDINATE_PATTERN = re.compile(r"^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$")


def available() -> bool:
    return bool(config.KAKAO_REST_API_KEY)


def geocode(query: str) -> dict | None:
    """보관장소 문자열을 카카오 Local API로 좌표로 바꾼다. 키는 서버에서만 사용한다."""
    cleaned = query.strip()[:200]
    if not cleaned or not available():
        return None
    try:
        with httpx.Client(timeout=config.POLICE_API_TIMEOUT) as client:
            response = client.get(
                GEOCODE_URL,
                headers={"Authorization": "KakaoAK " + config.KAKAO_REST_API_KEY},
                params={"query": cleaned, "size": 1},
            )
    except httpx.HTTPError:
        logger.warning("kakao geocode failed for %s", cleaned[:40])
        return None
    if response.status_code != 200:
        logger.warning("kakao geocode status=%s body=%s", response.status_code, response.text[:200])
        return None
    try:
        documents = response.json().get("documents") or []
    except ValueError:
        return None
    if not documents:
        return None
    document = documents[0]
    try:
        lat = float(document["y"])
        lng = float(document["x"])
    except (KeyError, TypeError, ValueError):
        return None
    road = document.get("road_address") or {}
    address = document.get("address") or {}
    return {
        "lat": lat,
        "lng": lng,
        "address": str(road.get("address_name") or address.get("address_name") or "")[:300],
    }


def map_url(name: str, lat: float, lng: float) -> str:
    return (
        "https://map.kakao.com/link/map/"
        + quote(name[:100], safe="")
        + f",{lat:.7f},{lng:.7f}"
    )


def javascript_key() -> str:
    """지도 SDK용 공개 키. 사용자가 브라우저 노출을 승인했다(DML-074)."""
    return config.KAKAO_JAVASCRIPT_KEY


def place(query: str) -> dict | None:
    """보관기관 이름으로 카카오 장소를 찾아 연락처·주소·좌표를 가져온다."""
    cleaned = query.strip()[:200]
    if not cleaned or not available():
        return None
    try:
        with httpx.Client(timeout=config.POLICE_API_TIMEOUT) as client:
            response = client.get(
                PLACE_URL,
                headers={"Authorization": "KakaoAK " + config.KAKAO_REST_API_KEY},
                params={"query": cleaned, "size": 5},
            )
    except httpx.HTTPError:
        logger.warning("kakao place lookup failed for %s", cleaned[:40])
        return None
    if response.status_code != 200:
        logger.warning("kakao place status=%s body=%s", response.status_code, response.text[:200])
        return None
    try:
        documents = response.json().get("documents") or []
    except ValueError:
        return None
    document = next((d for d in documents if str(d.get("place_name") or "").strip() == cleaned), None)
    document = document or next((d for d in documents if cleaned in str(d.get("place_name") or "")), None)
    document = document or (documents[0] if documents else None)
    if not document:
        return None
    try:
        lat = float(document["y"])
        lng = float(document["x"])
    except (KeyError, TypeError, ValueError):
        return None
    place_url = str(document.get("place_url") or "").strip()
    return {
        "name": str(document.get("place_name") or cleaned)[:100],
        "phone": str(document.get("phone") or "")[:50],
        "address": str(document.get("address_name") or "")[:300],
        "roadAddress": str(document.get("road_address_name") or "")[:300],
        "category": str(document.get("category_name") or "")[:200],
        # 카카오 Local 검색 응답에는 영업시간 필드가 없다.
        "openingHours": None,
        "placeUrl": place_url.replace("http://", "https://", 1) or None,
        "lat": lat,
        "lng": lng,
    }


def resolve_origin(query: str) -> dict | None:
    """출발지 입력(장소명·주소·'lat,lng')을 좌표로 바꾼다."""
    cleaned = query.strip()[:100]
    if not cleaned:
        return None
    coordinates = COORDINATE_PATTERN.match(cleaned)
    if coordinates:
        lat, lng = float(coordinates.group(1)), float(coordinates.group(2))
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            return {"name": "입력한 좌표", "lat": lat, "lng": lng, "address": cleaned}
        return None
    found = place(cleaned)
    if found:
        return {
            "name": found["name"],
            "lat": found["lat"],
            "lng": found["lng"],
            "address": found["roadAddress"] or found["address"],
        }
    found = geocode(cleaned)
    if found and found.get("lat") is not None and found.get("lng") is not None:
        return {
            "name": cleaned,
            "lat": found["lat"],
            "lng": found["lng"],
            "address": found.get("address") or "",
        }
    return None


def route(
    origin_lat: float,
    origin_lng: float,
    destination_lat: float,
    destination_lng: float,
    destination_name: str,
    origin_name: str = "현재 위치",
) -> dict | None:
    """카카오 모빌리티 길찾기로 거리·시간·경로를 가져온다(키는 서버에만 둔다)."""
    if not available():
        return None
    try:
        with httpx.Client(timeout=config.POLICE_API_TIMEOUT) as client:
            response = client.get(
                MOBILITY_URL,
                headers={"Authorization": "KakaoAK " + config.KAKAO_REST_API_KEY},
                params={
                    "origin": f"{origin_lng:.7f},{origin_lat:.7f}",
                    "destination": f"{destination_lng:.7f},{destination_lat:.7f}",
                    "priority": "RECOMMEND",
                },
            )
    except httpx.HTTPError:
        logger.warning("kakao mobility route failed")
        return None
    if response.status_code != 200:
        logger.warning("kakao mobility status=%s body=%s", response.status_code, response.text[:200])
        return None
    try:
        routes = response.json().get("routes") or []
    except ValueError:
        return None
    if not routes:
        return None
    chosen = routes[0]
    summary = chosen.get("summary") or {}
    try:
        distance = int(summary.get("distance") or 0)
        duration = int(summary.get("duration") or 0)
    except (TypeError, ValueError):
        return None
    if distance <= 0 or duration <= 0:
        return None
    path: list[list[float]] = []
    for section in chosen.get("sections") or []:
        for road in section.get("roads") or []:
            vertices = road.get("vertexes") or []
            for index in range(0, len(vertices) - 1, 2):
                try:
                    path.append([float(vertices[index + 1]), float(vertices[index])])
                except (TypeError, ValueError):
                    continue
    if len(path) > 300:
        step = len(path) / 300
        path = [path[int(index * step)] for index in range(300)]
    route_url = (
        "https://map.kakao.com/link/to/"
        + quote(destination_name[:100], safe="")
        + f",{destination_lat:.7f},{destination_lng:.7f}"
        + "?from="
        + quote(origin_name[:100], safe="")
        + f",{origin_lat:.7f},{origin_lng:.7f}"
    )
    return {"distance": distance, "duration": duration, "path": path, "mapUrl": route_url}

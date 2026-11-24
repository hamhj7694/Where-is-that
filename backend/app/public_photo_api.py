from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from hashlib import sha256
from io import BytesIO
from typing import Annotated
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import config, police_api

router = APIRouter(prefix="/api/lostfound", tags=["Lost found"])
_MAX_PIXELS = 16_000_000
_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/bmp"}
_workers = ThreadPoolExecutor(max_workers=6, thread_name_prefix="public-photo")
_client = httpx.Client(
    timeout=config.VISUAL_MATCH_FETCH_TIMEOUT,
    limits=httpx.Limits(max_connections=6, max_keepalive_connections=6),
    follow_redirects=False,
)


class PhotoFingerprintRequest(BaseModel):
    urls: list[Annotated[str, Field(min_length=1, max_length=500)]] = Field(max_length=16)


def _public_photo_url(url: str) -> str | None:
    normalized = police_api._image_key(url)
    try:
        parsed = urlsplit(normalized)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname not in config.VISUAL_MATCH_ALLOWED_HOSTS
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in {None, 443 if parsed.scheme == "https" else 80}
        ):
            return None
        return urlunsplit(("https", parsed.hostname, parsed.path, parsed.query, ""))
    except ValueError:
        return None


def _fingerprint(data: bytes) -> str:
    with Image.open(BytesIO(data)) as original:
        if original.width * original.height > _MAX_PIXELS or getattr(original, "is_animated", False):
            return "file:" + sha256(data).hexdigest()
        image = ImageOps.exif_transpose(original).convert("RGBA")
        digest = sha256(f"{image.width}x{image.height}:".encode("ascii"))
        digest.update(image.tobytes())
        return "pixels:" + digest.hexdigest()


@lru_cache(maxsize=4096)
def _download_fingerprint(url: str) -> str:
    with _client.stream("GET", url) as response:
        response.raise_for_status()
        media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media_type not in _IMAGE_TYPES:
            raise ValueError("Public response is not a photo")
        data = bytearray()
        for chunk in response.iter_bytes(chunk_size=64 * 1024):
            if len(data) + len(chunk) > config.VISUAL_MATCH_MAX_BYTES:
                raise ValueError("Public photo exceeds the byte limit")
            data.extend(chunk)
    return _fingerprint(bytes(data))


def _identify(url: str) -> tuple[str, str | None]:
    public_url = _public_photo_url(url)
    if not public_url:
        return url, None
    try:
        return url, _download_fingerprint(public_url)
    except (OSError, httpx.HTTPError, ValueError, Image.DecompressionBombError):
        return url, None


@router.post("/photos/fingerprints")
def photo_fingerprints(request: PhotoFingerprintRequest) -> dict[str, dict[str, str]]:
    return {"fingerprints": {
        url: fingerprint
        for url, fingerprint in _workers.map(_identify, dict.fromkeys(request.urls))
        if fingerprint
    }}

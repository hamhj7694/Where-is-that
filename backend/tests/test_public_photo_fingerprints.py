from io import BytesIO

import httpx
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from app import main, public_photo_api


def png(color: str, description: str = "") -> bytes:
    pixels = Image.new("RGB", (16, 12), color)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Description", description)
    with BytesIO() as buffer:
        pixels.save(buffer, format="PNG", pnginfo=metadata)
        return buffer.getvalue()


def test_public_photo_fingerprints_compare_pixels_and_keep_other_records(monkeypatch):
    base = "https://minwon24.police.go.kr"
    images = {
        "/first.png": png("blue", "first record"),
        "/copy.png": png("blue", "second record"),
        "/different.png": png("red"),
    }
    assert images["/first.png"] != images["/copy.png"]
    called = []

    def serve(request):
        called.append(request.url.host)
        if request.url.path == "/redirect.png":
            return httpx.Response(302, headers={"location": "https://example.invalid/other.png"})
        return httpx.Response(200, content=images[request.url.path], headers={"content-type": "image/png"})

    public_photo_api._download_fingerprint.cache_clear()
    with httpx.Client(transport=httpx.MockTransport(serve), follow_redirects=False) as photos:
        monkeypatch.setattr(public_photo_api, "_client", photos)
        with TestClient(main.app) as client:
            response = client.post("/api/lostfound/photos/fingerprints", json={"urls": [
                base + "/first.png", base + "/copy.png", base + "/different.png",
                base + "/redirect.png", "https://example.invalid/photo.png",
            ]})
    public_photo_api._download_fingerprint.cache_clear()

    assert response.status_code == 200
    result = response.json()["fingerprints"]
    assert result[base + "/first.png"] == result[base + "/copy.png"]
    assert result[base + "/first.png"] != result[base + "/different.png"]
    assert set(result) == {base + path for path in images}
    assert called == ["minwon24.police.go.kr"] * 4

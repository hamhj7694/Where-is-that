from __future__ import annotations

from contextlib import closing
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import config, db, kakao, main, recovery, security


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    with TestClient(main.app) as test_client:
        yield test_client


def signup_payload(email="user@example.com", password="password123", nickname="테스터"):
    return {
        "email": email,
        "password": password,
        "nickname": nickname,
        "recoveryQuestion": recovery.RECOVERY_QUESTIONS[0],
        "recoveryAnswer": "제주도",
    }


def test_signup_sets_http_only_cookie_and_me(client):
    response = client.post("/api/auth/signup", json=signup_payload(email="User@Example.com"))
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "user@example.com"
    assert body["provider"] == "local"
    assert "password" not in body
    assert client.cookies.get(config.SESSION_COOKIE_NAME)

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["nickname"] == "테스터"


def test_duplicate_email_is_rejected(client):
    payload = signup_payload(email="same@example.com")
    assert client.post("/api/auth/signup", json=payload).status_code == 201
    second = client.post("/api/auth/signup", json=payload)
    assert second.status_code == 409
    assert second.json()["code"] == "email_taken"


def test_login_rejects_wrong_password(client):
    client.post("/api/auth/signup", json=signup_payload(email="login@example.com"))
    response = client.post(
        "/api/auth/login", json={"email": "login@example.com", "password": "wrong-password"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "invalid_credentials"


def test_login_success_and_logout(client):
    client.post("/api/auth/signup", json=signup_payload(email="ok@example.com"))
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    response = client.post(
        "/api/auth/login", json={"email": "ok@example.com", "password": "password123"}
    )
    assert response.status_code == 200
    assert client.get("/api/auth/me").status_code == 200


def test_password_and_recovery_answer_are_hashed(client):
    client.post("/api/auth/signup", json=signup_payload(email="hash@example.com"))
    with closing(db.connect()) as connection:
        row = connection.execute("SELECT * FROM users").fetchone()
    assert "password123" not in row["password_hash"]
    assert "제주도" not in row["recovery_answer_hash"]
    assert security.verify_password("password123", row["password_hash"])
    assert security.verify_password(recovery.normalize_answer(" 제주도 "), row["recovery_answer_hash"])


def test_validation_messages_are_korean(client):
    bad_email = client.post("/api/auth/signup", json=signup_payload(email="not-an-email"))
    assert bad_email.status_code == 422
    assert "이메일" in bad_email.json()["message"]

    short = client.post("/api/auth/signup", json=signup_payload(email="short@example.com", password="123"))
    assert short.status_code == 422


def test_find_email_with_recovery_answer(client):
    client.post("/api/auth/signup", json=signup_payload(email="find@example.com", nickname="찾기"))
    correct = client.post(
        "/api/auth/find-email",
        json={
            "nickname": "찾기",
            "recoveryQuestion": recovery.RECOVERY_QUESTIONS[0],
            "recoveryAnswer": "제주도",
        },
    )
    assert correct.status_code == 200
    assert correct.json()["emails"] == ["find@example.com"]

    wrong = client.post(
        "/api/auth/find-email",
        json={
            "nickname": "찾기",
            "recoveryQuestion": recovery.RECOVERY_QUESTIONS[0],
            "recoveryAnswer": "부산",
        },
    )
    assert wrong.status_code == 404
    assert wrong.json()["code"] == "recovery_mismatch"


def test_reset_password_changes_password_and_ends_sessions(client):
    client.post("/api/auth/signup", json=signup_payload(email="reset@example.com"))
    old_login = client.post(
        "/api/auth/login", json={"email": "reset@example.com", "password": "password123"}
    )
    assert old_login.status_code == 200

    reset = client.post(
        "/api/auth/reset-password",
        json={
            "email": "reset@example.com",
            "recoveryQuestion": recovery.RECOVERY_QUESTIONS[0],
            "recoveryAnswer": "제주도",
            "newPassword": "newpassword456",
        },
    )
    assert reset.status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    old = client.post(
        "/api/auth/login", json={"email": "reset@example.com", "password": "password123"}
    )
    assert old.status_code == 401
    new = client.post(
        "/api/auth/login", json={"email": "reset@example.com", "password": "newpassword456"}
    )
    assert new.status_code == 200


def test_recovery_questions_endpoint(client):
    response = client.get("/api/auth/recovery-questions")
    assert response.status_code == 200
    assert len(response.json()["questions"]) >= 3


def test_kakao_start_requires_server_config(client, monkeypatch):
    monkeypatch.setattr(config, "KAKAO_JAVASCRIPT_KEY", "")
    monkeypatch.setattr(config, "KAKAO_REST_API_KEY", "")
    response = client.post("/api/auth/kakao/start", json={"returnTo": "/valuables"})
    assert response.status_code == 503
    assert response.json()["code"] == "kakao_not_configured"


def test_kakao_start_returns_url_without_exposing_keys(client, monkeypatch):
    monkeypatch.setattr(config, "KAKAO_JAVASCRIPT_KEY", "public-js-key")
    monkeypatch.setattr(config, "KAKAO_REST_API_KEY", "secret-rest-key")
    response = client.post("/api/auth/kakao/start", json={"returnTo": "/valuables/new"})
    assert response.status_code == 200
    url = response.json()["authorizeUrl"]
    query = parse_qs(urlparse(url).query)
    assert query["client_id"] == ["public-js-key"]
    assert "secret-rest-key" not in url
    assert query["state"]
    assert client.cookies.get(config.KAKAO_STATE_COOKIE)


def test_kakao_scope_only_asks_for_profile(client, monkeypatch):
    monkeypatch.setattr(config, "KAKAO_JAVASCRIPT_KEY", "public-js-key")
    monkeypatch.setattr(config, "KAKAO_REST_API_KEY", "secret-rest-key")
    response = client.post("/api/auth/kakao/start", json={"returnTo": "/valuables"})
    query = parse_qs(urlparse(response.json()["authorizeUrl"]).query)
    assert query["scope"] == ["profile_nickname,profile_image"]
    assert "account_email" not in query["scope"][0]


def test_kakao_token_error_shows_kakao_error_code(monkeypatch):
    class Response:
        status_code = 401
        text = '{"error":"invalid_client","error_code":"KOE010"}'

        def json(self):
            return {"error": "invalid_client", "error_code": "KOE010"}

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(kakao.httpx, "Client", lambda *_args, **_kwargs: Client())
    with pytest.raises(kakao.KakaoError) as exc:
        kakao.exchange_code("dummy-code")
    assert exc.value.code == "kakao_token"
    assert "KOE010" in exc.value.message


def test_kakao_callback_checks_state_and_creates_user(client, monkeypatch):
    monkeypatch.setattr(config, "KAKAO_JAVASCRIPT_KEY", "public-js-key")
    monkeypatch.setattr(config, "KAKAO_REST_API_KEY", "secret-rest-key")
    monkeypatch.setattr(kakao, "exchange_code", lambda code: "access-token")
    monkeypatch.setattr(
        kakao,
        "fetch_user",
        lambda token: kakao.KakaoUser(id="12345", nickname="카카오유저", email="kakao@example.com"),
    )

    started = client.post("/api/auth/kakao/start", json={"returnTo": "/account"}).json()
    state = parse_qs(urlparse(started["authorizeUrl"]).query)["state"][0]

    mismatch = client.post("/api/auth/kakao/callback", json={"code": "code-1", "state": "wrong"})
    assert mismatch.status_code == 400
    assert mismatch.json()["code"] == "invalid_state"

    response = client.post("/api/auth/kakao/callback", json={"code": "code-1", "state": state})
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["provider"] == "kakao"
    assert body["user"]["nickname"] == "카카오유저"
    assert body["returnTo"] == "/account"
    assert client.get("/api/auth/me").json()["provider"] == "kakao"


def test_safe_return_rejects_external_url():
    assert main.safe_return("/valuables/new?state=complete") == "/valuables/new?state=complete"
    assert main.safe_return("https://example.com") == "/valuables"
    assert main.safe_return("//example.com") == "/valuables"
    assert main.safe_return("/valuables-redirect") == "/valuables"


def test_profile_fields_and_update(client):
    created = client.post("/api/auth/signup", json=signup_payload(email="profile@example.com")).json()
    assert created["profile_image"] == ""
    assert created["last_visit_at"]

    updated = client.patch(
        "/api/me/profile",
        json={"nickname": "  새이름  ", "profileImage": "https://image.example.com/me.png"},
    )
    assert updated.status_code == 200
    assert updated.json()["nickname"] == "새이름"
    me = client.get("/api/auth/me").json()
    assert me["profile_image"] == "https://image.example.com/me.png"

    bad = client.patch("/api/me/profile", json={"nickname": "이름", "profileImage": "javascript:alert(1)"})
    assert bad.status_code == 422


def test_content_requires_auth(client):
    assert client.get("/api/me/content").status_code == 401
    assert client.put("/api/me/content", json={"valuables": [], "records": []}).status_code == 401


def test_content_roundtrip_and_image_validation(client):
    client.post("/api/auth/signup", json=signup_payload(email="content@example.com"))
    assert client.get("/api/me/content").json() == {"valuables": [], "records": []}

    content = {
        "valuables": [{
            "id": "item-1",
            "name": "검정 지갑",
            "notes": "가죽",
            "category": "지갑",
            "status": "kept",
            "photos": [{
                "id": "photo-1",
                "name": "wallet.png",
                "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
                "sampleUrl": None,
                "kind": "photo",
                "photoView": "front",
                "path": "wallet.png",
                "updatedAt": 1,
            }],
            "createdAt": 1,
            "viewedAt": 2,
            "updatedAt": 3,
        }],
        "records": [{
            "id": "record-1",
            "mode": "lost",
            "createdAt": 4,
            "draft": {
                "query": "지갑",
                "photoDataUrl": None,
                "photoName": "",
                "photos": [],
                "photoViews": [],
            },
            "gallery": None,
            "assistant": {"draft": "", "conditions": [], "messages": []},
            "parentRecordId": None,
            "assistantBaseQuery": "지갑",
        }],
    }
    saved = client.put("/api/me/content", json=content)
    assert saved.status_code == 200
    assert client.get("/api/me/content").json() == saved.json()

    invalid = {"valuables": [], "records": [], "extra": 1}
    assert client.put("/api/me/content", json=invalid).status_code == 200
    bad_image = client.put("/api/me/content", json={
        "valuables": [{
            "id": "bad", "name": "x", "status": "kept", "updatedAt": 1,
            "photos": [{"id": "p", "name": "x", "dataUrl": "javascript:alert(1)"}],
        }],
        "records": [],
    })
    assert bad_image.status_code == 422


def test_delete_account_requires_exact_confirmation_and_removes_data(client):
    client.post("/api/auth/signup", json=signup_payload(email="delete@example.com"))
    assert client.put("/api/me/content", json={"valuables": [], "records": []}).status_code == 200

    wrong = client.request(
        "DELETE", "/api/me", json={"confirmation": "계정 탈퇴"}
    )
    assert wrong.status_code == 400
    assert wrong.json()["code"] == "confirmation_mismatch"
    assert client.get("/api/auth/me").status_code == 200

    deleted = client.request(
        "DELETE", "/api/me", json={"confirmation": "계정을 탈퇴합니다"}
    )
    assert deleted.status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM user_content").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_kakao_fetch_user_reads_profile_image(monkeypatch):
    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {
                "id": 12345,
                "kakao_account": {
                    "profile": {
                        "nickname": "카카오유저",
                        "profile_image_url": "https://image.example.com/kakao.png",
                    }
                },
            }

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(kakao.httpx, "Client", lambda *_args, **_kwargs: Client())
    user = kakao.fetch_user("access-token")
    assert user.nickname == "카카오유저"
    assert user.profileImage == "https://image.example.com/kakao.png"

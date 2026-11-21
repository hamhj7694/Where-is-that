from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing

from .config import DB_PATH


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with closing(connect()) as connection:
        with connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL DEFAULT '',
                    nickname TEXT NOT NULL,
                    password_hash TEXT,
                    provider TEXT NOT NULL DEFAULT 'local',
                    provider_id TEXT,
                    recovery_question TEXT NOT NULL DEFAULT '',
                    recovery_answer_hash TEXT NOT NULL DEFAULT '',
                    profile_image TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    last_visit_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_email
                    ON users(email) WHERE provider = 'local';
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_kakao_id
                    ON users(provider_id) WHERE provider = 'kakao';
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS oauth_states (
                    nonce_hash TEXT PRIMARY KEY,
                    return_to TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
                CREATE TABLE IF NOT EXISTS user_content (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    payload_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS lostfound_cache (
                    cache_key TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_lostfound_cache_fetched
                    ON lostfound_cache(fetched_at);
                CREATE TABLE IF NOT EXISTS geo_cache (
                    query_hash TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_geo_cache_fetched
                    ON geo_cache(fetched_at);
                """
            )
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
            if "recovery_question" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN recovery_question TEXT NOT NULL DEFAULT ''")
            if "recovery_answer_hash" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN recovery_answer_hash TEXT NOT NULL DEFAULT ''")
            if "profile_image" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN profile_image TEXT NOT NULL DEFAULT ''")
            if "last_visit_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN last_visit_at TEXT")


CACHE_TABLES = {"lostfound": "lostfound_cache", "geo": "geo_cache"}
CACHE_COLUMNS = {"lostfound": "cache_key", "geo": "query_hash"}


def cache_get(
    connection: sqlite3.Connection,
    kind: str,
    cache_key: str,
    ttl: int,
    now: int | None = None,
) -> dict | None:
    table = CACHE_TABLES[kind]
    column = CACHE_COLUMNS[kind]
    current = now if now is not None else int(time.time())
    row = connection.execute(
        f"SELECT payload_json, fetched_at FROM {table} WHERE {column} = ?",
        (cache_key,),
    ).fetchone()
    if row is None:
        return None
    if current - row["fetched_at"] > ttl:
        connection.execute(f"DELETE FROM {table} WHERE {column} = ?", (cache_key,))
        connection.commit()
        return None
    try:
        payload = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def cache_set(
    connection: sqlite3.Connection,
    kind: str,
    cache_key: str,
    payload: dict,
    now: int | None = None,
) -> None:
    table = CACHE_TABLES[kind]
    column = CACHE_COLUMNS[kind]
    current = now if now is not None else int(time.time())
    encoded = json.dumps(payload, ensure_ascii=False)
    with connection:
        connection.execute(
            f"""INSERT INTO {table} ({column}, payload_json, fetched_at) VALUES (?, ?, ?)
                ON CONFLICT({column}) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    fetched_at = excluded.fetched_at""",
            (cache_key, encoded, current),
        )


def cache_prune(connection: sqlite3.Connection, kind: str, ttl: int, now: int | None = None) -> None:
    table = CACHE_TABLES[kind]
    current = now if now is not None else int(time.time())
    with connection:
        connection.execute(f"DELETE FROM {table} WHERE fetched_at < ?", (current - ttl,))

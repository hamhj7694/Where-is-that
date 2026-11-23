#!/usr/bin/env python3
""" 멀티모달 검색 파이프라인 정확도·성능 자동 감사 스크립트.

실제 FastAPI 앱의 라우트를 `TestClient`로 호출하면서, 내부 함수에 타이머를 감싸
아래 4단계 소요 시간과 반환 후보 수를 터미널에 표로 출력한다.

    전처리/YOLO -> CLIP 임베딩 -> DB 벡터·필터 조회 -> VLM 리랭킹

또한 20개 가상 사용자 시나리오를 JSON으로 만들고, 상위 3개 후보의 사진+메타데이터를
VLM 심판(LLM-as-a-Judge)에게 보내 0~100점과 실패 단계(YOLO/CLIP/필터/VLM)를
Markdown·CSV 리포트로 저장한다. `compare` 서브커맨드는 YOLO ON/OFF를 같은
시나리오에 적용해 속도·점수 차이를 바로 비교한다.

백엔드 코드는 수정하지 않는다. 서버 프로세스(uvicorn)와 같은 DB·.env를 사용하므로
별도 포트 충돌 없이 실행할 수 있다.

실행 예:
    & '.\\backend\\.venv\\Scripts\\python.exe' '.\\backend\\audit\\pipeline_audit.py' generate
    & '.\\backend\\.venv\\Scripts\\python.exe' '.\\backend\\audit\\pipeline_audit.py' run --limit 3
    & '.\\backend\\.venv\\Scripts\\python.exe' '.\\backend\\audit\\pipeline_audit.py' compare --limit 3
"""

from __future__ import annotations

import argparse
import csv
import functools
import json
import re
import sys
import threading
import time
import unicodedata
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import httpx  # noqa: E402

AUDIT_DIR = Path(__file__).resolve().parent
DEFAULT_SCENARIOS = AUDIT_DIR / "scenarios.json"
DEFAULT_REPORTS = AUDIT_DIR / "reports"

STAGE_KEYS = ("preprocess", "yolo", "clip", "filter", "vlm")
DISPLAY_STAGES = ("전처리/YOLO", "CLIP 임베딩", "DB 벡터·필터 조회", "VLM 리랭킹")

REPORT_FIELDS = [
    "id", "category", "mode", "query", "use_yolo", "total", "returned",
    "rule_check", "judge_score", "failure_stage", "failure_reason",
    "preprocess_yolo_ms", "clip_ms", "filter_ms", "vlm_ms",
    "total_stage_ms", "wall_ms", "error",
]

JUDGE_SYSTEM = """당신은 유실물 검색 파이프라인의 품질 감사관입니다.
사용자 질의와 기대 조건, 상위 3개 후보의 메타데이터와 사진을 보고 채점하세요.

반드시 아래 JSON만 출력하세요(코드 펜스 금지):
{
  "score": 0~100 정수,
  "visual_match": 0~100 정수,
  "condition_match": 0~100 정수,
  "verdict": "pass" | "partial" | "fail",
  "failure_stage": "none" | "YOLO" | "CLIP" | "필터" | "VLM",
  "failure_reason": "틀렸다면 원인을 한 문장으로",
  "items": [
    {"id": "후보ID", "score": 0~100 정수, "reason": "한 문장"}
  ]
}

채점 기준:
- expect.expect_empty 가 true면, 결과가 없거나 명백히 무관한 후보만 있으면 80~100점.
  그럴듯하지만 엉뚱한 물건이 상위에 있으면 0~40점.
- expect.expect_empty 가 false인데 결과가 0건이면 0~20점. 사진이 없어서가 아니라 검색 실패로 본다.
- 그 외에는 사용자가 말한 물건 종류·색상·브랜드·문자·장소·기간이 상위 3개에
  얼마나 맞는지 사진과 메타데이터를 함께 봐서 채점.
- 공식 color 가 사용자 요청 색과 정면으로 어긋나면 감점.

실패 단계 정의(score 가 60 미만일 때 반드시 하나 선택):
- YOLO: 사진 속 관심 물건을 잘못 잡아 엉뚱한 영역을 비교함/크롭이 방해됨
- CLIP: 사진 임베딩 유사도 순위가 잘못되어 엉뚱한 사진이 상위에 올라옴
- 필터: 카테고리·색상·지역·기간 등 공식 메타데이터 조건이 누락/오적용됨
- VLM: 검색어 해석·시각 특징 추출·리랭킹 판단이 잘못됨
- none: 결과가 충분히 맞음
"""

SCENARIO_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "S01", "category": "simple_keyword", "mode": "basic", "query": "지갑",
        "filters": {}, "expect": {"min_results": 1, "must_include_any": ["지갑"]},
        "focus": "단순 품목어. 사진 분석 없이 텍스트 결과만 와야 함",
    },
    {
        "id": "S02", "category": "simple_keyword", "mode": "basic", "query": "우산",
        "filters": {}, "expect": {"min_results": 1, "must_include_any": ["우산"]},
        "focus": "단순 품목어 재현성",
    },
    {
        "id": "S03", "category": "typo", "mode": "basic", "query": "지갈",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["지갑"]},
        "focus": "오타. 부분 일치/넓은 스캔으로 놓치지 않는지",
    },
    {
        "id": "S04", "category": "typo", "mode": "ai", "query": "스맛폰 찾아요",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["휴대폰", "스마트폰", "핸드폰"]},
        "focus": "오타 + AI 해석. 휴대폰 종류로 복원되는지",
    },
    {
        "id": "S05", "category": "typo", "mode": "ai", "query": "에어포드 분실했어요",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["이어폰", "에어팟", "헤드폰"]},
        "focus": "오타 + 브랜드 유사어. 엉뚱한 전자기기로 튀지 않는지",
    },
    {
        "id": "S06", "category": "compound_filter", "mode": "ai",
        "query": "서울 강남에서 잃어버린 검은 지갑",
        "filters": {"region": "서울", "color": "블랙(검정)"},
        "expect": {"min_results": 0, "must_include_any": ["지갑"], "must_not_color": ["화이트(흰)", "핑크(분홍)"]},
        "focus": "지역+색상+품목 복합 필터",
    },
    {
        "id": "S07", "category": "compound_filter", "mode": "ai",
        "query": "제주에서 잃어버린 하얀 신한카드",
        "filters": {"region": "제주", "color": "화이트(흰)"},
        "expect": {"min_results": 0, "must_include_any": ["카드"], "must_not_color": ["시안(청록)"]},
        "focus": "지역+색상+브랜드. 색상 불일치 카드가 올라오면 회귀",
    },
    {
        "id": "S08", "category": "compound_filter", "mode": "ai",
        "query": "2026년 11월에 잃어버린 파란 우산",
        "filters": {"from": "2026-11-01", "to": "2026-11-30"},
        "expect": {"min_results": 0, "must_include_any": ["우산"]},
        "focus": "기간+색상+��목. 날짜 필터가 결과를 비우지 않는지",
    },
    {
        "id": "S09", "category": "visual_language", "mode": "ai",
        "query": "하얀색 몸체에 파란 로고가 있는 카드",
        "filters": {},
        "expect": {"min_results": 0, "must_include_any": ["카드"], "must_not_color": ["시안(청록)"]},
        "focus": "시각 묘사 위주. 파란/청록 카드가 흰 카드로 오인되면 회귀",
    },
    {
        "id": "S10", "category": "visual_language", "mode": "ai",
        "query": "분홍색 하트 키링이 달린 열쇠",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["열쇠", "키링"]},
        "focus": "모양+색상+부속품 자연어",
    },
    {
        "id": "S11", "category": "visual_language", "mode": "ai",
        "query": "투명 PVC 재질의 카드 지갑",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["지갑", "카드"]},
        "focus": "재질 묘사. 투명/플라스틱 단서가 과잉 하드필터가 되지 않는지",
    },
    {
        "id": "S12", "category": "visual_language", "mode": "ai",
        "query": "검은 가죽에 금색 지퍼가 달린 지갑",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["지갑"]},
        "focus": "여러 시각 형용자 조합",
    },
    {
        "id": "S13", "category": "brand", "mode": "ai", "query": "신한카드",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["신한", "카드"]},
        "focus": "브랜드 하드코딩 회귀. 사진 점수 98점이 기본으로 붙으면 안 됨",
    },
    {
        "id": "S14", "category": "brand", "mode": "ai", "query": "하얀 신한카드",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["카드"], "must_not_color": ["시안(청록)"]},
        "focus": "이전 버그 재현. 청록 카드가 사진 일치로 상위 노출되면 실패",
    },
    {
        "id": "S15", "category": "person_name", "mode": "ai",
        "query": "류진 이름이 적힌 노트북",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": ["노트북", "류"]},
        "focus": "이름+사진 텍스트. 색상어/이름 오인 방지",
    },
    {
        "id": "S16", "category": "place_only", "mode": "ai",
        "query": "지하철에서 잃어버린 것 같아요",
        "filters": {}, "expect": {"min_results": 0, "must_include_any": []},
        "focus": "장소어만 있음. 장소를 하드필터로 걸어 0건이 되면 실패",
    },
    {
        "id": "S17", "category": "no_result_trap", "mode": "ai",
        "query": "우주선 열쇠고리",
        "filters": {}, "expect": {"expect_empty": True},
        "focus": "존재하지 않는 물건. 억지로 유사 후보를 만들지 않는지",
    },
    {
        "id": "S18", "category": "no_result_trap", "mode": "ai",
        "query": "2023년에 잃어버린 자율주행 자동차 키",
        "filters": {"from": "2023-01-01", "to": "2023-12-31"},
        "expect": {"expect_empty": True},
        "focus": "오래된 기간+없는 물건. 기간 필터가 무시되면 실패",
    },
    {
        "id": "S19", "category": "no_result_trap", "mode": "ai",
        "query": "네온 형광색 투명 지갑",
        "filters": {}, "expect": {"expect_empty": True},
        "focus": "모순된 색상+재질. 그럴듯한 오탐이 상위에 오면 감점",
    },
    {
        "id": "S20", "category": "regression", "mode": "basic", "query": "카드",
        "filters": {}, "expect": {"min_results": 1, "must_include_any": ["카드"]},
        "focus": "일반 모드 회귀. YOLO/CLIP/VLM 호출 없이 텍스트만 조회해야 함",
    },
]


# ---------------------------------------------------------------------------
# 터미널 출력 유틸
# ---------------------------------------------------------------------------

def _width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1 for char in str(text))


def print_table(headers: list[str], rows: list[list[Any]], title: str | None = None) -> None:
    if title:
        print(f"\n{title}")
    matrix = [[str(cell) for cell in headers]] + [[str(cell) for cell in row] for row in rows]
    widths = [max(_width(row[index]) for row in matrix) for index in range(len(headers))]

    def format_row(row: list[str]) -> str:
        return "| " + " | ".join(
            cell + " " * (widths[index] - _width(cell)) for index, cell in enumerate(row)
        ) + " |"

    separator = "|-" + "-|-".join("-" * width for width in widths) + "-|"
    print(separator)
    print(format_row(matrix[0]))
    print(separator)
    for row in matrix[1:]:
        print(format_row(row))
    print(separator)


# ---------------------------------------------------------------------------
# 단계별 타이머 (백엔드 내부 함수 감싸기)
# ---------------------------------------------------------------------------

_TIMINGS: dict[str, float] = {key: 0.0 for key in STAGE_KEYS}
_TIMING_LOCK = threading.Lock()
_ORIGINALS: dict[tuple[Any, str], Callable[..., Any]] = {}


def _record(stage: str, milliseconds: float) -> None:
    with _TIMING_LOCK:
        _TIMINGS[stage] += milliseconds


def reset_timings() -> None:
    with _TIMING_LOCK:
        for key in STAGE_KEYS:
            _TIMINGS[key] = 0.0


def timing_snapshot() -> dict[str, float]:
    with _TIMING_LOCK:
        raw = dict(_TIMINGS)
    preprocess_yolo = raw.get("preprocess", 0.0) + raw.get("yolo", 0.0)
    return {
        "preprocess_yolo_ms": round(preprocess_yolo, 1),
        "download_ms": round(raw.get("preprocess", 0.0), 1),
        "yolo_ms": round(raw.get("yolo", 0.0), 1),
        "clip_ms": round(raw.get("clip", 0.0), 1),
        "filter_ms": round(raw.get("filter", 0.0), 1),
        "vlm_ms": round(raw.get("vlm", 0.0), 1),
        "total_stage_ms": round(sum(raw.values()), 1),
    }


def _wrap(module: Any, name: str, stage: str, predicate: Callable[..., bool] | None = None) -> None:
    key = (module, name)
    if key in _ORIGINALS:
        return
    original = getattr(module, name)
    _ORIGINALS[key] = original

    @functools.wraps(original)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        started = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            if predicate is None or predicate(args, kwargs):
                _record(stage, (time.perf_counter() - started) * 1000.0)

    setattr(module, name, wrapper)


def install_instrumentation() -> None:
    from app import ai_pipeline, local_vision, police_api, web_reference

    # 사진 다운로드·리사이즈와 웹 참고 썸네일은 '전처리'로, YOLO 추론은 따로 센다.
    _wrap(ai_pipeline, "_fetch_public_image", "preprocess")
    _wrap(web_reference, "_thumbnail", "preprocess")
    _wrap(local_vision, "object_census", "yolo")
    _wrap(local_vision, "embed_image", "clip")
    _wrap(local_vision, "embed_text", "clip")
    # 공개 API 스캔 + 로컬 필터/정렬을 'DB 벡터·필터 조회' 단계로 본다.
    _wrap(police_api, "browse_all", "filter")
    _wrap(
        ai_pipeline, "_completion", "vlm",
        lambda args, kwargs: bool(args) and args[0] in {"vlm", "multimodal", "vision"},
    )


def restore_instrumentation() -> None:
    for (module, name), original in reversed(list(_ORIGINALS.items())):
        setattr(module, name, original)
    _ORIGINALS.clear()


def clear_runtime_caches() -> None:
    """비교 공정성을 위해 이미지/텍스트 임베딩 캐시만 비운다(모델 로딩 캐시는 유지)."""
    from app import local_vision

    for name in (
        "crop_target", "embed_image", "embed_text",
        "target_labels", "text_prompts", "scope_keywords",
    ):
        function = getattr(local_vision, name, None)
        original = _ORIGINALS.get((local_vision, name), function)
        if callable(original) and hasattr(original, "cache_clear"):
            original.cache_clear()


@contextmanager
def yolo_mode(use_yolo: bool):
    """use_yolo=False일 때 YOLOE 가용성을 꺼서 크롭 단계 자체를 생략한다."""
    from app import config, local_vision

    old_available = local_vision.yoloe_available
    old_enabled = getattr(config, "YOLOE_ENABLED", True)
    try:
        if not use_yolo:
            local_vision.yoloe_available = lambda: False
            config.YOLOE_ENABLED = False
        yield
    finally:
        local_vision.yoloe_available = old_available
        config.YOLOE_ENABLED = old_enabled


def purge_browse_cache(payload: dict[str, Any]) -> None:
    """같은 조건의 캐시가 남아 있으면 AI 단계가 통째로 생략되어 비교가 깨진다."""
    from app import db, main
    from app.schemas import LostFoundBrowseRequest

    key = main._lostfound_browse_key(LostFoundBrowseRequest(**payload))
    with closing(db.connect()) as connection:
        connection.execute("DELETE FROM lostfound_cache WHERE cache_key = ?", (key,))
        connection.commit()


# ---------------------------------------------------------------------------
# 시나리오 JSON
# ---------------------------------------------------------------------------

def generate_scenarios(path: Path = DEFAULT_SCENARIOS) -> list[dict[str, Any]]:
    now = datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds")
    payload = {
        "version": 1,
        "generatedAt": now,
        "source": "backend/audit/pipeline_audit.py :: SCENARIO_TEMPLATES",
        "count": len(SCENARIO_TEMPLATES),
        "scenarios": SCENARIO_TEMPLATES,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"시나리오 {len(SCENARIO_TEMPLATES)}개 생성: {path}")
    return list(SCENARIO_TEMPLATES)


def load_scenarios(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    if not path.exists():
        generate_scenarios(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    scenarios = data["scenarios"] if isinstance(data, dict) else data
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError(f"시나리오 파일이 비어 있습니다: {path}")
    if limit:
        scenarios = scenarios[:limit]
    return scenarios


# ---------------------------------------------------------------------------
# 검색 실행
# ---------------------------------------------------------------------------

def build_plan(client: Any, scenario: dict[str, Any], plan_cache: dict[str, Any]) -> dict[str, Any]:
    """프론트와 같은 순서로 조건을 만든다. basic은 AI 해석을 아예 호출하지 않는다."""
    query = str(scenario.get("query") or "").strip()
    mode = str(scenario.get("mode") or "ai")
    scenario_filters = {str(k): str(v) for k, v in (scenario.get("filters") or {}).items()}

    if mode == "basic":
        from app.lostfound_codes import REGION_CODES

        filters = dict(scenario_filters)
        if not filters.get("region"):
            region = next((name for name in REGION_CODES if name in query), "")
            if region:
                filters["region"] = region
        return {"hints": {}, "filters": filters, "refinedQuery": query, "plan": {}}

    cache_key = json.dumps({"query": query, "filters": scenario_filters}, sort_keys=True, ensure_ascii=False)
    if cache_key in plan_cache:
        return plan_cache[cache_key]

    response = client.post(
        "/api/ai/search/prepare",
        json={
            "mode": "direct",
            "query": query,
            "images": [],
            "filters": scenario_filters,
            "externalProcessingConfirmed": True,
        },
    )
    response.raise_for_status()
    plan = response.json()
    criteria = plan.get("criteria") or {}
    hints = {
        name: criteria.get(name, [])
        for name in ("apiKeywords", "include", "any", "exclude", "prefer", "imageFeatures")
    }
    filters = dict(scenario_filters)
    planned = plan.get("filters") or {}
    for source, target in (("category", "category"), ("region", "region"), ("fromDate", "from"), ("toDate", "to")):
        if planned.get(source) and not filters.get(target):
            filters[target] = planned[source]
    result = {
        "hints": hints,
        "filters": filters,
        "refinedQuery": plan.get("refinedQuery") or query,
        "plan": plan,
    }
    plan_cache[cache_key] = result
    return result


def run_search(
    client: Any,
    scenario: dict[str, Any],
    use_yolo: bool,
    plan_cache: dict[str, Any],
    rows: int,
    timeout: float,
) -> dict[str, Any]:
    plan = build_plan(client, scenario, plan_cache)
    payload: dict[str, Any] = {
        "keyword": str(scenario.get("query") or ""),
        "page": 1,
        "rows": rows,
        "maxPages": 200,
        "hints": plan["hints"],
        "filters": plan["filters"],
        "skipVisual": 0,
        "priorVisualScores": {},
    }
    purge_browse_cache(payload)
    clear_runtime_caches()
    reset_timings()

    error = ""
    status: dict[str, Any] = {}
    started = time.perf_counter()
    with yolo_mode(use_yolo):
        try:
            started_job = client.post("/api/lostfound/browse/jobs", json=payload)
            started_job.raise_for_status()
            job_id = started_job.json()["jobId"]
            deadline = time.monotonic() + timeout
            while True:
                polled = client.get(f"/api/lostfound/browse/jobs/{job_id}")
                polled.raise_for_status()
                status = polled.json()
                if status.get("status") in {"done", "error"}:
                    break
                if time.monotonic() > deadline:
                    error = f"작업 시간 초과({timeout:.0f}초)"
                    break
                time.sleep(0.25)
        except Exception as cause:  # noqa: BLE001 - 감사 스크립트는 실패도 기록한다
            error = f"{type(cause).__name__}: {cause}"
    wall_ms = round((time.perf_counter() - started) * 1000.0, 1)

    if status.get("status") == "error":
        error = error or str(status.get("error") or "검색 작업 실패")

    result = status.get("result") or {}
    items = list(result.get("items") or [])
    timings = timing_snapshot()
    return {
        "id": str(scenario.get("id") or "S?"),
        "category": str(scenario.get("category") or ""),
        "mode": str(scenario.get("mode") or "ai"),
        "query": str(scenario.get("query") or ""),
        "scenario": scenario,
        "use_yolo": use_yolo,
        "plan": plan["plan"],
        "refined_query": plan["refinedQuery"],
        "total": int(result.get("total") or 0),
        "returned": len(items),
        "top_items": items[:3],
        "result": result,
        "timings": timings,
        "wall_ms": wall_ms,
        "error": error,
        "judge_score": 0,
        "judge_detail": {},
        "rule_check": "NOT_RUN",
    }


# ---------------------------------------------------------------------------
# 규칙 기반 1차 검사 + VLM 심판
# ---------------------------------------------------------------------------

def rule_check(scenario: dict[str, Any], items: list[dict[str, Any]], error: str) -> str:
    if error:
        return "ERROR"
    expect = scenario.get("expect") or {}
    if expect.get("expect_empty"):
        return "PASS" if not items else f"FAIL(결과 {len(items)}건)"

    minimum = int(expect.get("min_results") or 0)
    if len(items) < minimum:
        return f"FAIL({len(items)}건 < {minimum})"

    terms = [str(term) for term in (expect.get("must_include_any") or [])]
    if terms:
        text = " ".join(
            " ".join(str(item.get(field) or "") for field in ("name", "subject", "notes", "category", "color"))
            for item in items
        ).lower()
        if not any(term.lower() in text for term in terms):
            return "FAIL(필수 단서 없음)"

    forbidden = [str(color) for color in (expect.get("must_not_color") or [])]
    if forbidden:
        bad = [
            item for item in items
            if any(color in str(item.get("color") or "") for color in forbidden)
        ]
        if bad:
            return f"FAIL(색상 불일치 {len(bad)}건)"
    return "PASS"


def _parse_json(content: str) -> dict[str, Any]:
    cleaned = content.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    value = json.loads(cleaned)
    if not isinstance(value, dict):
        raise ValueError("심판 응답이 JSON 객체가 아닙니다")
    return value


def judge_messages(entry: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    from app.ai_pipeline import _fetch_public_image

    scenario = entry["scenario"]
    payload = {
        "scenarioId": entry["id"],
        "scenarioCategory": entry["category"],
        "originalQuery": entry["query"],
        "refinedQuery": entry.get("refined_query", ""),
        "expectation": scenario.get("expect") or {},
        "focus": scenario.get("focus", ""),
        "useYolo": entry["use_yolo"],
        "returnedCount": entry["returned"],
        "totalCount": entry["total"],
        "candidates": [
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "subject": item.get("subject"),
                "category": item.get("category"),
                "color": item.get("color"),
                "foundDate": item.get("foundDate"),
                "foundPlace": item.get("foundPlace"),
                "notes": str(item.get("notes") or "")[:300],
                "matchTier": item.get("matchTier"),
                "matchLabel": item.get("matchLabel"),
                "visualScore": item.get("visualScore"),
                "aiMatch": item.get("aiMatch"),
            }
            for item in entry["top_items"]
        ],
    }
    content: list[dict[str, Any]] = [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]
    images: list[str] = []
    for index, item in enumerate(entry["top_items"], start=1):
        image = ""
        url = str(item.get("imageUrl") or "")
        if url:
            try:
                image = _fetch_public_image(url) or ""
            except Exception:  # noqa: BLE001 - 이미지 실패는 '사진 없음'으로 넘긴다
                image = ""
        images.append(image)
        content.append({"type": "text", "text": f"후보 {index} 사진:"})
        if image:
            content.append({"type": "image_url", "image_url": {"url": image, "detail": "low"}})
        else:
            content.append({"type": "text", "text": "(사진 없음)"})
    return [
        {"role": "system", "content": JUDGE_SYSTEM},
        {"role": "user", "content": content},
    ], images


def call_judge(messages: list[dict[str, Any]], timeout: float = 90.0) -> dict[str, Any]:
    from app.ai_pipeline import _role_config

    last_error = "판정기 설정 없음"
    for role in ("vlm", "llm", "multimodal"):
        try:
            provider, key, base_url, model = _role_config(role)
        except Exception as cause:  # noqa: BLE001
            last_error = str(cause)
            continue
        if provider != "openai-compatible" or not key or not base_url or not model:
            continue
        try:
            response = httpx.post(
                base_url.rstrip("/") + "/chat/completions",
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": messages,
                    "response_format": {"type": "json_object"},
                    "store": False,
                },
                timeout=timeout,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return _parse_json(content)
        except Exception as cause:  # noqa: BLE001
            last_error = f"{type(cause).__name__}: {cause}"
    raise RuntimeError(last_error)


def _heuristic_stage(entry: dict[str, Any]) -> str:
    """심판이 실패 단계를 비웠을 때 결과 메타데이터로 추정한다."""
    from app import main

    expect = entry["scenario"].get("expect") or {}
    if not entry["top_items"]:
        return "none" if expect.get("expect_empty") else "필터"

    forbidden = [str(color) for color in (expect.get("must_not_color") or [])]
    if any(any(color in str(item.get("color") or "") for color in forbidden) for item in entry["top_items"]):
        return "필터"

    criteria = (entry.get("plan") or {}).get("criteria") or {}
    if criteria.get("imageFeatures"):
        best_visual = max((int(item.get("visualScore") or 0) for item in entry["top_items"]), default=0)
        if best_visual < main.VISUAL_MATCH_MIN:
            return "CLIP"
    return "VLM"


def normalize_judge(value: dict[str, Any], entry: dict[str, Any], error: str = "") -> dict[str, Any]:
    search_error = error or str(entry.get("error") or "")
    if search_error:
        return {
            "score": 0,
            "visual_match": 0,
            "condition_match": 0,
            "verdict": "error",
            "failure_stage": "필터",
            "failure_reason": f"검색 실패: {search_error}",
            "items": [],
        }

    def bounded_int(raw: Any, default: int = 0) -> int:
        if isinstance(raw, bool):
            return default
        if isinstance(raw, (int, float)):
            return max(0, min(100, int(round(raw))))
        return default

    stage = str(value.get("failure_stage") or "none").strip()
    if stage not in {"none", "YOLO", "CLIP", "필터", "VLM"}:
        stage = "VLM"
    score = bounded_int(value.get("score"))
    if score >= 60 and stage != "none":
        stage = "none"
    if score < 60 and stage == "none":
        stage = _heuristic_stage(entry)
    expect = entry["scenario"].get("expect") or {}
    reason = str(value.get("failure_reason") or "").strip()[:300]
    if not expect.get("expect_empty") and not entry["top_items"]:
        score = min(score, 20)
        stage = "필터"
        reason = reason or "결과가 0건이어서 조건 일치를 확인할 수 없음"
    return {
        "score": score,
        "visual_match": bounded_int(value.get("visual_match")),
        "condition_match": bounded_int(value.get("condition_match")),
        "verdict": str(value.get("verdict") or "").strip(),
        "failure_stage": stage,
        "failure_reason": reason,
        "items": value.get("items") if isinstance(value.get("items"), list) else [],
    }


def judge_entry(entry: dict[str, Any]) -> None:
    if entry["error"]:
        detail = normalize_judge({}, entry)
    else:
        messages, images = judge_messages(entry)
        try:
            raw = call_judge(messages)
            detail = normalize_judge(raw, entry)
        except Exception as cause:  # noqa: BLE001
            detail = normalize_judge({}, entry, f"{type(cause).__name__}: {cause}")
        # 사진 데이터는 리포트에 저장하지 않는다.
        del images
    entry["judge_detail"] = detail
    entry["judge_score"] = int(detail["score"])
    entry["rule_check"] = rule_check(entry["scenario"], entry["top_items"], entry["error"])


# ---------------------------------------------------------------------------
# 리포트
# ---------------------------------------------------------------------------

def average(values: list[float]) -> float:
    return round(sum(values) / len(values), 1) if values else 0.0


def judge_display(entry: dict[str, Any]) -> str:
    """심판을 생략한 실행은 0점이 아니라 '미실행'으로 표시한다."""
    if not (entry.get("judge_detail") or {}):
        return "미실행"
    return str(entry["judge_score"])


def summarize(entries: list[dict[str, Any]]) -> dict[str, float | bool]:
    judged = [entry for entry in entries if (entry.get("judge_detail") or {})]
    return {
        "judge_score": average([float(entry["judge_score"]) for entry in judged]),
        "judge_ran": bool(judged),
        "total_stage_ms": average([float(entry["timings"]["total_stage_ms"]) for entry in entries]),
        "preprocess_yolo_ms": average([float(entry["timings"]["preprocess_yolo_ms"]) for entry in entries]),
        "clip_ms": average([float(entry["timings"]["clip_ms"]) for entry in entries]),
        "filter_ms": average([float(entry["timings"]["filter_ms"]) for entry in entries]),
        "vlm_ms": average([float(entry["timings"]["vlm_ms"]) for entry in entries]),
        "wall_ms": average([float(entry["wall_ms"]) for entry in entries]),
        "passed_rate": round(
            100.0 * sum(1 for entry in entries if entry["rule_check"] == "PASS") / len(entries), 1
        ) if entries else 0.0,
    }


def flat_row(entry: dict[str, Any]) -> dict[str, Any]:
    detail = entry.get("judge_detail") or {}
    return {
        "id": entry["id"],
        "category": entry["category"],
        "mode": entry["mode"],
        "query": entry["query"],
        "use_yolo": "ON" if entry["use_yolo"] else "OFF",
        "total": entry["total"],
        "returned": entry["returned"],
        "rule_check": entry["rule_check"],
        "judge_score": judge_display(entry),
        "failure_stage": detail.get("failure_stage", "") if detail else "미실행",
        "failure_reason": detail.get("failure_reason", ""),
        "preprocess_yolo_ms": entry["timings"]["preprocess_yolo_ms"],
        "clip_ms": entry["timings"]["clip_ms"],
        "filter_ms": entry["timings"]["filter_ms"],
        "vlm_ms": entry["timings"]["vlm_ms"],
        "total_stage_ms": entry["timings"]["total_stage_ms"],
        "wall_ms": entry["wall_ms"],
        "error": entry["error"],
    }


def write_reports(entries: list[dict[str, Any]], report_dir: Path, name: str) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    csv_path = report_dir / f"{name}.csv"
    md_path = report_dir / f"{name}.md"

    rows = [flat_row(entry) for entry in entries]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=REPORT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    stats = summarize(entries)
    lines = [
        f"# 파이프라인 감사 리포트 — {name}",
        "",
        f"- 생성 시각: {datetime.now(timezone(timedelta(hours=9))).isoformat(timespec='seconds')}",
        f"- 시나리오: {len(entries)}개 / YOLO: {'ON' if entries[0]['use_yolo'] else 'OFF'}" if entries else "- 시나리오: 0개",
        f"- 규칙 검사 통과율: {stats['passed_rate']}%",
        (
            f"- VLM 심판 평균 점수: {stats['judge_score']}점"
            if stats["judge_ran"] else "- VLM 심판: 미실행 (`--no-judge`)"
        ),
        f"- 단계 평균 합계: {stats['total_stage_ms']}ms (벽시계 {stats['wall_ms']}ms)",
        "",
        "## 시나리오별 결과",
        "",
        "| ID | 유형 | 모드 | 질의 | 반환 | 규칙 | 심판 | 실패 단계 | 전처리/YOLO | CLIP | 필터 | VLM |",
        "|---|---|---|---|---:|---|---|---:|---:|---:|---:|",
    ]
    for entry in entries:
        detail = entry.get("judge_detail") or {}
        lines.append(
            "| {id} | {category} | {mode} | {query} | {returned} | {rule} | {score} | {stage} | {pre} | {clip} | {filter} | {vlm} |".format(
                id=entry["id"], category=entry["category"], mode=entry["mode"],
                query=entry["query"].replace("|", "\\|"), returned=entry["returned"],
                rule=entry["rule_check"], score=judge_display(entry),
                stage=detail.get("failure_stage", "") if detail else "미실행",
                pre=entry["timings"]["preprocess_yolo_ms"], clip=entry["timings"]["clip_ms"],
                filter=entry["timings"]["filter_ms"], vlm=entry["timings"]["vlm_ms"],
            )
        )

    lines.extend(["", "## 상위 3개 후보 채점 및 실패 원인", ""])
    for entry in entries:
        detail = entry.get("judge_detail") or {}
        lines.append(f"### {entry['id']} — {entry['query']}")
        lines.append("")
        lines.append(
            f"- 심판 점수: **{judge_display(entry)}** / 규칙 검사: {entry['rule_check']} / 실패 단계: **{(detail.get('failure_stage') or '-') if detail else '미실행'}**"
        )
        lines.append(f"- 원인: {detail.get('failure_reason') if detail else '-'}")
        if entry["error"]:
            lines.append(f"- 검색 오류: {entry['error']}")
        judged = {str(item.get("id")): item for item in (detail.get("items") or []) if isinstance(item, dict)}
        lines.append("")
        lines.append("| 후보 ID | 물품명 | 공식 색상 | 사진 점수 | 등급 | 심판 점수 | 이유 |")
        lines.append("|---|---|---|---:|---|---:|---|")
        if not entry["top_items"]:
            lines.append("| - | (결과 없음) | - | - | - | - | - |")
        for item in entry["top_items"]:
            verdict = judged.get(str(item.get("id")), {})
            lines.append(
                "| {id} | {name} | {color} | {visual} | {tier} | {score} | {reason} |".format(
                    id=str(item.get("id") or ""), name=str(item.get("name") or "").replace("|", "\\|"),
                    color=str(item.get("color") or ""), visual=item.get("visualScore") or 0,
                    tier=item.get("matchLabel") or "", score=verdict.get("score", "-"),
                    reason=str(verdict.get("reason") or "-").replace("|", "\\|").replace("\n", " "),
                )
            )
        lines.append("")

    md_path.write_text("\n".join(lines), encoding="utf-8")
    return md_path, csv_path


def write_comparison(on_entries: list[dict[str, Any]], off_entries: list[dict[str, Any]], report_dir: Path) -> Path:
    on_stats = summarize(on_entries)
    off_stats = summarize(off_entries)
    report_dir.mkdir(parents=True, exist_ok=True)

    headers = ["지표", "YOLO ON", "YOLO OFF", "차이(OFF-ON)"]
    rows: list[list[Any]] = []
    for label, key in (
        ("VLM 심판 평균 점수", "judge_score"),
        ("규칙 검사 통과율(%)", "passed_rate"),
        ("전처리/YOLO (ms)", "preprocess_yolo_ms"),
        ("CLIP 임베딩 (ms)", "clip_ms"),
        ("DB 벡터·필터 조회 (ms)", "filter_ms"),
        ("VLM 리랭킹 (ms)", "vlm_ms"),
        ("단계 합계 (ms)", "total_stage_ms"),
        ("벽시계 시간 (ms)", "wall_ms"),
    ):
        if key == "judge_score" and not (on_stats["judge_ran"] and off_stats["judge_ran"]):
            rows.append([label, "미실행", "미실행", "-"])
            continue
        on_value = float(on_stats[key])
        off_value = float(off_stats[key])
        rows.append([label, f"{on_value:.1f}", f"{off_value:.1f}", f"{off_value - on_value:+.1f}"])

    print_table(headers, rows, title="YOLO ON/OFF 비교 (시나리오 평균)")

    lines = [
        "# YOLO ON/OFF 비교 리포트",
        "",
        f"동일한 {len(on_entries)}개 시나리오·동일한 AI 해석 계획을 사용하고, YOLOE 가용성만 전환했습니다.",
        "",
        "| 지표 | YOLO ON | YOLO OFF | 차이(OFF-ON) |",
        "|---|---:|---:|---:|",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(cell) for cell in row) + " |")
    lines.extend([
        "",
        "## 시나리오별 점수 차이",
        "",
        "| ID | 질의 | ON 점수 | OFF 점수 | 차이 | ON 실패단계 | OFF 실패단계 |",
        "|---|---|---:|---:|---:|---|---|",
    ])
    off_by_id = {entry["id"]: entry for entry in off_entries}
    for on in on_entries:
        off = off_by_id.get(on["id"])
        if not off:
            continue
        on_detail = on.get("judge_detail") or {}
        off_detail = off.get("judge_detail") or {}
        if on_detail and off_detail:
            diff_text = f"{off['judge_score'] - on['judge_score']:+d}"
        else:
            diff_text = "-"
        lines.append(
            f"| {on['id']} | {on['query'].replace('|', chr(92) + '|')} | {judge_display(on)} | "
            f"{judge_display(off)} | {diff_text} | {on_detail.get('failure_stage', '-') if on_detail else '미실행'} | {off_detail.get('failure_stage', '-') if off_detail else '미실행'} |"
        )
    path = report_dir / "compare_yolo.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"비교 리포트 저장: {path}")
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--scenarios", type=Path, default=DEFAULT_SCENARIOS, help="시나리오 JSON 경로")
    parser.add_argument("--reports", type=Path, default=DEFAULT_REPORTS, help="리포트 저장 폴더")
    parser.add_argument("--rows", type=int, default=20, help="검색 1회당 요청 행 수(기본 20)")
    parser.add_argument("--timeout", type=float, default=600.0, help="검색 작업 대기 시간(초)")
    parser.add_argument("--limit", type=int, default=None, help="앞에서 N개 시나리오만 실행(스모크 테스트)")
    parser.add_argument("--ids", default=None, help="쉼표로 구분한 시나리오 ID만 실행(예: S14,S20)")
    parser.add_argument("--no-judge", action="store_true", help="VLM 심판 호출 생략(속도/타이밍만 측정)")
    parser.add_argument("--quiet", action="store_true", help="검색별 단계 표 출력 생략")


def run_suite(
    client: Any,
    scenarios: list[dict[str, Any]],
    use_yolo: bool,
    plan_cache: dict[str, Any],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    install_instrumentation()
    try:
        for index, scenario in enumerate(scenarios, start=1):
            print(f"[{index}/{len(scenarios)}] {scenario.get('id')} {scenario.get('query')} (YOLO {'ON' if use_yolo else 'OFF'})")
            entry = run_search(client, scenario, use_yolo, plan_cache, args.rows, args.timeout)
            if not args.no_judge:
                judge_entry(entry)
            else:
                entry["rule_check"] = rule_check(scenario, entry["top_items"], entry["error"])
            entries.append(entry)

            if not args.quiet:
                timings = entry["timings"]
                print_table(
                    ["단계", "시간(ms)", "비고"],
                    [
                        ["전처리/YOLO", f'{timings["preprocess_yolo_ms"]:.1f}',
                         f'다운로드 {timings["download_ms"]:.1f} / YOLO {timings["yolo_ms"]:.1f}'],
                        ["CLIP 임베딩", f'{timings["clip_ms"]:.1f}', "이미지·텍스트 임베딩"],
                        ["DB 벡터·필터 조회", f'{timings["filter_ms"]:.1f}', "공개 API 스캔 + 로컬 필터 포함"],
                        ["VLM 리랭킹", f'{timings["vlm_ms"]:.1f}', "census·fallback·설명 호출 합계"],
                        ["합계 / 반환 후보", f'{timings["total_stage_ms"]:.1f}',
                         f'{entry["returned"]}건 반환 (전체 {entry["total"]}건), 벽시계 {entry["wall_ms"]:.1f}ms'],
                    ],
                    title=f'  [{entry["id"]}] 단계별 병목 / 최종 후보 수',
                )
            if entry["error"]:
                print(f"  ! 검색 오류: {entry['error']}")
    finally:
        restore_instrumentation()
    return entries


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate_parser = subparsers.add_parser("generate", help="20개 시나리오 JSON 생성")
    generate_parser.add_argument("--out", type=Path, default=DEFAULT_SCENARIOS)

    run_parser = subparsers.add_parser("run", help="시나리오 실행 + 심판 + 리포트")
    add_common(run_parser)
    yolo_group = run_parser.add_mutually_exclusive_group()
    yolo_group.add_argument("--use-yolo", dest="use_yolo", action="store_true", default=True)
    yolo_group.add_argument("--no-yolo", dest="use_yolo", action="store_false")
    run_parser.add_argument("--name", default=None, help="리포트 파일 이름(기본 report_yolo_on/off)")

    compare_parser = subparsers.add_parser("compare", help="YOLO ON/OFF 비교 실행")
    add_common(compare_parser)

    args = parser.parse_args()

    if args.command == "generate":
        generate_scenarios(args.out)
        return 0

    from fastapi.testclient import TestClient
    from app.main import app

    scenarios = load_scenarios(args.scenarios, args.limit)
    if getattr(args, "ids", None):
        wanted = {item.strip() for item in args.ids.split(",") if item.strip()}
        scenarios = [item for item in scenarios if str(item.get("id")) in wanted]
        if not scenarios:
            raise SystemExit(f"일치하는 시나리오가 없습니다: {args.ids}")
    plan_cache: dict[str, Any] = {}
    print(f"시나리오 {len(scenarios)}개 / 리포트 폴더 {args.reports}")

    with TestClient(app) as client:
        if args.command == "run":
            entries = run_suite(client, scenarios, args.use_yolo, plan_cache, args)
            name = args.name or ("report_yolo_on" if args.use_yolo else "report_yolo_off")
            md_path, csv_path = write_reports(entries, args.reports, name)
            stats = summarize(entries)
            print_table(
                ["지표", "값"],
                [
                    ["규칙 검사 통과율", f"{stats['passed_rate']}%"],
                    ["VLM 심판 평균", f"{stats['judge_score']}점" if stats["judge_ran"] else "미실행"],
                    ["단계 평균 합계", f"{stats['total_stage_ms']}ms"],
                ],
                title=" 전체 요약",
            )
            print(f"리포트 저장: {md_path}, {csv_path}")
            return 0

        # compare: AI 해석 계획은 공유해 VLM 호출을 절약한다.
        entries_on = run_suite(client, scenarios, True, plan_cache, args)
        entries_off = run_suite(client, scenarios, False, plan_cache, args)
        write_reports(entries_on, args.reports, "report_yolo_on")
        write_reports(entries_off, args.reports, "report_yolo_off")
        write_comparison(entries_on, entries_off, args.reports)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

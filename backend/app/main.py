from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Callable, Literal

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import ai_api, ai_pipeline, config, db, geo, image_similarity, kakao, local_vision, name_terms, police_api
from . import public_photo_api, recovery, search_period, security
from .schemas import (
    ACCOUNT_DELETE_CONFIRMATION,
    BrowseJobStart,
    BrowseJobStatus,
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
logger = logging.getLogger(__name__)

# 사진 분석은 느려도 놓치지 않는 쪽을 택한다. 스캔한 공개 사진을 여러 번에 나눠 본다.
VISUAL_SCAN_CAP = 60
VISUAL_BATCH_SIZE = 8
VISUAL_MATCH_MIN = 40
# 40점부터 사진 점수를 남기고, 50점부터 '사진 특징이 맞음'으로 등급도 올린다.
VISUAL_STRONG_MIN = 50
# 정렬 키·임계값·웹 참고 정책을 바꿀 때만 올린다. 캐시가 옛 규칙을 계속 쓰지 않게 한다.
BROWSE_ALGO_VERSION = 22


def _browse_page_cap(payload: "LostFoundBrowseRequest") -> int:
    """더 찾아보기에서는 더 오래된 페이지까지 허용한다(최대 24페이지)."""
    extra = max(0, getattr(payload, "skipVisual", 0)) // VISUAL_SCAN_CAP
    return min(payload.maxPages, min(config.LOSTFOUND_BROWSE_PAGE_CAP * (1 + extra), 24))


def _next_browse_page_cap(payload: "LostFoundBrowseRequest", previous: dict) -> int:
    return min(previous["_browsePageCap"] + config.LOSTFOUND_BROWSE_PAGE_CAP, payload.maxPages, 24)


def _normalize_prior_scores(payload: "LostFoundBrowseRequest") -> dict[str, int]:
    """이전 탐색에서 얻은 사진 점수만 되살린다. 잘못된 값은 캐시 키에서도 제외한다."""
    raw = getattr(payload, "priorVisualScores", None) or {}
    return {
        str(key): value
        for key, value in raw.items()
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100
    }


def _restore_visual_scores(result: dict, scores: dict[str, int]) -> None:
    """사전 점수를 전체 후보에 다시 붙인다. 같은 문구가 중복 쌓이지 않게 정리한다."""
    if not scores:
        return
    for item in (result.get("allItems") or result.get("items") or []):
        score = scores.get(item["id"])
        if not score:
            continue
        ai = item.get("aiMatch") or {"hits": [], "allInclude": False}
        hits = [hit for hit in (ai.get("hits") or []) if not str(hit).startswith("사진 특징 ")]
        hits.append(f"사진 특징 {score}점")
        item["aiMatch"] = {**ai, "hits": hits}
        item["visualScore"] = score
        if score >= VISUAL_STRONG_MIN and item.get("matchTier", 5) > 1:
            item["matchTier"] = 1
            item["matchLabel"] = "AI 사진 일치"


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

# 확인실 화면이 모델/검색 방식/알고리즘을 개별로 설명하고 요청을 보낼 때 쓰는 공통 목록.
# 화면은 이 API를 그대로 읽으므로 설명과 실제 코드를 한곳에서 관리한다.
PIPELINE_ALGORITHMS = [
    {
        "id": "model-multimodal",
        "kind": "AI 모델",
        "title": "공용 멀티모달 · gpt-6-luna",
        "pipeline": "search-prepare",
        "summary": "현재 로컬 설정에서 말과 사진을 함께 해석하는 외부 모델이다.",
        "input": ["검색 문장","사용자가 첨부한 F2 참고 사진","비교 대상 공개 사진·설명"],
        "steps": ["F1에서 검색 문장을 정리하고, F2에서 참고 사진을 설명한 뒤 검색 계획을 만든다.","공개 사진 비교, 설명 재정렬, 검색어 다듬기에 같은 설정을 쓴다.","llm·vlm·vision 별칭은 모두 multimodal 역할로 연결된다."],
        "output": "사진 설명 · 검색 계획 · 관련도 점수 · 다듬은 문구",
        "rules": [{"label":"제공자","value":"openai-compatible"},{"label":"호출","value":"/chat/completions · 구조화 응답"}],
        "code": ["backend/app/config.py","backend/app/ai_pipeline.py","backend/app/ai_graph.py"],
        "failure": "역할과 경로에 따라 규칙 기반 조건, 로컬 비교 또는 기존 순서를 유지한다.",
        "scopes": ["전체","프롬프트","역할 라우팅","실패 폴백"],
        "related": ["algo-query-interpret","algo-visual-match","algo-context-rank"],
    },
    {
        "id": "model-similarity",
        "kind": "AI 모델",
        "title": "OpenCLIP · 로컬 임베딩",
        "pipeline": "candidate-compare",
        "summary": "사진과 문장의 벡터를 비교한다. 현재 런타임은 CPU OpenCLIP이다.",
        "input": ["사진","검색 문장·정리한 영문 특징"],
        "steps": ["ViT-B-32와 laion2b_s34b_b79k 가중치로 벡터를 만든다.","코사인 유사도를 사진과 문장 축 별로 보정한다.","갤러리 전체 비교와 공개 사진 로컬 대조 분기에서 사용한다."],
        "output": "512차원 벡터와 유사도 점수",
        "rules": [{"label":"사진↔사진 코사인 구간","value":"0.45–1.00"},{"label":"문장↔사진 코사인 구간","value":"0.10–0.45"}],
        "code": ["backend/app/image_similarity.py","backend/app/gallery_rank.py"],
        "failure": "공개 사진 일부 분기는 외부 멀티모달로 넘어간다. 갤러리는 로컬 환경에서 점수 계산 실패를 처리한다.",
        "scopes": ["전체","임베딩","점수 보정","모델 교체"],
        "related": ["model-yoloe","algo-gallery-compare","algo-visual-match","model-mobileclip"],
    },
    {
        "id": "model-yoloe",
        "kind": "AI 모델",
        "title": "YOLOE · 공개 사진 관심 영역",
        "pipeline": "public-visual-match",
        "summary": "yoloe-11s-seg.pt 사전학습 가중치를 쓴다. 설정상 활성이고 로컬에서 실제 탐지를 실행했다.",
        "input": ["공개 사진 또는 공개 검색의 참고 사진","품목의 탐지 라벨"],
        "steps": ["로컬 비교 분기에서 객체 수와 종류를 탐지한다. VLM 집계가 쓰이는 경우 함께 판단한다.","객체 2개 이상 또는 종류 2가지 이상이고 요청 라벨과 유효한 영역이 맞으면 상자를 골라 잘라 비교한다.","공개 VLM 우선 경로와 갤러리 기본 경로는 YOLOE를 건너뛸 수 있다. 갤러리 기본 경로는 항상 직접 임베딩한다."],
        "output": "선택적 비교용 크롭과 원본 후보",
        "rules": [{"label":"가중치","value":"yoloe-11s-seg.pt · 프로젝트 추가 학습 없음"},{"label":"로컬 샘플 관찰","value":"지갑·가방 탐지 실행 · 요청 라벨 크롭 미선택"}],
        "code": ["backend/app/local_vision.py","backend/app/ai_graph.py"],
        "failure": "유효한 대상 상자가 없거나 탐지·크롭이 실패하면 원본을 쓴다.",
        "scopes": ["전체","실행 조건","라벨","크롭 비교 평가"],
        "related": ["model-similarity","algo-visual-match"],
    },
    {
        "id": "model-mobileclip",
        "kind": "AI 모델",
        "title": "MobileCLIP BLT · 파일 보유",
        "pipeline": "candidate-compare",
        "summary": "mobileclip_blt.ts 가중치 파일이 있다. 현재 검색 경로에서 호출 증거가 없다.",
        "input": ["로컬 가중치 파일"],
        "steps": ["실행 구성을 확인하면 imageSimilarity는 OpenCLIP ViT-B-32를 가리킨다.","MobileCLIP을 비교하려면 별도 런타임 연결과 같은 검증 세트에서의 실험이 필요하다."],
        "output": "현재 검색 결과에 기여하는 경로 미확인",
        "rules": [{"label":"상태","value":"파일 보유 · 추론 연동 미확인"}],
        "code": ["backend/data/models/mobileclip_blt.ts","backend/app/image_similarity.py"],
        "failure": "장치별 속도와 순위 품질은 측정 후 판단한다.",
        "scopes": ["전체","모델 연결","벤치마크"],
        "related": ["model-similarity","algo-gallery-compare"],
    },
    {
        "id": "algo-query-interpret",
        "kind": "검색 방식",
        "title": "자연어·참고 사진 → 탐색 힌트",
        "pipeline": "search-prepare",
        "summary": "품목·고유명사·시각 특징·기간을 구조화한다. 사용자가 적용한 필터는 별도로 유지된다.",
        "input": ["검색 문장","F2 참고 사진 최대 6장","현재 날짜"],
        "steps": ["F2에 사진이 있으면 설명을 먼저 만들고, 검색 문장과 연결해 계획을 만든다.","apiKeywords·include·any·exclude·imageFeatures·기간 후보를 정리한다.","품목과 수식어를 분리해 탐색하되, 현재 후보 수집에는 키워드와 일부 품목 우선순위의 영향이 남는다."],
        "output": "AiSearchPlan과 공개 조회 단서",
        "rules": [{"label":"공개 탐색","value":"이름 조회와 품목 우선·기간 목록 조회를 병행"},{"label":"기간","value":"직접 선택한 기간 우선. 자연어로 말한 시점의 10일 전부터 오늘까지, 최대 6개월. 날짜가 없으면 최근 2개월."}],
        "code": ["backend/app/ai_graph.py","backend/app/ai_pipeline.py","backend/prompts/interpret_search.txt","frontend/src/features/search/ai-match-model.ts"],
        "failure": "모델 실패 시 원문 기반 검색을 계속한다.",
        "scopes": ["전체","고유명사","기간 표현","품목과 수식어"],
        "related": ["algo-code-filter","algo-text-tiers","algo-web-reference"],
    },
    {
        "id": "algo-code-filter",
        "kind": "검색 방식",
        "title": "공식 코드 · 사용자가 적용한 필터",
        "pipeline": "direct-search",
        "summary": "직접 찾기에서 적용한 필터를 공식 API 코드와 목록 조건으로 변환한다.",
        "input": ["사용자 선택 분류·색상·지역·기간","검색 모드"],
        "steps": ["분류·색상·지역·날짜를 소스가 지원하는 파라미터에 대응한다.","미지원 조건은 확보한 응답에서 적용한다.","F2 결과 필터는 조회한 후보에 적용하며, AI가 제안한 기간으로 전체 자료 수집 완료가 보장되지는 않는다."],
        "output": "선택 조건을 적용한 공개 후보",
        "rules": [{"label":"직접 찾기 탐색량","value":"기간 검색은 출처별 100건 단위 · 다음 페이지 위치 유지"},{"label":"기간 확보","value":"기간 내 이어 조회 · 출처별 완료 상태와 실패 보고"}],
        "code": ["backend/app/lostfound_codes.py","backend/app/police_api.py"],
        "failure": "일부 소스나 필터 요청 실패 시 확보한 결과와 오류를 확인한다.",
        "scopes": ["전체","코드 변환","기간","수집 범위"],
        "related": ["algo-query-interpret","algo-browse-more","algo-text-tiers"],
    },
    {
        "id": "algo-text-tiers",
        "kind": "알고리즘",
        "title": "직접 찾기 · 텍스트 등급",
        "pipeline": "direct-search",
        "summary": "직접 찾기 AI 결과에 텍스트 단서와 일치 유형을 반영한다.",
        "input": ["공개 물품명·설명·분류","검색어와 해석 단서"],
        "steps": ["일치 신호에 따라 등급과 라벨을 부여한다.","제목·본문·분류의 텍스트 신호를 합산한다.","가려진 이름 일부는 와일드카드로 비교한다."],
        "output": "텍스트 점수 · 등급 · 일치 라벨",
        "rules": [{"label":"텍스트 신호 가중","value":"제목 4 · 본문 2 · 분류 1"},{"label":"일반 검색","value":"별도로 실행하며 AI 등급으로 순서를 강제하지 않음"}],
        "code": ["backend/app/police_api.py"],
        "failure": "이름이 짧거나 설명이 적으면 텍스트 점수만으로 의도한 물건을 찾기 어렵다.",
        "scopes": ["전체","등급","와일드카드","텍스트 가중"],
        "related": ["algo-ranking","algo-visual-match"],
    },
    {
        "id": "algo-visual-match",
        "kind": "알고리즘",
        "title": "공개 사진 · 멀티모달/로컬 점수",
        "pipeline": "public-visual-match",
        "summary": "공개 후보 사진에만 시각 점수를 붙인다. 참조 이미지와 문장 양쪽을 활용할 수 있다.",
        "input": ["공개 사진","참고 사진 또는 검색 텍스트","웹 참고 특징"],
        "steps": ["VLM 우선이면 사진 원본을 외부 모델로 점수화한다. 로컬 분기는 선택적 YOLOE 크롭과 OpenCLIP을 사용한다.","F2는 한 차례 최대 96장, 12장씩 최대 두 요청을 병렬로 실행한다. 직접 찾기는 8장씩, 한 작업에서 최대 60장을 비교한다.","직접 찾기는 40점부터 사진 점수를 쓰고, 50점 이상이면 기존 약한 등급을 1로 올릴 수 있다."],
        "output": "공개 사진이 확인된 후보별 점수",
        "rules": [{"label":"직접 찾기 임계값","value":"40점 점수 채택 · 50점 등급 승격"},{"label":"조기 종료","value":"높은 점수에 도달했다는 이유로 스캔을 끝내는 규칙은 현재 제거"},{"label":"로컬 대체 분기","value":"갤러리와 공개 검색의 점수 규칙은 각각 적용"}],
        "code": ["backend/app/ai_graph.py","backend/app/image_similarity.py","backend/app/main.py","frontend/src/features/search/ai-match-model.ts"],
        "failure": "VLM·CLIP 호출 실패와 사진 없는 후보를 기록하고, 확보한 후보를 유지한다.",
        "scopes": ["전체","점수 기준","배치 크기","VLM·로컬 분기"],
        "related": ["model-yoloe","algo-web-reference","algo-ranking"],
    },
    {
        "id": "algo-ranking",
        "kind": "알고리즘",
        "title": "직접 찾기 · 최종 정렬과 페이지",
        "pipeline": "direct-search",
        "summary": "수집·비교한 후보 풀을 누적하여 정렬하고 한 페이지씩 보여준다.",
        "input": ["텍스트 등급·점수","사진 점수","습득일·ID"],
        "steps": ["등급 오름차순, 텍스트 점수×10+사진 점수 내림차순으로 정렬한다.","동점이면 최신 습득일과 ID 내림차순으로 정리한다.","이어 찾기가 보탠 후보도 병합 후 다시 정렬하고, 화면 페이지를 자른다."],
        "output": "현재 목록 · 수집한 총 결과 수",
        "rules": [{"label":"화면 페이지","value":"기본 40건"},{"label":"기간 커버리지","value":"결과 건수는 원천 전체 검색 완료를 뜻하지 않음"}],
        "code": ["backend/app/main.py","backend/app/police_api.py"],
        "failure": "후보가 없으면 빈 결과를 반환한다.",
        "scopes": ["전체","등급 우선","점수 가중","페이지네이션"],
        "related": ["algo-text-tiers","algo-visual-match","algo-browse-more"],
    },
    {
        "id": "algo-web-reference",
        "kind": "검색 방식",
        "title": "웹 참고 · 시각 단서 보강",
        "pipeline": "data-collect",
        "summary": "일부 고유명사의 공개 설명과 참고 사진을 검색 단서에 더한다.",
        "input": ["웹 참고 대상으로 선별한 물품 단서"],
        "steps": ["공개 위키·검색에서 설명과 썸네일을 얻는다.","확보한 설명과 사진은 공개 사진 비교의 보조 근거로 쓴다.","실제 습득물 후보는 공식 공개 API 목록에서 수집한다."],
        "output": "보강된 시각 특징 · 참고 이미지",
        "rules": [{"label":"캐시 기본값","value":"7일"},{"label":"참고 사진","value":"최대 2장"}],
        "code": ["backend/app/web_reference.py","backend/app/ai_graph.py"],
        "failure": "참고 자료 확보에 실패하면 기존 특징으로 비교를 계속한다.",
        "scopes": ["전체","검색 소스","고유명사","참고 사진 수"],
        "related": ["algo-query-interpret","algo-visual-match"],
    },
    {
        "id": "algo-browse-more",
        "kind": "검색 방식",
        "title": "직접 찾기 · 이어 검색과 누적",
        "pipeline": "direct-search",
        "summary": "이전 작업과 검색 범위가 일치하면 조회한 페이지 및 점수를 재사용한다.",
        "input": ["검색 문장·힌트·필터","previousJobId","기존 결과·점수"],
        "steps": ["서버 작업의 진행률을 브라우저가 약 0.9초마다 확인한다.","이어 검색은 미조회 API 페이지와 미비교 사진을 우선한다.","새 후보를 병합해서 순서를 다시 계산하고 기존 카드도 목록에 유지한다."],
        "output": "누적 후보와 재정렬 결과 · visualMore",
        "rules": [{"label":"서버 작업 보관","value":"30분"},{"label":"API 탐색 범위","value":"기간 검색에서 출처별 다음 페이지 이어 조회"}],
        "code": ["backend/app/main.py","backend/app/police_api.py","frontend/src/features/workspace/DirectSearchPage.tsx"],
        "failure": "서버 작업이 만료되면 일부 페이지를 다시 조회할 수 있으며 브라우저의 기존 결과는 유지한다.",
        "scopes": ["전체","누적","작업 만료","재사용"],
        "related": ["algo-code-filter","algo-visual-match","algo-ranking","algo-basic-fallback"],
    },
    {
        "id": "algo-basic-fallback",
        "kind": "검색 방식",
        "title": "일반 검색 · AI 검색 중 먼저 보기",
        "pipeline": "direct-search",
        "summary": "직접 찾기의 AI 검색과 별도로 일반 검색 목록을 제공한다.",
        "input": ["같은 검색 문장과 적용 필터"],
        "steps": ["일반 검색 모드에서 원문으로 조회한다.","0건이면 특징 단어를 규칙으로 추려 일반 검색을 다시 실행한다.","AI 검색 완료 뒤에도 아래 영역의 결과를 유지한다."],
        "output": "독립 일반 검색 결과",
        "rules": [{"label":"축약","value":"규칙 기반 키워드"},{"label":"미리보기","value":"PC 4건 · 모바일 2건"}],
        "code": ["frontend/src/features/workspace/DirectBasicResults.tsx","backend/app/police_api.py"],
        "failure": "원문과 축약 검색이 모두 0건이면 빈 목록을 안내한다.",
        "scopes": ["전체","일반 검색","키워드 축약","미리보기"],
        "related": ["algo-browse-more","algo-text-tiers"],
    },
    {
        "id": "algo-gallery-compare",
        "kind": "검색 방식",
        "title": "갤러리 · 연결 사진 전체 로컬 비교",
        "pipeline": "candidate-compare",
        "summary": "연결한 사진과 스크린샷 전체를 기기에서 벡터 비교한다.",
        "input": ["참고 사진과 검색 문장","연결된 전체 사진"],
        "steps": ["브라우저가 사진을 축소하고 로컬 서비스에 16장씩 보낸다. 원본과 연결 기록은 기기에 남는다.","사진 벡터와 문장 벡터를 비교한다. 같은 파일의 해시가 일치하면 3개 결과에서 우선한다.","종합은 이미지 30%·맥락 70%를 적용한다. 한 축만 있으면 사용할 수 있는 축을 사용한다."],
        "output": "종합 · 이미지 · 맥락 결과와 미리보기",
        "rules": [{"label":"처리 범위","value":"연결한 전체 사진 · 미리보기 4장 · 더보기 페이지 12장"},{"label":"저장","value":"브라우저 IndexedDB 파일·기록 · 벡터 메모리 캐시"}],
        "code": ["backend/app/gallery_rank.py","frontend/src/features/search/gallery-local-rank.ts"],
        "failure": "로컬 모델과 썸네일 처리 실패를 표시한다. F1 검색 문장 해석에는 외부 모델을 사용할 수 있다.",
        "scopes": ["전체","전체 비교","동일 파일","로컬 경계"],
        "related": ["model-similarity","algo-context-rank"],
    },
    {
        "id": "algo-context-rank",
        "kind": "검색 방식",
        "title": "분실물 · 설명 맥락과 3개 결과",
        "pipeline": "context-rank",
        "summary": "현재 페이지의 설명 정보를 문장과 대조하고 사진 결과를 독립적으로 유지한다.",
        "input": ["현재 페이지 후보의 제목·설명·습득 장소 최대 12건","검색 문장·참고 사진의 해석"],
        "steps": ["설명 점수가 사진 존재 여부에 좌우되지 않도록 별도 계산한다.","사진이 있는 후보는 시각 점수를 따로 적용하고, 채널 통합에는 큰 점수와 작은 점수의 10%를 합한다.","현재 후보의 추천·설명·사진 결과를 표시한다. 같은 공개 이미지의 반복 노출을 줄인다."],
        "output": "추천 후보 · 설명이 잘 맞는 후보 · 사진이 닮은 후보",
        "rules": [{"label":"맥락 AI 비교","value":"현재 페이지 후보 최대 12건"},{"label":"사진 결과","value":"유효한 사진과 40점 이상 시각 점수"}],
        "code": ["backend/app/ai_pipeline.py","frontend/src/features/search/ai-match-model.ts"],
        "failure": "맥락 채점 실패 시 확보한 검색 근거를 사용한다.",
        "scopes": ["전체","맥락 재정렬","사진 없는 후보","중복 사진"],
        "related": ["model-multimodal","algo-visual-match","algo-query-interpret"],
    },
]
PIPELINE_TARGETS = {item["id"] for item in PIPELINE_ALGORITHMS}

# 확인실 각 화면 아래에 보여줄 '수정해야 할 것들'. 화면은 /api/pipeline/issues로 이걸 읽고,
# requests.json의 issueId와 대조해 '요청됨' 상태를 실시간으로 갱신한다.
# 필수=동작·정확도에 직접 영향, 추천=품질 개선, 선택=여유 있을 때 손보면 좋은 항목.
PIPELINE_ISSUES = [
    {"id": "home-1", "page": "home", "priority": "추천", "title": "정렬식·임계값 문구를 코드와 주기적으로 대조", "detail": "Home의 결과 순서·점수 설명이 main.py의 실제 규칙(등급 → 텍스트×10+사진, 40점 표시/50점 승격)과 어긋나지 않는지 확인한다.", "pipeline": "audit", "target": ""},
    {"id": "home-2", "page": "home", "priority": "선택", "title": "'부분 연결' 파이프라인 카드 갱신", "detail": "실제 구현 범위가 넓어진 항목은 카드의 연결 상태와 설명을 함께 고친다.", "pipeline": "audit", "target": ""},
    {"id": "gallery-prepare-1", "page": "gallery-prepare", "priority": "필수", "title": "전체 연결 범위 검증", "detail": "중첩 폴더·스크린샷·중복 이미지가 있는 갤러리로 처리 장수와 표시 장수를 대조한다.", "pipeline": "candidate-compare", "target": ""},
    {"id": "gallery-prepare-2", "page": "gallery-prepare", "priority": "추천", "title": "사진·문장 입력 유형별 검색", "detail": "참고 사진 한 장, 문장만, 둘 다 넣었을 때 로컬 비교와 오류 복구를 각각 확인한다.", "pipeline": "candidate-compare", "target": ""},
    {"id": "gallery-compare-1", "page": "gallery-compare", "priority": "추천", "title": "같은 사진과 다른 구도 평가", "detail": "동일 바이트 우선과 다른 구도 재현율을 분리해 측정한다. 갤러리 기본 비교에서 YOLOE는 사용하지 않는다.", "pipeline": "candidate-compare", "target": "model-yoloe"},
    {"id": "gallery-result-1", "page": "gallery-result", "priority": "추천", "title": "종합·이미지·맥락 3축 가중치 근거 명시", "detail": "점수 합산 방식과 가중치 값을 결과 화면에서 바로 볼 수 있게 정리한다.", "pipeline": "candidate-compare", "target": "algo-gallery-compare"},
    {"id": "gallery-result-2", "page": "gallery-result", "priority": "선택", "title": "결과 카드 접근성 라벨 점검", "detail": "사진 대체 텍스트와 버튼 이름이 스크린리더에서 읽히는지 확인한다.", "pipeline": "candidate-compare", "target": ""},
    {"id": "lost-prepare-1", "page": "lost-prepare", "priority": "필수", "title": "자연어 기간 파싱 실패 시 안내", "detail": "'지난달쯤' 같은 말을 날짜로 못 바꿀 때 조용히 필터를 버리지 말고 사용자에게 알린다.", "pipeline": "search-prepare", "target": "algo-query-interpret"},
    {"id": "lost-prepare-2", "page": "lost-prepare", "priority": "추천", "title": "웹 참고 실패 시 대체 경로 안내", "detail": "인터넷 참고가 실패해도 특징만으로 비교를 계속한다는 점을 화면에 표시한다.", "pipeline": "search-prepare", "target": "algo-web-reference"},
    {"id": "lost-visual-1", "page": "lost-visual", "priority": "필수", "title": "공개 사진 비교 누락 추적", "detail": "조회·사진 확보·채점 성공 건수를 분리한다. 50점 등급 승격은 직접 찾기의 규칙이다.", "pipeline": "public-visual-match", "target": "algo-visual-match"},
    {"id": "lost-visual-2", "page": "lost-visual", "priority": "추천", "title": "YOLOE 크롭 효과 비교", "detail": "공개 검색에서 같은 후보를 원본+VLM, 원본+CLIP, YOLOE+CLIP으로 비교해 채택률·정확도·지연을 측정한다.", "pipeline": "public-visual-match", "target": "model-multimodal"},
    {"id": "lost-context-1", "page": "lost-context", "priority": "필수", "title": "설명과 사진 각각의 재현율 측정", "detail": "사진만 있는 목록, 사진 없는 상세 설명, 두 정보가 있는 목록을 나눠 추천·설명·사진 3개 채널을 검증한다.", "pipeline": "context-rank", "target": "algo-context-rank"},
    {"id": "lost-context-2", "page": "lost-context", "priority": "추천", "title": "다음 페이지 후보의 맥락 확인", "detail": "페이지당 12건 맥락 비교와 이전 기록의 계산 상태를 표시해, 조각 조회를 전체 순위로 오해하지 않게 한다.", "pipeline": "context-rank", "target": "algo-ranking"},
    {"id": "direct-prepare-1", "page": "direct-prepare", "priority": "필수", "title": "고유명사 탐색어 우선 유지 회귀", "detail": "'치이카와 카드'에서 고유명사가 apiKeywords에서 밀려 일반 카드보다 뒤로 가지 않는지 정기 확인한다.", "pipeline": "direct-search", "target": "algo-query-interpret"},
    {"id": "direct-prepare-2", "page": "direct-prepare", "priority": "추천", "title": "자연어 기간과 적용 기간 분리", "detail": "AI가 추정한 기간은 확인할 수 있게 하고, 사용자가 적용한 기간 전체의 소스별 조회 범위를 검사한다.", "pipeline": "direct-search", "target": "algo-code-filter"},
    {"id": "direct-browse-1", "page": "direct-browse", "priority": "필수", "title": "공식 코드 필터 사용 시 사진 스캔 풀 확보", "detail": "필터 결과 40건만 읽고 멈추면 사진 분석·더 찾아보기가 꺼진다. visual_need 전달이 유지되는지 본다.", "pipeline": "direct-search", "target": "algo-code-filter"},
    {"id": "direct-browse-2", "page": "direct-browse", "priority": "추천", "title": "최근 2개월 자동 수집 평가", "detail": "출처별 남은 페이지 수와 쿼터를 측정해 자동 수집 시 안전한 배치 크기를 정한다.", "pipeline": "direct-search", "target": "algo-browse-more"},
    {"id": "direct-result-1", "page": "direct-result", "priority": "필수", "title": "상세 → 뒤로가기 결과 복원 확인", "detail": "마지막 검색어·결과 40건·더 찾아보기 상태가 그대로 되살아나는지 회귀 테스트한다.", "pipeline": "direct-search", "target": "algo-browse-more"},
    {"id": "direct-result-2", "page": "direct-result", "priority": "추천", "title": "실패 배치 재분석 결과 반영", "detail": "AI 호출이 실패한 사진은 분석 장수에서 제외되므로 더 찾아보기에서 다시 볼 수 있다는 안내를 붙인다.", "pipeline": "direct-search", "target": "algo-visual-match"},
    {"id": "common-web-1", "page": "common-web", "priority": "추천", "title": "웹 참고 실패 시 빈 값 대체 안내", "detail": "프록시·이미지 요청이 막히면 특징만으로 진행한다는 사실을 로그와 화면에 남긴다.", "pipeline": "data-collect", "target": "algo-web-reference"},
    {"id": "common-web-2", "page": "common-web", "priority": "선택", "title": "참고 이미지 개수 상한 근거 표기", "detail": "이미지 최대 장수와 이름 설명 조회가 분리되어 있다는 점을 확인실에 적는다.", "pipeline": "data-collect", "target": "algo-web-reference"},
    {"id": "common-base-1", "page": "common-base", "priority": "필수", "title": "요청 저장 원자성·ID 중복 회귀 유지", "detail": "UUID가 붙은 요청 ID와 임시 파일 교체 방식이 깨지지 않게 테스트를 유지한다.", "pipeline": "audit", "target": ""},
    {"id": "common-base-2", "page": "common-base", "priority": "추천", "title": "캐시 TTL과 알고리즘 버전 관계 정리", "detail": "규칙을 바꿀 때 BROWSE_ALGO_VERSION을 올려야 캐시가 옛 결과를 계속 주지 않는다.", "pipeline": "audit", "target": ""},
    {"id": "audit-1", "page": "audit", "priority": "필수", "title": "requests.json pending 항목 정리", "detail": "처리 끝난 요청은 상태를 바꾸거나 목록에서 정리해 다음 AI 요청이 헷갈리지 않게 한다.", "pipeline": "audit", "target": ""},
    {"id": "audit-2", "page": "audit", "priority": "추천", "title": "요청함 필터·개수 표시 사용성 점검", "detail": "대상별 필터와 건수 표시가 실제 요청 목록과 항상 일치하는지 확인한다.", "pipeline": "audit", "target": ""},
    {"id": "algo-map-1", "page": "algo-map", "priority": "추천", "title": "알고리즘 카드와 코드 위치 대조", "detail": "카드의 설명·임계값·코드 경로가 실제 구현과 다른 항목을 찾아 갱신한다.", "pipeline": "audit", "target": ""},
    {"id": "algo-map-2", "page": "algo-map", "priority": "선택", "title": "관련 항목 이동 경로 점검", "detail": "'함께 보면 좋은 항목' 버튼이 자주 쓰이는 조합을 가리키는지 살펴본다.", "pipeline": "audit", "target": ""},
    {"id": "algo-ranking-1", "page": "algo-detail", "priority": "추천", "title": "동점 정렬 기준 문구·코드 동기화", "detail": "최신 습득일 다음 ID 내림차순으로 정렬하는 규칙을 상세 설명과 실제 코드 모두에 유지한다.", "pipeline": "direct-search", "target": "algo-ranking"},
    {"id": "algo-visual-match-1", "page": "algo-detail", "priority": "필수", "title": "모델 경로별 가시성 확보", "detail": "공개 VLM·로컬 CLIP·YOLOE 크롭·건너뜀·응답 실패 건수를 기록해 사진 채점 품질을 비교한다.", "pipeline": "public-visual-match", "target": "algo-visual-match"},
    {"id": "algo-browse-more-1", "page": "algo-detail", "priority": "추천", "title": "누적 탐색 재사용 검증", "detail": "같은 조건으로 이어 찾기 할 때 조회한 API 페이지·사진 점수를 재사용하고 미확인 후보만 추가하는지 본다.", "pipeline": "direct-search", "target": "algo-browse-more"},
    {"id": "algo-web-reference-1", "page": "algo-detail", "priority": "추천", "title": "이름 설명 조회와 이미지 상한 분리 유지", "detail": "참고 사진이 꽉 차도 낯선 이름의 설명은 계속 가져와야 한다.", "pipeline": "data-collect", "target": "algo-web-reference"},
    {"id": "algo-text-tiers-1", "page": "algo-detail", "priority": "추천", "title": "가려진 이름 와일드카드 과확장 검토", "detail": "*?●○×를 1~3글자로 치환하면 엉뚱한 이름까지 맞을 수 있다. 오탐을 줄일 방법을 찾는다.", "pipeline": "direct-search", "target": "algo-text-tiers"},
    {"id": "algo-code-filter-1", "page": "algo-detail", "priority": "필수", "title": "날짜 필드 검증 유지", "detail": "AI가 날짜가 아닌 말을 넣어도 YYYY-MM-DD만 남기고 역전된 기간은 바로잡는다.", "pipeline": "direct-search", "target": "algo-code-filter"},
    {"id": "model-multimodal-1", "page": "algo-detail", "priority": "선택", "title": "모델 버전 고정 여부 검토", "detail": "외부 모델 버전이 바뀌면 점수 기준도 달라진다. 고정·기록 방식을 정한다.", "pipeline": "search-prepare", "target": "model-multimodal"},
]
PIPELINE_ISSUE_IDS = {item["id"] for item in PIPELINE_ISSUES}


class PipelineRequestPayload(BaseModel):
    pipeline: str = Field(min_length=1, max_length=60)
    scope: str = Field(default="전체", max_length=120)
    message: str = Field(min_length=1, max_length=4000)
    target: str = Field(default="", max_length=60)
    issueId: str = Field(default="", max_length=80)


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
app.include_router(public_photo_api.router)


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


@app.get("/api/pipeline/algorithms", include_in_schema=False)
def pipeline_algorithms() -> dict:
    """확인실의 모델·검색 방식·알고리즘 설명. 비밀값은 포함하지 않는다."""
    return {"items": PIPELINE_ALGORITHMS}


@app.get("/api/pipeline/models", include_in_schema=False)
def pipeline_models() -> dict:
    """Return model names and configuration state without credentials or local paths."""
    provider, key, _, model = ai_pipeline._role_config("multimodal")
    overrides = []
    for role, label in (("llm", "문장 처리"), ("vlm", "사진 해석")):
        other_provider, other_key, _, other_model = ai_pipeline._role_config(role)
        if (other_provider, other_model, bool(other_key)) != (provider, model, bool(key)):
            overrides.append({"label": label, "provider": other_provider, "model": other_model})
    public_similarity = image_similarity.status_payload()
    if public_similarity["provider"] != "local-clip" and public_similarity["available"]:
        overrides_for_clip = [{
            "label": "공개 검색의 별도 유사도 모델",
            "provider": public_similarity["provider"],
            "model": public_similarity["model"],
        }]
    else:
        overrides_for_clip = []
    mobile_weights = config.DATA_DIR / "models" / "mobileclip_blt.ts"
    return {"items": {
        "model-multimodal": {
            "model": model, "provider": provider,
            "state": "configured" if key and model and provider == "openai-compatible" else "unavailable",
            "overrides": overrides,
        },
        "model-similarity": {
            "model": config.LOCAL_CLIP_MODEL, "weights": config.LOCAL_CLIP_PRETRAINED,
            "provider": "OpenCLIP", "state": "configured" if local_vision.clip_available() else "unavailable",
            "overrides": overrides_for_clip,
        },
        "model-yoloe": {
            "model": config.YOLOE_MODEL.replace("\\", "/").rsplit("/", 1)[-1],
            "provider": "Ultralytics", "state": "conditional" if local_vision.yoloe_available() else "unavailable",
        },
        "model-mobileclip": {
            "model": "MobileCLIP BLT", "weights": mobile_weights.name,
            "state": "weights-only" if mobile_weights.is_file() else "unlinked",
        },
    }}


@app.get("/api/pipeline/requests", include_in_schema=False)
def pipeline_requests() -> dict:
    return {"items": _read_pipeline_requests()}


@app.get("/api/pipeline/issues", include_in_schema=False)
def pipeline_issues() -> dict:
    """화면별 수정 필요 항목 + 요청함과 대조한 실시간 상태."""
    rows = _read_pipeline_requests()
    counts: dict[str, int] = {}
    done_ids: set[str] = set()
    for row in rows:
        issue_id = row.get("issueId")
        if not issue_id:
            continue
        counts[issue_id] = counts.get(issue_id, 0) + 1
        if str(row.get("status") or "").lower() in {"done", "resolved", "completed"}:
            done_ids.add(issue_id)
    items = [
        {
            **issue,
            "requested": issue["id"] in counts,
            "requestCount": counts.get(issue["id"], 0),
            # AI가 요청을 처리 완료로 바꾸면 화면도 바로 '완료'로 바뀐다.
            "state": "done" if issue["id"] in done_ids else ("requested" if issue["id"] in counts else "open"),
        }
        for issue in PIPELINE_ISSUES
    ]
    return {"items": items, "updatedAt": utc_now()}


@app.post("/api/pipeline/request", include_in_schema=False)
def create_pipeline_request(payload: PipelineRequestPayload) -> dict:
    """파이프라인 화면의 수정 요청을 로컬 파일에 적는다. 비밀값은 받지 않는다."""
    pipeline = payload.pipeline.strip()
    if pipeline not in PIPELINE_IDS:
        raise api_error(400, "invalid_pipeline", "알 수 없는 파이프라인이에요.")
    target = payload.target.strip()
    if target and target not in PIPELINE_TARGETS:
        raise api_error(400, "invalid_target", "알 수 없는 알고리즘이에요.")
    issue_id = payload.issueId.strip()
    if issue_id and issue_id not in PIPELINE_ISSUE_IDS:
        raise api_error(400, "invalid_issue", "알 수 없는 수정 항목이에요.")
    item = {
        "id": f"req-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}",
        "createdAt": utc_now(),
        "status": "pending",
        "pipeline": pipeline,
        "target": target,
        "scope": payload.scope.strip() or "전체",
        "issueId": issue_id,
        "message": payload.message.strip(),
    }
    with PIPELINE_REQUEST_LOCK:
        PIPELINE_DIR.mkdir(parents=True, exist_ok=True)
        path = PIPELINE_DIR / "requests.json"
        rows = _read_pipeline_requests()
        rows.append(item)
        # 임시 파일에 쓴 뒤 교체해, 저장 중단으로 requests.json이 깨지지 않게 한다.
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(
            json.dumps(rows[-200:], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
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
            "originalQuery": payload.originalQuery.strip(),
            "photoSearch": payload.photoSearch,
            "photoCategory": payload.photoCategory.strip(),
            "period": search_period.resolve_period(
                {"from": payload.fromDate, "to": payload.toDate}, payload.hints,
                query=payload.originalQuery or payload.keyword,
            ) if payload.periodSearch else None,
            "periodCursor": payload.periodCursor.model_dump() if payload.periodCursor else None,
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return "search:v3:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _lostfound_list_key(payload: LostFoundListRequest) -> str:
    raw = json.dumps({"page": payload.page, "rows": payload.rows}, sort_keys=True)
    return "list:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _lostfound_browse_key(payload: LostFoundBrowseRequest) -> str:
    raw = json.dumps(
        {
            "v": BROWSE_ALGO_VERSION,
            "keyword": payload.keyword.strip(),
            # 페이지는 화면에서 자른다. 페이지별로 다시 스캔·AI 분석하지 않도록 키에서 제외한다.
            "rows": payload.rows,
            # 실제 스캔에 쓰이는 값이어야 같은 결과끼리 캐시를 공유한다.
            "effectiveMaxPages": _browse_page_cap(payload),
            "skipVisual": payload.skipVisual,
            "priorVisualScores": _normalize_prior_scores(payload),
            "hints": payload.hints or {},
            "searchMode": payload.searchMode,
            "filters": payload.filters,
            "period": search_period.resolve_period(
                payload.filters, payload.hints if payload.searchMode == "ai" else None,
                query=payload.keyword if payload.searchMode == "ai" else "",
            ) if payload.periodSearch else None,
            "periodCursor": payload.periodCursor.model_dump() if payload.periodCursor else None,
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


def _rank_browse_result(result: dict, hints: dict, keyword: str, page: int, rows: int) -> dict:
    """등급 → 텍스트 신호·사진 점수 → 최신순으로 전체 후보를 정렬하고 현재 페이지만 돌려준다."""
    pool = result.get("allItems") or result.get("items") or []
    if not pool:
        return result
    for row in pool:
        row["rankingScore"] = police_api.text_signal_score(row, hints, keyword) * 10 + (row.get("visualScore") or 0)
    pool.sort(key=lambda row: (row.get("foundDate", ""), row.get("id", "")), reverse=True)
    pool.sort(key=lambda row: (
        row.get("matchTier", 5),
        -row["rankingScore"],
    ))
    result["total"] = len(pool)
    # 전체 후보를 한 번에 돌려주면 화면에서 페이지만 잘라 바로 바꿀 수 있다.
    result["allItems"] = pool
    start = max(0, (page - 1) * rows)
    result["items"] = pool[start:start + rows]
    return result


def _apply_visual_hints(
    result: dict,
    payload: LostFoundBrowseRequest,
    progress: Callable[[int, int], None] | None = None,
    preview: Callable[[list[dict]], None] | None = None,
    previous: dict | None = None,
) -> dict:
    """직접 찾기도 공개 API 사진을 AI로 보고 시각 특징이 맞으면 등급을 올린다.

    놓치는 것보다 조금 더 보는 편이 낫다. 페이지에 잘린 항목까지 스캔한 전체 후보를
    여러 번에 나눠 분석하고, 사진 점수가 조금이라도 있으면 앞으로 끌어올린다.
    사전 점수 복원과 최종 정렬은 어떤 조기 반환 경로에서도 빠지지 않는다.
    """
    result.setdefault("visualScanned", 0)
    result.setdefault("visualMore", False)
    search_mode = getattr(payload, "searchMode", None)
    hints = {} if search_mode == "basic" else payload.hints or {}
    # 사람 이름은 공개 원문의 텍스트 단서다. 사진에서 그 글자를 읽은 근거가 없으므로
    # 시각 특징·웹 참고·사진 비교 프롬프트에서 모두 제외한다.
    features = name_terms.without_person_names([
        term for term in (hints.get("imageFeatures") or []) if isinstance(term, str) and term.strip()
    ])
    visual_query = name_terms.strip_person_names(payload.keyword)
    prior = {} if search_mode == "basic" else _normalize_prior_scores(payload)
    if previous is not None:
        prior = {**prior, **previous.get("visualScores", {})}
    if not visual_query:
        # 이름만 검색한 경우 예전 작업에 남은 사진 점수도 되살리지 않는다.
        prior = {}
    pool = result.get("allItems") or result.get("items") or []
    # AI 조건이 비었거나 후보가 없어도 이전에 찾은 점수는 되살리고 정렬은 한다.
    _restore_visual_scores(result, prior)

    def ranked() -> dict:
        # 현재 페이지에 없어도 '더 찾아보기'가 점수를 이어받을 수 있도록 전체 맵을 돌려준다.
        result["visualScores"] = {
            item["id"]: item["visualScore"]
            for item in pool
            if isinstance(item.get("visualScore"), int) and item["visualScore"] > 0
        }
        return _rank_browse_result(result, hints, payload.keyword, payload.page, payload.rows)

    if not pool or not visual_query or (not features and search_mode != "ai") or search_mode == "basic":
        result["visualMore"] = False
        return ranked()

    from . import web_reference
    from .ai_pipeline import match_visual_features
    from .ai_schemas import AiVisualMatchCandidate, AiVisualMatchRequest

    # 낯선 캐릭터·브랜드는 웹에서 찾은 설명과 참고 사진을 먼저 붙인다.
    features, web_references = web_reference.enrich(features)
    skip = max(0, getattr(payload, "skipVisual", 0))
    scan_key = {"skip": skip, "query": visual_query, "features": features[:8]}
    if result.get("visualScanKey") == scan_key:
        return ranked()
    # 필터는 이미 서버에서 다 적용됐다. 이제는 최신 습득일부터 본다.
    # 잃어버린 지 얼마 안 된 물건을 찾을 확률이 훨씬 높기 때문이다.
    ordered = sorted(pool, key=lambda row: row.get("matchTier", 5))
    ordered.sort(key=lambda row: row.get("foundDate", ""), reverse=True)
    priority = {item_id: index for index, item_id in enumerate(result.get("photoPriority") or [])}
    if priority:
        ordered.sort(key=lambda row: priority.get(row["id"], len(priority)))
    period_mode = bool(result.get("coverage"))
    with_photos = police_api.order_period_photos(pool, result.get("photoPriority", []), hints, visual_query) if period_mode else [
        item for item in ordered if item.get("imageUrl")
    ]
    # 추가 페이지가 들어오면 최신순 위치가 바뀐다. 이미 비교한 기록은 ID로 건너뛴다.
    legacy_offset = 0 if period_mode else skip
    seen = set(previous.get("_visualSeenIds", ())) if previous is not None else {
        item["id"] for item in with_photos[:legacy_offset]
    }
    unseen = [item for item in with_photos if item["id"] not in seen]
    attempted = set((previous or {}).get("_visualAttemptedIds", ()))
    if period_mode and attempted:
        # 조회 실패 사진은 이후에 다시 시도해도 새로 수집한 사진까지 밀어내지 않는다.
        unseen.sort(key=lambda item: item["id"] in attempted)
    photo_items = unseen[:VISUAL_SCAN_CAP]
    can_expand = bool(result["hasMore"]) if result.get("coverage") else bool(
        result.get("scanLimitReached") and result.get("_browsePageCap", 24) < min(getattr(payload, "maxPages", 24), 24)
    )
    if not photo_items:
        result["visualAnalyzed"] = True
        result["visualMore"] = can_expand
        result["_visualSeenIds"] = sorted(seen)
        result["_visualAttemptedIds"] = sorted(attempted)
        result["visualScanKey"] = scan_key
        return ranked()

    if progress:
        progress(0, len(photo_items))

    # 현재 탐색에 배정된 사진은 모두 확인해야 뒤에 있는 더 닮은 후보도 찾을 수 있다.
    scores: dict[str, int] = {}
    photo_by_id = {item["id"]: item for item in photo_items}
    analyzed = 0
    for start in range(0, len(photo_items), VISUAL_BATCH_SIZE):
        batch = photo_items[start:start + VISUAL_BATCH_SIZE]
        batch_ids = {item["id"] for item in batch}
        attempted.update(batch_ids)
        candidates = []
        # 같은 사진 경로는 대표 한 장만 모델에 보여준다. 다른 공식 기록의 ID는
        # aliases에 남겨 뒤에서 같은 점수를 복사하므로 결과 카드는 그대로 노출된다.
        image_owners: dict[str, str] = {}
        aliases: dict[str, list[str]] = {}
        for item in batch:
            image_key = police_api._image_key(item.get("imageUrl"))
            owner = image_owners.get(image_key) if image_key else None
            if owner:
                aliases.setdefault(owner, []).append(item["id"])
                continue
            text = " ".join(str(item.get(field) or "") for field in ("name", "subject", "notes", "category", "color"))
            candidates.append(AiVisualMatchCandidate(
                id=item["id"], imageUrl=item["imageUrl"], text=text[:2000],
            ))
            if image_key:
                image_owners[image_key] = item["id"]
        try:
            matched = match_visual_features(AiVisualMatchRequest(
                query=visual_query,
                imageFeatures=features[:8],
                references=web_references,
                candidates=candidates,
                externalProcessingConfirmed=True,
                webReferenceApplied=True,
                photoOnly=True,
                preferSemantic=True,
            ))
        except Exception:
            # 한 묶음이 실패해도 나머지 묶음과 공개 원문 목록은 유지한다.
            # 실패한 배치는 '본 사진'으로 세지 않아 더 찾아보기에서 다시 볼 수 있다.
            continue
        returned = {row.id for row in matched.results if row.basis == "photo" and row.id in batch_ids}
        compared = returned | {alias for item_id in returned for alias in aliases.get(item_id, [])} if period_mode else batch_ids
        analyzed += len(compared)
        seen.update(compared)
        if progress:
            progress(analyzed, len(photo_items))
        for row in matched.results:
            if row.basis == "photo" and row.imageSimilarity >= VISUAL_MATCH_MIN:
                for item_id in [row.id, *aliases.get(row.id, [])]:
                    scores[item_id] = max(scores.get(item_id, 0), row.imageSimilarity)
        if preview and scores:
            best = sorted(scores, key=scores.__getitem__, reverse=True)[:4]
            preview([
                {**photo_by_id[item_id], "visualScore": scores[item_id], "matchLabel": "AI 사진 일치"}
                for item_id in best if scores[item_id] >= VISUAL_STRONG_MIN
            ])

    result["visualAnalyzed"] = analyzed >= len(unseen)
    result["visualScanned"] = analyzed
    result["visualMore"] = analyzed < len(unseen) or can_expand
    result["_visualSeenIds"] = sorted(seen)
    result["_visualAttemptedIds"] = sorted(attempted)
    result["visualScanKey"] = scan_key
    # 이번에 새로 찾은 점수와 이전 탐색에서 이어받은 점수를 합쳐 화면에 되살린다.
    combined = dict(prior)
    combined.update({item_id: max(prior.get(item_id, 0), score) for item_id, score in scores.items()})
    _restore_visual_scores(result, combined)
    return ranked()


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
        period_options = _browse_period_options(payload)
        result = police_api.browse_all(
            payload.keyword,
            payload.page,
            payload.rows,
            filters=payload.filters,
            hints=payload.hints,
            max_pages=_browse_page_cap(payload),
            search_mode=payload.searchMode,
            # 필터를 걸어도 사진 60장을 볼 만큼은 읽는다. 페이지 분량만 읽으면
            # 공식 코드 필터를 쓴 순간 사진 분석과 더 찾아보기가 조용히 꺼진다.
            visual_need=_browse_page_cap(payload) * payload.rows,
            **period_options,
        )
        result = _apply_visual_hints(result, payload)
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


# 직접 찾기 백그라운드 작업. 탭을 닫거나 다른 페이지로 가도 서버에서 계속 이어간다.
BROWSE_JOB_TTL_SECONDS = 30 * 60
_browse_jobs: dict[str, dict] = {}
_browse_jobs_lock = threading.Lock()
_browse_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="direct-browse")


def _prune_browse_jobs() -> None:
    now = time.time()
    for job_id in [key for key, value in _browse_jobs.items() if now - value["createdAt"] > BROWSE_JOB_TTL_SECONDS]:
        _browse_jobs.pop(job_id, None)


def _browse_period_options(payload: LostFoundBrowseRequest, previous: dict | None = None) -> dict:
    if not payload.periodSearch:
        return {}
    return {
        "period_mode": True,
        "period_cursor": (previous or {}).get("periodCursor") or (
            payload.periodCursor.model_dump() if payload.periodCursor else None
        ),
    }


def _run_browse_job(job_id: str, payload: LostFoundBrowseRequest, previous: dict | None = None) -> None:
    try:
        page_cache = dict((previous or {}).get("_browsePages", {})) if payload.searchMode == "ai" and payload.keyword and not payload.periodSearch else None
        cap = _next_browse_page_cap(payload, previous) if previous is not None else _browse_page_cap(payload)
        result = police_api.browse_all(
            payload.keyword,
            payload.page,
            payload.rows,
            filters=payload.filters,
            hints=payload.hints,
            max_pages=cap,
            visual_need=cap * payload.rows,
            search_mode=payload.searchMode,
            page_cache=page_cache,
            **_browse_period_options(payload, previous),
        )
        result["_browsePageCap"] = cap
        if page_cache is not None:
            result["_browsePages"] = page_cache
        if previous is not None:
            # 원본 API의 페이지가 변하거나 일부 조회가 실패해도 확인한 후보를 지우지 않는다.
            items = {item["id"]: item for item in previous["allItems"]}
            items.update((item["id"], item) for item in result["allItems"])
            by_record = {}
            for item in items.values():
                by_record.setdefault(police_api._browse_dedupe_key(item), item.copy())
            result["allItems"] = list(by_record.values())
            result["photoPriority"] = list(dict.fromkeys(previous.get("photoPriority", []) + result["photoPriority"]))
            if payload.periodSearch:
                result["scanned"] += previous["scanned"]
                result["sources"] = list(dict.fromkeys(previous["sources"] + result["sources"]))
            else:
                result["scanned"] = max(previous["scanned"], result["scanned"])

        def report_visual(scanned: int, total: int) -> None:
            with _browse_jobs_lock:
                if job_id in _browse_jobs:
                    _browse_jobs[job_id].update(visualScanned=scanned, visualTotal=total)

        def report_matches(items: list[dict]) -> None:
            with _browse_jobs_lock:
                if job_id in _browse_jobs:
                    _browse_jobs[job_id]["photoMatches"] = items

        result = _apply_visual_hints(result, payload, report_visual, report_matches, previous)
        if not result["sources"]:
            first = result["errors"][0] if result["errors"] else None
            raise police_api.PoliceError(
                first["code"] if first else "lostfound_upstream",
                first["message"] if first else "경찰청 유실물 정보를 가져오지 못했어요.",
            )
        if not result["errors"] and not payload.previousJobId:
            with closing(db.connect()) as connection:
                db.cache_set(connection, "lostfound", _lostfound_browse_key(payload), result)
        with _browse_jobs_lock:
            _browse_jobs[job_id].update(
                status="done", result=result,
                visualMore=bool(result.get("visualMore")), finishedAt=time.time(),
            )
    except police_api.PoliceError as error:
        with _browse_jobs_lock:
            _browse_jobs[job_id].update(status="error", error=error.message, finishedAt=time.time())
    except Exception:
        logger.exception("direct browse job failed: job_id=%s", job_id)
        with _browse_jobs_lock:
            _browse_jobs[job_id].update(
                status="error", error="검색 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.", finishedAt=time.time()
            )


@app.post("/api/lostfound/browse/jobs", response_model=BrowseJobStart)
def start_lostfound_browse_job(payload: LostFoundBrowseRequest) -> dict:
    """오래 걸리는 직접 찾기를 서버 작업으로 넘긴다. 즉시 jobId를 돌려준다."""
    if not police_api.configured():
        raise api_error(
            503,
            "lostfound_not_configured",
            "경찰청 유실물 조회 설정이 필요해요. 서버 .env를 확인해 주세요.",
        )
    job_id = uuid.uuid4().hex
    cache_key = _lostfound_browse_key(payload)
    scope = _lostfound_browse_key(payload.model_copy(update={"skipVisual": 0, "priorVisualScores": {}, "periodCursor": None}))
    cached = None
    if not payload.previousJobId:
        with closing(db.connect()) as connection:
            cached = db.cache_get(connection, "lostfound", cache_key, config.LOSTFOUND_SEARCH_TTL)
        if cached is not None and payload.searchMode == "ai" and payload.keyword and not (
            "_browsePages" in cached or "periodCursor" in cached
        ):
            cached = None
    previous = None
    with _browse_jobs_lock:
        _prune_browse_jobs()
        source_job = _browse_jobs.get(payload.previousJobId) if payload.searchMode == "ai" or payload.periodSearch else None
        if source_job and source_job["status"] == "done" and source_job.get("scope") == scope:
            prior_result = source_job["result"]
            if "_browsePages" in prior_result or "periodCursor" in prior_result:
                previous = prior_result
        _browse_jobs[job_id] = {
            "jobId": job_id,
            "status": "done" if cached is not None else "pending",
            "result": cached,
            "scope": scope,
            "error": None,
            "visualScanned": int((cached or {}).get("visualScanned", 0)),
            "visualTotal": 0,
            "visualMore": bool((cached or {}).get("visualMore")),
            "createdAt": time.time(),
            "finishedAt": time.time() if cached is not None else None,
        }
    if cached is None:
        _browse_executor.submit(_run_browse_job, job_id, payload, previous)
    return {"jobId": job_id, "status": "done" if cached is not None else "pending"}


@app.get("/api/lostfound/browse/jobs/{job_id}", response_model=BrowseJobStatus)
def get_lostfound_browse_job(job_id: str) -> dict:
    with _browse_jobs_lock:
        job = _browse_jobs.get(job_id)
    if job is None:
        raise api_error(404, "browse_job_not_found", "검색 작업을 찾지 못했어요. 다시 검색해 주세요.")
    return {
        "jobId": job_id,
        "status": job["status"],
        "result": job["result"],
        "error": job["error"],
        "visualScanned": job.get("visualScanned", 0),
        "visualTotal": job.get("visualTotal", 0),
        "visualMore": job.get("visualMore", False),
        "photoMatches": job.get("photoMatches", []),
    }


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
        if payload.periodSearch:
            result = police_api.search_in_period(
                payload.keyword, payload.page, payload.rows, payload.hints,
                payload.periodCursor.model_dump() if payload.periodCursor else None,
                original_query=payload.originalQuery, photo_category=payload.photoCategory,
                filters={"from": payload.fromDate, "to": payload.toDate},
            )
        else:
            options = {}
            if payload.photoSearch or payload.originalQuery:
                options = {
                    "original_query": payload.originalQuery, "photo_search": payload.photoSearch,
                    "photo_category": payload.photoCategory,
                }
            result = police_api.search_all(payload.keyword, payload.page, payload.rows, hints=payload.hints, **options)
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

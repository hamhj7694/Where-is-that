# 멀티모달 검색 파이프라인 감사 및 리팩토링 계획

작성 기준: 2026-11-23 / 코드 기준 `main.py`의 `BROWSE_ALGO_VERSION = 16`

이 문서는 **진단과 수정 계획**이다. 이 감사로 운영 코드(`backend/app/**`, `frontend/src/**`)는 변경하지 않았다. 근거는 현재 저장소의 파일·줄 번호와 `backend/audit/pipeline_audit.py`로 만든 실측 리포트다.

---

## 1. 감사 범위와 호출 흐름

대상은 직접 찾기(공개 습득물 검색)를 중심으로 한 전체 경로다.

```text
[화면] DirectSearchPage.submitSearch(basic|ai)
  ├─ basic: AI 해석 없이 keyword/region만 사용
  └─ ai: POST /api/ai/search/prepare → AiSearchPlan → hints/filters

[작업] POST /api/lostfound/browse/jobs
  → main._run_browse_job
     → police_api.browse_all             (공개 API 스캔 + 하드 필터 + 1차 등급)
     → main._apply_visual_hints
        → name_terms / requested_colors / prior 점수 복원
        → web_reference.enrich            (웹 참고 이미지)
        → ai_pipeline.match_visual_features
           → VISUAL_GRAPH
              → _visual_fetch             (사진 다운로드)
              → _visual_census            (YOLOE + VLM 크롭 판정)
              → _visual_select            (CLIP 비교 후보 최대 8장)
              → _visual_embed             (CLIP 임베딩/유사도)
              → _visual_fallback          (낮은 점수 재채점)
              → _visual_describe          (텍스트 단서 점수)
        → main._restore_visual_scores / _rank_browse_result
     → GET /api/lostfound/browse/jobs/{job_id} 폴링
```

주요 근거: `frontend/src/features/workspace/DirectSearchPage.tsx:234-283,318-410`, `backend/app/ai_api.py:26-60`, `backend/app/main.py:966-1096,1152-1239`, `backend/app/ai_graph.py:119-346`.

---

## 2. 5가지 기준별 진단

### 기준 1. 사전 계산 누락 — **확인됨(높음)**

| 누락 | 현재 동작 | 근거 |
|---|---|---|
| 사진 썸네일 영속화 | 검색마다 공개 사진을 다시 GET 하여 512px JPEG로 인코딩. `browse:` 캐시 키가 바뀌면 전체 재다운로드 | `ai_pipeline.py:293-323`, `main.py:889-906,1152-1162` |
| 사진별 YOLO/CLIP 산출물 저장 | `crop_target`/`embed_image`/`embed_text`는 프로세스 메모리 `lru_cache`에만 존재. DB에는 임베딩/라벨/설명 컬럼이 없음 | `local_vision.py:288,334,347`, `db.py:58-72` |
| VLM census 결과 저장 | 배치마다 같은 사진의 객체 수·종류를 다시 판정. 실패도 캐시하지 않음 | `ai_graph.py:171-229`, `config.py:141` |
| 원격 임베딩 캐시 | `openai-compatible`/`clip-http` 경로는 캐시가 전혀 없음 | `image_similarity.py:91-154` |
| 항목별 점수 저장 | `priorVisualScores`를 **클라이언트가 들고 왕복**함. 서버는 숫자만 복원하고 재계산은 피하지만, 새 세션에서는 점수가 사라지고 공개 API 스캔은 다시 수행 | `main.py:74-81,102-119,889-906` |

실측 예: `S14(하얀 신한카드)` 1회에서 전처리/다운로드 **139초**, CLIP **6.6초**, VLM **38초**가 발생했다(캐시를 비운 비교 실행). 대부분이 "처음 보는 사진"이어도 매번 다시 계산되는 비용이다.

### 기준 2. 조기 종료/스킵 부재 — **일부 존재, 하지만 너무 늦거나 과소**

- **존재하는 조기 종료**: 최고점 ≥ 90 또는 70점 이상 3건이면 배치 루프 중단 (`main.py:1083-1086`). 같은 응답 재처리는 `visualScanKey`로 차단 (`main.py:1023-1026`).
- **문제점**
  - `basic` 모드에서는 AI/사진 단계가 아예 없어야 하는데, 공개 API 스캔 자체는 매번 수행된다. 기본 모드 회귀 케이스 `S20`은 전처리/CLIP/VLM이 모두 0ms였고 필터 조회만 약 2.6~5.3초였다.
  - `imageFeatures`가 없으면 사진 분석을 건너뛰지만(`main.py:1005-1007`), 텍스트 전용 점수가 평평하면 `TEXT_FALLBACK_MAX_SCORE=70`, `TEXT_FALLBACK_MIN_GAP=5` 때문에 멀티모달 폴백이 거의 매 배치 추가 호출된다 (`ai_graph.py:260-300`, `config.py:144-145`).
  - 0건 재스캔: 1차 탐색어로 0건이면 빈 검색어로 **전체 페이지 범위를 다시 훑는다** (`police_api.py:605-612`). 희귀 질의에서 공개 API 호출이 최대 2배.
  - `crop_target`이 `score_*`에서 한 번, `crop_notes`에서 다시 호출된다 (`local_vision.py:381-405,442-459`, `ai_graph.py:241-257`). `lru_cache` 덕분에 두 번째는 히트하지만 캐시 eviction/재시작 시 YOLOE를 다시 태운다.

### 기준 3. 모델 역할 중복(YOLO 크롭) — **확인됨(높음)**

- `object_census`(YOLOE) + `VLM_CROP_CENSUS`가 **같은 판정을 두 모델로 수행**한다. census 분기는 VLM 호출을 추가하고, 결과 `vlm_multi`가 다시 `crop_target`의 크롭 조건으로 들어간다 (`ai_graph.py:155-168,171-229`, `local_vision.py:289-331`).
- `needs_crop()`과 `crop_target()`의 크롭 조건이 동일 로직으로 중복 구현되어 있다 (`local_vision.py:282-285,300-303`). 전자는 프로덕션에서 호출되지 않고 테스트에서만 쓰인다.
- `crop_notes()`는 방금 점수 계산에서 crop/embed 한 동일 후보에 대해 `crop_target`를 다시 호출한다 (`local_vision.py:442-459`). crop 결과를 점수 계산이 함께 반환하면 제거 가능하다.
- 1회 검색의 모델 호출 상한: 사진 60장 / 배치 8장 → VLM census 최대 8회 + fallback 최대 8회 = **약 16회**, YOLOE는 사진당 최대 2회, CLIP 임베딩은 사진당 1~2회 + 텍스트 프롬프트 최대 8개 × 배치 수.

### 기준 4. 과도한 Top-K 전달 — **확인됨(중간~높음)**

| 구간 | 현재 값 | 평가 |
|---|---|---|
| 사진 스캔 cap | `VISUAL_SCAN_CAP=60` (`main.py:55`) | 검색 1회에 최대 60회 다운로드. 8장 배치 × 8회 |
| 비교 후보 cap | `VISUAL_MATCH_MAX_COMPARE=8` (`config.py:146`, `local_vision.py:186-209`) | 배치당 8장은 적절하나, 스캔 cap과 곱해지면 총량이 큼 |
| VLM 전달 이미지 | 배치당 참고 + 최대 8장 + census/fallback | 배치 수만큼 반복 전달 |
| 웹 참고 features | 최대 4개 조회, 이미지 최대 2장 (`web_reference.py:261-287`) | feature당 위키 4회 + DDG 1회 + 네이버 1회 + 썸네일 → 최악 약 36회 외부 요청 |
| 공개 API 페이지 | 기본 8, 더 찾아보기 최대 24 (`main.py:68-71`, `config.py:77`) | 사진 풀을 위해 `visual_need = page_cap × rows`만큼 계속 읽음 (`main.py:1154-1162`) |

`basic` 모드와 `imageFeatures`가 없는 질의에서 60장 전체를 AI에 넘기는 구조가 가장 큰 낭비다. 반면 배치 내부의 중복 사진은 `_image_key`로 1장만 대표 전송하도록 이미 잘 처리되어 있다 (`main.py:1046-1059`, `ai_graph.py:129-134`) — 이 설계는 유지해야 한다. 단, **배치 간** 중복은 `image_owners`가 배치마다 새로 만들어져 여전히 재전송된다.

### 기준 5. 죽은 코드/중복 로직 — **확인됨(높음)**

확실히 죽은 코드:

- `police_api.py:381-386` `_keyword_item_match` — 저장소 전체 참조 0건.
- `db.py:137-141` `cache_prune` — 참조 0건. 만료 행은 `cache_get`이 접근 시 삭제(`db.py:105-108`).
- `config.py:94-97` `AI_VISION_*` 4개 — 호환 별칭 주석과 달리 `_role_config`가 읽지 않음 (`ai_pipeline.py:43-54`).
- `config.py:126` `LOCAL_CLIP_BATCH_SIZE`, `:129` `YOLOE_CONFIDENCE` — 실제로는 하드코딩된 8과 `CROP_CENSUS_CONFIDENCE`가 사용됨.
- `ai_pipeline.py:6` 미사용 `datetime` import, `:15` 미사용 `AiRankCandidate`/`AiVisualMatchResult` import.
- `local_vision.py:282-285` `needs_crop` — 프로덕션 참조 0건, 테스트 2건만.

중복 로직:

- data URL 정규식 3중: `ai_pipeline.py:40`, `image_similarity.py:19`, `local_vision.py:24`.
- 코사인 유사도 2중: `image_similarity.py:157-165`, `local_vision.py:358-366`.
- `text_signal_score` 2회 계산: `police_api.py:677`, `main.py:949-952`.
- 조건/키워드 정리 4곳: `ai_pipeline.py:193-223`, `police_api.py:227-246`, `ai_schemas.py:129-139`, `web_reference.py:85-95`. (대소문자 처리 차이가 있어 통합 시 인자로 남겨야 함)
- 지역 코드 순회 2곳: `ai_graph.py:91-96`, `lostfound_codes.py:156-164`.
- 색상 어휘 3중 관리: `lostfound_codes.py:69-109`(공식 코드), `local_vision.py:66-89`(CLIP 프롬프트), `web_reference.py:39-43`(웹 제외어). 도메인이 달라 **표만 합치기보다 `extract_colors()` 유틸로 공유**하는 편이 안전하다.

`/pipeline` 화면용 상수·라우트(`main.py:122-436,630-722`)는 검색 결과에 영향이 없으나, 표시 문서가 실제 라우팅과 어긋나 있다(`main.py:146,166`). 표시용이라도 정리 대상이다.

---

## 3. 수정 계획 (먼저 제안, 아직 미적용)

### [즉시 삭제할 코드]

안전하게 제거 가능한 것만 묶었다. 모두 동작 변화 없음.

1. `police_api._keyword_item_match` (`police_api.py:381-386`)
2. `db.cache_prune` (`db.py:137-141`) — 단, `/pipeline` 문서의 "미호출" 안내 문구도 함께 갱신
3. `config.AI_VISION_PROVIDER/API_KEY/BASE_URL/MODEL` (`config.py:94-97`) + `.env.example` 2줄
4. `config.LOCAL_CLIP_BATCH_SIZE`, `config.YOLOE_CONFIDENCE` (`config.py:126,129`)
5. `ai_pipeline` 미사용 import 3건 (`ai_pipeline.py:6,15`)
6. `local_vision.needs_crop` (`local_vision.py:282-285`) — **대신 `crop_target`이 `object_census` 결과를 재사용하도록 통합한 뒤** 삭제
7. data URL 정규식 / 코사인 유사도 / 지역 코드 조회를 공통 유틸로 추출한 뒤 원본 복제 제거
8. `main._rank_browse_result`와 `police_api.collect`의 `text_signal*10 + visualScore` 정렬 키를 한 함수로 추출

### [생략/분기 처리할 AI 단계]

효과가 큰 순서다.

1. **basic 모드 완전 분리**: `skipVisual=1`을 명시하고 `hints={}` 유지. 공개 API 텍스트 스캔만 수행(이미 동작 중이나 스캔 cap 적용으로 함께 축소).
2. **사진 분석 사전 게이트**: `imageFeatures`와 명시 색상이 모두 없으면 `match_visual_features` 호출 자체를 생략하고 텍스트 점수로 정렬. `web_reference.enrich`도 함께 생략.
3. **YOLO/VLM census 분기**: `crop_target`이 `vlm_multi` 없이도 충분한 경우(단일 객체·단일 색상) VLM census를 생략. 실측에서 census가 배치당 1회, 최대 8회까지 증가함.
4. **배치 간 사진 dedup 이동**: `image_owners`/`aliases`를 배치 루프 밖으로 옮겨 같은 `imageUrl`의 재다운로드·재전송 제거. 점수 alias 복사는 유지.
5. **사진 단위 영속 캐시 신설**: `sha256(image)` → `{thumb, crop_url, yolo_labels, vlm_multi, clip_vector}`. 신규 사진만 모델 호출. `priorVisualScores`도 `(item_id, algo_version)`로 서버 저장해 캐시 키에서 분리.
6. **멀티모달 폴백 재검토**: `TEXT_FALLBACK_MAX_SCORE=70` / `MIN_GAP=5`가 너무 관대하면 점수가 평평한 배치마다 VLM을 재호출한다. 로컬 점수 신뢰 구간을 먼저 계산하고, 신뢰가 낮은 **상위 2~3장만** 폴백에 보내도록 후보 수를 제한.
7. **웹 참고 호출 축소**: feature 4개 → 1~2개, `_naver_image_urls`는 위키/DDG 실패 시에만 호출. 실패도 짧은 네거티브 캐시 저장.
8. **0건 재스캔 완화**: 1차 0건이면 빈 검색어 전체 스캔 대신 페이지 상한을 1~2페이지로 제한. 이름/가려진 물건 탐지 의도와 트레이드오프가 있어 규칙 기반으로 검증한 뒤 적용.

### [가중치 조정이 필요한 구간]

| 구간 | 현재 | 제안 | 이유 |
|---|---|---|---|
| 최종 정렬 | `text_signal*10 + visualScore` (`main.py:944-963`) | 텍스트 10을 유지하되, 사진 점수에 `basis` 신뢰도를 곱한 `visual_confidence` 도입 | 공식 메타데이터가 명확한데 사진 점수만으로 등급이 뒤집히는 경우 방지 |
| 사진 점수 유지 | `VISUAL_MATCH_MIN=40` (`main.py:57`) | 유지하되 색상 불일치 시 0으로 강제(이미 v16에서 적용) | 회귀 방지 |
| 사진 등급 상승 | `VISUAL_STRONG_MIN=50` (`main.py:59`) | 50 유지, 단 `matchTier=1`을 "AI 사진 일치"로 올리는 조건에 공식 색상 일치 추가 | `하얀 신한카드` 회귀 재발 방지 |
| 조기 종료 | 90점 1건 / 70점 3건 (`main.py:61-63`) | 상한 사진 수를 60→32로 줄인 뒤 90/3건 유지 | 정확도는 유지하면서 다운로드 절반 |
| 텍스트 폴백 | `<70` 또는 gap `<5` (`config.py:144-145`) | `<60` 또는 gap `<8`, 폴백 후보 3장 제한 | VLM 호출 수 감소 |
| 비교 Top-K | 8 (`config.py:146`) | 8 유지(정확도 민감), 대신 총 스캔 cap만 축소 | 배치 내부 품질은 이미 검증됨 |
| 웹 참고 | features 4 / images 2 (`web_reference.py:271`) | features 2 / images 2 | 외부 요청 약 36회 →약 18회 |

가중치를 바꾸면 `BROWSE_ALGO_VERSION`을 17로 올려야 한다(`main.py:65`). 캐시가 옛 규칙을 계속 반환하지 않게 하기 위함이다.

---

## 4. 자동 감사 스크립트

`backend/audit/pipeline_audit.py`는 운영 코드를 수정하지 않고 `TestClient`로 실제 FastAPI 라우트를 호출한다. 내부 함수에 타이머를 감싸 **전처리/YOLO → CLIP 임베딩 → DB 벡터·필터 조회 → VLM 리랭킹** 단계별 ms와 최종 반환 후보 수를 표로 출력한다. YOLO ON/OFF는 `yoloe_available()`와 `config.YOLOE_ENABLED`를 컨텍스트 매니저로 전환해 비교한다.

```powershell
# 20개 가상 사용자 시나리오 생성
& '.\backend\.venv\Scripts\python.exe' '.\backend\audit\pipeline_audit.py' generate

# 전체 실행 + VLM 심판 + Markdown/CSV 리포트
& '.\backend\.venv\Scripts\python.exe' '.\backend\audit\pipeline_audit.py' run

# YOLO ON/OFF 비교
& '.\backend\.venv\Scripts\python.exe' '.\backend\audit\pipeline_audit.py' compare

# 빠른 스모크(심판 생략, 특정 시나리오만)
& '.\backend\.venv\Scripts\python.exe' '.\backend\audit\pipeline_audit.py' run --ids S20 --no-judge
```

시나리오는 단순 키워드, 오타, 복합 필터, 시각 묘사 자연어, 브랜드/색상 회귀, 결과 없음 함정 등 20개다(`backend/audit/scenarios.json`). 심판은 상위 3개 후보의 메타데이터와 사진을 받아 0~100점과 실패 단계(YOLO/CLIP/필터/VLM)를 JSON으로 반환하고, `backend/audit/reports/`에 CSV/Markdown으로 저장한다. 검색 오류나 결과 0건은 심판 점수로 덮이지 않도록 규칙 검사와 분리해 기록한다.

### 실행 중 확인된 운영 이슈

- `S14` 비교 실행 중 경찰청 API가 `경찰청 유실물 서버 응답이 늦어요`로 타임아웃되어 0건이 반환된 적이 있다. 스크립트는 이를 `ERROR`로 기록하고 심판 점수는 0으로 정규화한다. 일시적 외부 장애이므로 재실행 전에는 비교 수치를 해석하지 말 것.
- 정상 응답 시 `S20(카드)`은 규칙 검사 100%, 심판 98점, 전처리/CLIP/VLM 0ms, 필터 조회 약 5.3초였다. 기본 모드가 사진 AI를 호출하지 않는다는 점을 확인했다.

---

## 5. 적용 순서 권장

1. 즉시 삭제 1~5번 (안전, 동작 변화 없음)
2. 배치 간 사진 dedup 이동 + basic/무특징 사전 게이트 (효과 큼, 위험 낮음)
3. 사진 단위 영속 캐시 테이블 신설 (효과 가장 큼, 스키마 변경 필요)
4. VLM census/fallback 분기 재설계 + 웹 참고 호출 축소
5. 가중치 조정 + `BROWSE_ALGO_VERSION=17` + 20개 시나리오 재심판

각 단계 후 `backend/audit/pipeline_audit.py compare`로 ON/OFF 점수·시간을 다시 측정해 회귀 여부를 확인한다.

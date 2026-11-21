# 그거어디? — AI 모듈 · 3채널 검색 · LangGraph 구현 계약 (초안)

> 로컬 통합본: 2026-11-17 · 첨부 개정판과 최신 사용자 UI 지시를 병합. 변경·구현 상태는 `README_최신설계_및_작업순서.md` 참조.

> v0.1 · 2026-11-16 · **개발 착수용 인터페이스 제안(PROPOSED), AI 모듈·신규 3채널 서버 코드 미구현/성능 미검증**. 제품 정책은 `00`, UI 계약은 `05`, 테스트 항목은 `02`, 데이터 API는 `03`, 큰 흐름도는 `04`가 우선한다. 본 문서는 **나중에 개별 모듈을 연결하기 위한 공통 입출력 계약**이다.

## 1. 꼭 구분해야 하는 것

- **모델 가져오기:** 학습된 가중치·라이브러리를 내려받아 추론(객체 탐지, OCR, 임베딩 등). 학습용 데이터셋 없이 시작할 수 있다.
- **모델 API 호출:** 서버에서 LLM/VLM 서비스에 텍스트·이미지를 전달하고 응답 수신. 개인정보·비용·지연·로그·보존 정책 확인 필요.
- **모델 직접 학습/미세조정:** 현재 **의무 아님**. 사전학습 모델이 실제 물품·한국어·작은 물체에서 실패하고 개선의 필요가 입증된 뒤 검토.
- **인덱싱:** 이미지를 임베딩하고 OCR/텍스트를 검색 DB에 기록하는 작업. **모델 학습과 다르다.**
- **평가 정답셋:** 사전학습 모델로만 구현해도 **필수**. 동일 실물/촬영 배경에 의한 누수 방지, 데이터 이용권 확인, 유사하지만 다른 물품(hard negative) 포함.

## 2. 독립 모듈과 추천 PoC

| 모듈 ID | 모듈 | 입력 → 출력 | 우선 후보 · 검증 상태 | F1/F2 차이 |
|---|---|---|---|---|
| M1 | 객체 탐지 | 이미지/선택 클래스 → bbox·label·confidence | 사전학습 YOLOE, Grounding DINO, 수동 대안; 훈련 불필요(성능 미확정) | F1 웹 로컬 배포 실현 가능성 별도 / F2 서버 후보 |
| M2 | 크롭 | 이미지+bbox/사용자 영역 → 크롭 이미지·좌표 | 직접 JS/Python 처리; 학습 불필요 | F1/F2 공통 UI 기준, 자동 탐지 없이도 수동 선택 |
| M3 | 이미지·텍스트 임베딩 | 이미지/문장 → vector, model_id, preprocessing_id | SigLIP2·다국어 CLIP/브라우저 대안 | F1 Web Worker/ONNX·IndexedDB / F2 Python 서버 |
| M4 | VLM | 이미지 → 물품 종류·색상·형태·시각 단서·불확실성 | API/서버 모델 후보; **F2 필수 기능**, 제공자 미정 | F1 개인 폴더 전체를 외부 API로 보내지 않음 |
| M5 | OCR | 이미지 → 문자·영역·신뢰도·언어 | F1 웹 Tesseract.js 등 후보, F2 PaddleOCR 등 | **F1 로컬 OCR 검색 필수 목표**, F2는 공공 실사진 추가 단서 후보 |
| M6 | LLM | 자연어→구조화된 검색 조건 | API/서버 모델 + LangChain Structured Output 후보 | F2 질의 분석. 범용 자유대화 강제 아님 |
| M7 | 검색·랭킹 | 이미지 순위+맥락 순위+필터→3개 독립 채널 | BM25/텍스트 임베딩·코사인 + **OR/RRF 초기 기준선** | F1 자체 로컬 검색과 분리; F2 순위 계산은 결정적 코드 |
| M8 | 공공 데이터 수집/갱신 | API-01/02 → 공식 원문·유효 실사진·파생 색인 | 제공 키·약관·이미지 유효율 실증 전 | F2 서버 스케줄러, LLM/Agent로 운영 제어 안 함 |
| M9 | 워크플로 조정 | validated request → 실행 경로·부분 결과·오류·관측 | **F2 FastAPI+LangChain+LangGraph**, MCP MVP 제외 | F1 개인 데이터 서버 전송 없이 로컬 경로 |

**개발 원칙:** 한 모듈을 다른 모듈 코드에 직접 결합하지 않는다. `Typed input → output / error code → deterministic tests`로 먼저 만들고, 모델은 버전·전처리·평가 기록을 남긴다. 마이크로서비스가 아니라 같은 Python 프로젝트의 내부 모듈로 시작해도 된다.

## 3. 검색 입력 → 두 검색 원천 → 세 결과 채널

| 입력 | 이미지 원천 | 맥락 원천 | 종합 채널 |
|---|---|---|---|
| 자연어만 | 텍스트↔공공 실사진의 임베딩+VLM 사전 시각 설명 | 자연어/LLM 구조화 조건↔전체 공개 기록 | 후보 **OR 합집합** 재랭킹 |
| 사진만 | 사용자 사진/크롭↔유효 공공 실사진 | 사용자 사진 VLM 설명·조건↔전체 공개 기록 | 후보 **OR 합집합** 재랭킹 |
| 자연어+사진 | 이미지 유사도+텍스트↔공공 실사진 근거 | 자연어 명시 단서+VLM 시각 추정 근거 | 두 단서를 함께 사용하는 **OR 합집합** 재랭킹 |

세 채널은 `combined`, `image`, `context`이다. **각 독립 순위의 1~3위 미리보기 + 독립 더보기(4위 이후)**로 구성하며, **같은 물품이 여러 채널에 나와도 정상**이다. 동일 채널의 같은 `canonical_item_key` 중복은 제거한다. 예: 물품 X가 종합 7위, 맥락 4위이면 **맥락 더보기에서 4위로 바로 탐색**되어야 한다.

**중요한 예외:** `combined`는 이미지와 맥락 모두에서 강하게 일치하는 항목만 넣는 **AND 교집합이 아니다**. 사진 없는 공개 물품도 맥락 검색을 통해 `combined`에 포함될 수 있다. 반대로 `image` 채널은 실제 유효한 공공 실사진이 있는 레코드만 포함한다.

## 4. LangGraph 상태 및 내부 함수 계약 (설계 예시)

```python
# 실제 작동 코드가 아닌 계약 설명용 예시
from typing import Literal, TypedDict

Channel = Literal["combined", "image", "context"]
InputType = Literal["text", "image", "mixed"]

class RetrievalState(TypedDict, total=False):
    request_id: str
    input_type: InputType
    user_text: str | None
    temporary_query_image_ref: str | None
    authorized_external_processing: bool
    explicit_filters: dict
    llm_filters: dict
    vlm_features: dict
    image_candidates: list[dict]
    context_candidates: list[dict]
    combined_candidates: list[dict]
    channel_status: dict[Channel, str]
    channel_errors: dict[Channel, str | None]
    model_versions: dict[str, str]
    index_snapshot_id: str
```

추천 노드: `validate_request → normalize_input → (parse_text_llm? / analyze_image_vlm?) → (search_image || search_context) → fuse_combined_deterministically → build_three_channels → respond`. `?`는 필요한 입력에서만, `||`는 병렬 실행 가능하다. 한 경로가 실패하면 성공 경로 결과는 유지하고 종합을 `partial`로 표시할 수 있다. 입력 사진이 VLM에 전달되지 않았거나 동의가 없으면 임의 성공 처리 금지.


**종합 오류 경계:** 한 원천 오류+다른 원천 정상 0건은 정상 전체 0건이 아니다. 미완료/오류를 알리고 해당 원천 재시도를 제공한다. 양쪽 원천이 오류이면 종합도 오류다. 정상 후보가 존재하는 한쪽만 성공한 경우에만 사용 가능한 근거의 `partial` 결과로 표시한다.

### 랭킹 초기 기준선: RRF

각 원천은 canonical ID를 순서 보존 중복 제거한 뒤 순위를 매긴다. 같은 ID가 한 원천에서 반복돼도 점수를 중복 가산하지 않는다.

임베딩 점수 `0.87`과 BM25 점수 `12.4`는 서로 다른 척도여서 단순 평균하지 않는다. 합집합 후보의 **순위**를 이용한 RRF를 시작 기준선으로 사용한다.

```python
# 랭킹 계산 예시 (검증 전)
from collections import defaultdict

def fuse_rrf(image_ranked_ids, context_ranked_ids, k=60):
    score = defaultdict(float)
    for ranked in (image_ranked_ids, context_ranked_ids):
        for rank, item_id in enumerate(dict.fromkeys(ranked), start=1):
            score[item_id] += 1.0 / (k + rank)
    return sorted(score, key=lambda item_id: (-score[item_id], item_id))
```

종합은 별도 `combined_ranking`, 이미지는 `image_ranking`, 맥락은 `context_ranking`으로 유지. 이 RRF는 **MVP 비교용 기본선이지 최적 알고리즘이 입증됐다는 의미가 아니다.** 융합 깊이(원천 각 Top-K), 단일 경로만 존재하는 정답의 포함률, 사진 없음 처리, 같은 실물의 비슷한 사진 누수는 `EXP-25`에서 측정한다.

## 5. API 응답 제안 (개발 스키마 확정 전)

```json
{
  "request_id": "example-only",
  "input_type": "mixed",
  "query_snapshot": "index-vX-demo",
  "preview_limit_per_channel": 3,
  "sections": {
    "combined": {"status": "success", "items": [], "next_cursor": null, "has_more": false},
    "image": {"status": "success", "items": [], "next_cursor": null, "has_more": false},
    "context": {"status": "success", "items": [], "next_cursor": null, "has_more": false}
  }
}
```

`items=[]`는 스키마 설명용 값이며 실제 후보가 없다는 조사결과가 아니다. 각 `items`의 레코드에는 `canonical_item_key`, `source`, `official_url`, `photo_status`, 확인된 실제 필드, 파생정보의 출처와 추정 상태를 둔다. **cursor는 채널별 독립**이다. `GET/POST more(channel,cursor,query_snapshot)`에서는 다른 채널에 노출한 기록 ID를 **제외 필터로 사용하지 않는다**. 필요하다면 같은 스냅샷과 채널에서 정렬을 재현할 수 있게 한다.

## 6. 실제로 확인·결정할 것

- **G0 / EXP-06:** 경찰청 2종 인증키 실호출, 데이터 이미지 유효률·텍스트 채움률·수집/캐시/색인 권리·갱신 가능성.
- **EXP-01/02/03/04/26/27:** 독립 OCR·임베딩·YOLOE/수동 크롭·VLM·LLM 모듈의 한글/시각/속도·브라우저 실현 가능성.
- **EXP-24:** 세 입력×두 원천 검색·세 결과 채널의 정상/부분 실패·전송 동의.
- **EXP-25:** **OR+RRF vs AND vs 정규화 결합**, 독립 3채널 vs 2채널, 각 3건/5건, 채널 간 중복이 UX에 주는 영향; `종합 7위/맥락 4위` 회귀 테스트.
- **EXP-28:** LangGraph 분기·병렬·상태·재시도·취소/시간 초과·LLM Structured Output/비용/관측성. **MCP 없는 직접 함수 호출**이 충분한지 판단.

**승인되지 않은 항목:** 실제 모델·API·라이선스·성능·비용·RRF 가중치·종합 성능 우위·프레임 디자인 완성. 이것을 구현 완료로 표기하지 않는다.

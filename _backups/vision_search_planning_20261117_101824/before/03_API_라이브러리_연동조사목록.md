# 그거어디? — 사용·연결·검토할 API / SDK / 라이브러리 조사 목록

> v1.1 / 2026-11-16 / **설계 후보·공식 근거 확인 / 실제 프로젝트 연동 미실행**  
> 참고 문서: `00_상세기획안_그거어디_개정.md`, `02_확인_실험_결정_체크리스트.md`.  
> **구분:** `외부 공개 API(키·호출·약관 필요)` / `브라우저 표준 API(접속 환경 필요)` / `오픈소스 라이브러리(설치·라이선스 확인)` / `공식 사용자 이동 링크(기능/API와 다름)`.

## 0. 우선순위 요약

| Priority | 대상 | 분류 | 적용 기능 | 최소 검증 | 현 상태 |
|---|---|---|---|---|---|
| **P0** | 경찰청 습득물 조회 2종 (`API-01/02`) | 공공 API | F2 후보 데이터, 보관 장소 원문 | 발급키 실호출, 이미지 접근/사용권/기관코드/갱신 | **E1 명세 확인 / E2 미실행** |
| **P0** | File System Access API, IndexedDB (`API-05/06`) | 브라우저 표준 | F1 로컬 폴더·임베딩 | Chrome/Edge, 권한, 저장 안정성/삭제 | E1 / 실제 브라우저 미측정 |
| **P0** | Transformers.js 또는 ONNX Runtime Web (`API-08`) | JS 추론 라이브러리 | F1 로컬 이미지↔텍스트 | 공동 모델 구동, WebGPU/WASM/용량 | 후보 |
| **P0** | FastAPI, Pydantic, SQLAlchemy, SQLite | Python 백엔드·저장 | F2/F3/인증 경계 | 타입/테스트/저장 계약 | 후보(기존 기획 우선안) |
| **P0** | 기관 주소 원천 + 카카오맵 (`API-09/10`) | 공공 기관 정보 + 지도 SDK/링크 | **F2 상세 하단 보조지도** | 기관 ID/주소 검증, 지오코딩, 키·비용·정확도 | E1 / 실연동 미실행 |
| **P0** | 실제 로그인·세션 공급자 (`API-07`) | 인증/보안 | F3 계정 | 서버 세션, IDOR, 탈퇴/백업 파기 | 공급자 미정 |
| P1 | 다국어 이미지·텍스트 임베딩 | AI 모델 | F1/F2 검색 | 한국어 정량 성능·모델 호환 | 후보 |
| P1 | OCR/객체 검출/크롭 | AI 라이브러리 | 정확도 보강 | 기본선 대비 효과·라이선스 | 조건부 |
| P1 | Playwright, pytest, Vitest | QA | E2E·보안·성능 | 정상/오류 자동 검증 | 후보 |
| P2 | VLM/외부 이미지 모델 API | 외부 AI | 선택 재정렬 | 효과·프라이버시·비용 검증 | 초기 제외 가능 |

## 1. 공공데이터 API: F2의 시작점

### API-01 경찰청 습득물정보 조회 서비스

- 공식 링크: https://www.data.go.kr/data/15058696/openapi.do
- 용도: 경찰관서 습득물 목록 및 상세·이미지 메타데이터의 공식 공급원 후보.
- 확인해야 할 필드: 관리번호/항목 ID, 물품명·대/중분류, 사진 URL, 습득일·습득 장소, 보관기관·보관장소, 수정/상태, 공식 상세 이동 링크 유무.
- 기존 명세상 보관장소 `depPlace`가 등장하더라도, **모든 응답에 정확한 주소/위도·경도가 있다고 가정하지 않는다.** 실제 목록/상세 필드와 값 차이를 검증한다.
- 테스트 순서: 활용 신청 → 서비스키 발급 → 인증키 실호출 → 날짜/기관/분류 분할 50~100개(가능 시) 샘플 → 이미지 GET 유효성 → NULL/코드 값 검사 → 같은 ID 업데이트/반환 상황 재요청 → 캐시·재배포 조건 승인.
- 수집·정규화는 서버에서 수행하고, 원문과 파생 검색 인덱스를 분리한다. 실제 API 호출 전 `데이터 확보 완료` 표현 금지.

### API-02 경찰청 포털기관 습득물정보 조회 서비스

- 공식 링크: https://www.data.go.kr/data/15057670/openapi.do
- 용도: 경찰 이외 공공·민간 연계 기관의 습득물 보완 공급원.
- 확인할 것: 보관처 기관 코드(예: `DR...`처럼 코드만 들어오는 경우), 경찰관서와 동일한 물건의 중복 등록, 이미지 포함률·동작하지 않는 URL, 공식 상세 링크/상태, 지역·기관별 누락.
- 코드 자체를 지도 좌표로 변환하는 것은 불가능하므로 **공식 기관명/주소 목록을 별도로 확인**해야 한다.
- API-01/02 수집기와 매핑 로직은 공급원별 어댑터 분리(`PoliceFoundItemAdapter`, `PortalFoundItemAdapter`) 권장.

### API-03(후순위) 경찰청 분실물정보 조회 서비스

- 공식 링크: https://www.data.go.kr/data/15000799/openapi.do
- 상태: **현재 F2의 필수 API 아님**. 분실 신고 데이터에는 개인정보와 법적 권한 문제가 있을 수 있으므로, 실제 공개 범위 검증 및 사용자 동의·신고 기능 승인 전 도입하지 않는다.

### 공식 정보 확인용 웹사이트 (API 아님)

- [경찰 LOST112](https://www.lost112.go.kr/): 원본 기록 및 보관처 확인을 위한 외부 공식 출처 후보.
- [경찰민원24](https://minwon24.police.go.kr/): 민원 안내/공식 조회 링크 검토; 경찰 내부 시스템이나 공식 제휴·신고 대행으로 표현하지 않는다.
- **외부 링크 품질:** 개별 물품 상세의 **실제 원본 URL이 API에서 유효하게 제공되는지** 확인. 존재하지 않는 고정 패턴 URL을 추정해 생성하지 않는다. 기록이 삭제·이동된 경우 공식 메인/문의 대안을 제공.

## 2. 지도: F2 **개별 습득물 상세 하단**에서만 사용

### API-09 카카오맵 SDK / Geocoder / 지도 REST

- 공식 소개: https://developers.kakao.com/docs/ko/kakaomap/common
- Web JavaScript SDK: https://apis.map.kakao.com/web/guide/
- Web 상세 문서 (`Geocoder.addressSearch` / `Places.keywordSearch`): https://apis.map.kakao.com/web/documentation/
- 공식 쿼터·요금: https://developers.kakao.com/docs/ko/getting-started/quota
- 용도: `custody_location.status=verified`일 때 단일 보관기관 좌표를 **상세 페이지 맨 아래 소형 지도로 표시**. 주소→좌표와 장소명 확인은 정확한 기관 식별을 보조할 때만.
- **주의 1:** `Geocoder.addressSearch`는 주소가 먼저 확정되어야 안전하다. 기관 이름만으로 첫 검색 결과 좌표를 그대로 쓰지 않는다.
- **주의 2:** 2026-07-21부터 카카오맵 API 활성화/무료 쿼터 제공 방식이 변경된 것으로 공식 문서에 명시되어 있다. 앱별 무료 쿼터·계정 첫 활성화 앱·비즈월렛·유료 사용·키 유형·도메인 등록 확인 필요. 웹 SDK용 JavaScript 키와 REST 키를 혼용하지 않는다.
- **주의 3:** SDK/REST/API 사용량 과금 단위와 지도 외부 링크의 역할은 구분. 대량 기관 주소 변환을 모든 페이지 조회마다 반복하지 않도록 캐시 정책(약관 확인 후)을 별도 검토한다.
- **주의 4:** 정확도/지도 API 동작이 보장되지 않으면 지도 컴포넌트를 숨기되 보관기관명·확인된 주소·전화·공식 출처는 표시한다.

### API-10 확인된 보관기관에 대한 외부 지도/길찾기 링크

- 카카오맵 지도 및 길찾기 URL 패턴 공식 가이드: https://apis.map.kakao.com/web/guide/
- 실제 구현에서 기관 이름·확인된 좌표/장소 ID로 열 수 있는지 모바일·데스크톱 모두 테스트. **우리 웹서비스 내부 경로 안내/사용자 GPS 권한 수집은 MVP 제외.**
- 이미지·검색 문장·F3 원본을 지도 제공자에 전달하지 않는다.

### 보관기관 위치 처리 파이프라인 (반드시 이 순서)

1. 공공 API 원문 필드 `found_place_raw` / `intake_place_raw` / `custody_place_raw` / 기관코드 분리 수집.
2. 보관기관 식별자/코드 정규화; **확인 가능한 기관 공식 자료**로 기관명·주소·전화·확인일 보강.
3. 동명 기관, 이전·변경 주소, 복수 지점, 실시간 반환/이동 등 충돌 검사.
4. 정확히 특정한 기관 주소에 한해 좌표 변환. 위도·경도·기관 식별자·주소 원문·검증 근거 연결.
5. `location_resolution_status ∈ {verified,address_only,ambiguous,missing,invalid,provider_error}` 반환.
6. `verified`만 F2 상세 하단에 **한 개의 지도 마커**를 표시, 다른 상태는 지도 미표시+기관 문의·공식 링크.
7. 안내 문구: **‘지도는 확인된 보관기관의 위치이며, 물건의 실시간 위치가 아닙니다. 방문 전 보관 여부를 문의하세요.’**

**모델 책임 경계:** 이미지 임베딩 엔진은 기관 주소를 추론해서 생성하지 않는다. 지리정보는 **공식 기관 출처 + 검증된 지도 매칭**으로 별도 관리.

## 3. F1 브라우저 로컬 처리 라이브러리 · 표준 API

| 이름·공식 링크 | 역할 | 검증 시 주의 |
|---|---|---|
| [File System Access: showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) | Chrome/Edge 중심 폴더 선택·권한 | 일부 브라우저 미지원, HTTPS·사용자 제스처 요구; 영구 접근 가정 금지 |
| [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) | 개인 임베딩/OCR 메타·폴더 핸들 보관 | 사이트 데이터 삭제/저장 압박·Quota/원본 이동 시 복구 필요 |
| [Storage API/eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) | 저장 지속성/`persist` | persistent 저장은 자동 보장되지 않음 |
| [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) | AI 모델 연산의 UI 블로킹 분리 | 워커에서 가능한 API, 메모리 이동 비용 검증 |
| [Transformers.js](https://huggingface.co/docs/transformers.js/index) | 브라우저 이미지·텍스트 임베딩 실행 | 정확히 같은 모델로 이미지/텍스트 임베딩 가능한지 확인 |
| [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html) | WASM/WebGPU 추론 후보 | 연산자 지원·모델 변환·실장치 속도/VRAM 검증 |
| [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) | 지원 장치의 GPU 추론 가속 | 기기·브라우저 지원 편차; CPU/WASM fallback 검증 |

**F1 중요 설계 경계:** 로그인하지 않아도 브라우저 내 인덱스 검색. F1 원본과 임베딩을 별도 계정 서버에 백업하거나 로그인 속도 혜택이라고 주장하지 않음. 장치가 지원하지 않는 경우 **원본 개인정보를 무단 서버 전송하는 fallback은 금지**. 허용된 파일 직접 선택·재색인 UX 우선.

## 4. 이미지·텍스트 검색 AI 후보 (성능 검증 전)

| 계층 | 후보/참고 링크 | 필수 채택? | 판단 기준 |
|---|---|---|---|
| 이미지↔텍스트 공동 임베딩 | [SigLIP2](https://huggingface.co/docs/transformers/model_doc/siglip2), 다국어 CLIP 및 브라우저 호환 대안 | **기본 검색 모델은 필수**, 모델명은 미정 | **한국어** `Recall@K`, 실제 브라우저 지원, 모델 다운로드·메모리 |
| Python 연구 기반선 | [Transformers](https://huggingface.co/docs/transformers/index), [PyTorch](https://pytorch.org/docs/stable/index.html) | 연구용 후보 | 모델 재현, 버전·전처리·토크나이저 |
| 이미지 처리 | [Pillow](https://pillow.readthedocs.io/), [OpenCV](https://docs.opencv.org/) | 사진 리사이즈·크롭·EXIF 중 하나 | 보안·색상·메모리·성능 |
| OCR | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), [EasyOCR](https://github.com/JaidedAI/EasyOCR) | 조건부 | 한글/영문 스크린샷 CER/검색 성능 이득 |
| 검출 | [YOLOE](https://docs.ultralytics.com/models/yoloe), [Grounding DINO](https://github.com/IDEA-Research/GroundingDINO) | 조건부 | bbox/다중 객체·작은 물체·장치, 라이선스 |
| 분할 | [SAM 3](https://ai.meta.com/research/sam3/) 등 | 조건부 | 수동 크롭보다 명확한 검색 품질 이득 필요 |
| 벡터 검색 | [FAISS](https://github.com/facebookresearch/faiss), [ChromaDB](https://docs.trychroma.com/) | 구현 후보 | F2 공유/F3 계정 벡터 격리, 삭제·재색인·필터 |
| 텍스트 검색 | SQLite FTS, BM25(한국어 전처리 별도) | OCR 도입 시 | 한글 형태소/검색 Recall·지연 |
| VLM 재순위화 | 외부 상용 또는 로컬 모델 | MVP 필수 아님 | 사생활 사진 전송·보존/비용, 품질 개선 실증 |

- **학습과 검색 인덱싱은 다르다.** 공개 API 이미지를 벡터화한 것만으로 재학습했다고 표현하지 않는다.
- **원본/크롭·사진별 벡터 분리**, 서로 다른 모델의 임베딩을 단순 코사인으로 교차 비교하지 않는다.
- Ultralytics/SAM 등 모델과 코드의 라이선스는 **실제 채택할 리포지토리·가중치·상용 배포 형태별**로 별도 검토한다. 공개 GitHub=자유 상용 사용 아님.

## 5. 앱·서버·DB·인증 후보

| 기술 | 역할 | 현재 추천과 주의 |
|---|---|---|
| [React](https://react.dev/) + [Vite](https://vite.dev/) + [TypeScript](https://www.typescriptlang.org/) | 검색 홈·F1/F2/F3·반응형 UI | 기존 기획의 프론트 기본안; 별도 feature 모듈 |
| [FastAPI](https://fastapi.tiangolo.com/) / [Pydantic](https://docs.pydantic.dev/) | 서버 F2 검색·F3 사용자 인증/CRUD·계약 | 외부 API 키 서버에서 보호, 요청/응답 검증 |
| [SQLAlchemy](https://docs.sqlalchemy.org/) / [Alembic](https://alembic.sqlalchemy.org/) / [SQLite](https://www.sqlite.org/docs.html) | 계정/F3 메타·공공데이터·기관 주소 | 서버 F3 원본 저장은 비공개 파일/스토리지 별도, SQLite BLOB 강제 아님 |
| [Google Identity OIDC](https://developers.google.com/identity/openid-connect/openid-connect) | F3 로그인을 위한 한 가지 후보 | 공급자 확정 전. redirect, CSRF, IDOR, 서버 세션/쿠키 검증 |
| [Kakao Login](https://developers.kakao.com/docs/ko/kakaologin/common) | F3 로그인 후보 | OAuth/OIDC 기능·필수 동의·계정 연결·약관 구분 |
| [Naver Login](https://developers.naver.com/docs/login/api/api.md) | F3 로그인 후보 | API 사용조건·심사·서버 계정 일관성 확인 |
| [pytest](https://docs.pytest.org/) / [Vitest](https://vitest.dev/) / [Playwright](https://playwright.dev/) | QA | 원본/벡터 삭제, 브라우저 로컬, 무인증 F2, 위치 오류, 접근성 검증 |

**F3 저장 반드시 포함:** `valuable_id`, `photo_id`, 원본 파일 저장 키, 원본 MIME/해시, 모델/전처리 버전, 각 사진의 검색 벡터·썸네일, 소유자 인증·접근 통제·삭제 전파·백업 파기. 사진 ID/벡터만 저장하는 MVP는 요구사항 위반.

## 6. 제안 내부 API 계약 (외부 공개 API와 별도, 아직 미구현)

| HTTP(제안) | 경로 | 권한 | 주요 입출력 |
|---|---|---|---|
| POST | `/api/found-items/search` | 게스트 허용 | text/image/mixed → 후보·공식원문·freshness |
| GET | `/api/found-items/{source}/{id}` | 게스트 허용 | 물품 상세, 출처, `custody_location`·기관 연락 |
| GET | `/api/custody/{institutionId}` | 게스트 허용 | 검증된 주소·전화·좌표·source·verified_at·status |
| POST | `/api/valuables` | **로그인 필수** | 선택 등록한 **원본 사진 전체+사진별 벡터** 저장 작업·상태 |
| GET/DELETE | `/api/valuables/{id}` | **소유자만** | 원본 열람·수정·삭제 전파, 사진별 참조 |
| POST | `/api/transfers/gallery-to-found` | 게스트 허용+명시 동의 | 사용자가 선택한 사진/크롭 일시 F2 검색, F3 저장 안 함 |

### `custody_location` 제안 응답 일부

```json
{
  "status": "address_only",
  "institution_id": "verified-provider-id",
  "institution_name": "기관명(공식 매핑)",
  "address": "검증된 실제 주소 또는 null",
  "phone": "공식 연락처 또는 null",
  "lat": null,
  "lng": null,
  "source": "official-institution-directory",
  "verified_at": null,
  "map_enabled": false
}
```

위 JSON은 **스키마 예시**이며 실제 기관 또는 인증된 좌표가 아니다. `address_only`이므로 좌표는 null, `map_enabled=false`다. `verified`는 공식 기관·주소·지도 좌표의 연결이 모두 검증된 경우로 엄격히 정의한다. `found_place`와 `custody_location`은 다른 필드로 저장.

## 7. 로드맵·검증 순서

1. **필수 선행:** 경찰청 API 실제 호출·이용 조건 → F2 데이터 사용 여부 (`EXP-06`).
2. 동시에 F1 브라우저 로컬 model+IndexedDB 단일 PoC (`EXP-13/14`)와 등록 원본·벡터 저장 실패/접근 테스트 설계 (`EXP-16/21`).
3. 동일 실물 하드 네거티브 검색 정답셋 구성, 기본 임베딩 정량 비교 (`EXP-01/03/05`).
4. 보관기관 코드·명칭 → 확인된 주소 → 정확한 좌표 매핑(`EXP-22`)을 **지도 시각화보다 먼저** 시험.
5. 지도/길찾기는 F2 상세 하단에만 붙임. 주소 신뢰성 부족하면 공식 링크·기관정보 우선.
6. `그거어디?` 브랜드 인식·상표·도메인 및 UX 실사용자 테스트 (`EXP-18~20/23`).
7. 오픈 항목을 ADR로 확정하고 PRD→상세 Figma→개발 계약으로 이동.

## 8. 공식 출처 (문서상 검증과 실호출을 구분)

- 경찰청 공공데이터포털 API: https://www.data.go.kr/data/15058696/openapi.do / https://www.data.go.kr/data/15057670/openapi.do
- 카카오맵 2026 정책·SDK: https://developers.kakao.com/docs/ko/kakaomap/common / https://developers.kakao.com/docs/ko/getting-started/quota / https://apis.map.kakao.com/web/guide/
- 브라우저 폴더 접근·저장 위험: https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker / https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- F1 브라우저 AI: https://huggingface.co/docs/transformers.js/index / https://onnxruntime.ai/docs/get-started/with-javascript/web.html
- 한국 상표: https://www.kipris.or.kr/khome/main.do

**주의:** 공식 문서에서 해당 기술의 존재를 확인한 것(E1)과, 이 프로젝트의 키로 데이터 수집·계산을 실행한 것(E2), 실제 정량 품질(E3)은 서로 다르다. **현재 실제 연동·비용청구·모델 구동·상표 등록심사를 완료한 것은 없다.**

# 그거어디? 인증 API (FastAPI)

일반 이메일 회원가입/로그인과 카카오 OAuth를 한 곳에서 관리하는 서버다. **카카오 키를 포함한 모든 비밀값은 서버 `.env`에만 두고 브라우저에는 전달하지 않는다.**

## 실행

```powershell
cd "C:\Users\mbc\Documents\git\비전 AI 활용하여 웹서비스 만들기\backend"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

프론트엔드에서 `npm run dev`를 실행하면 Vite가 `/api`를 이 서버(8000)로 프록시한다. 서버를 따로 띄우지 않아도 `scripts/dev.mjs`가 자동으로 실행을 시도한다.

## 점검

```powershell
.\.venv\Scripts\python.exe -m pytest
curl http://127.0.0.1:8000/api/health
```

### AI search pipeline (2026-11-23 갱신)

역할은 **두 개**다. `multimodal`은 자연어·이미지·joint 해석과 AND/OR/NOT 조건, 맥락 채점을 맡고 `imageSimilarity`는 사진 임베딩 코사인 유사도를 계산한다. `llm`/`vlm`/`vision`은 호환용 별칭이다. 기본값은 멀티모달 `openai-compatible` · `gpt-6-luna`, 유사도는 `GEUGEO_AI_SIMILARITY_PROVIDER=local-clip`(사전학습 CLIP `ViT-B-32`/`laion2b_s34b_b79k` + YOLOE `yoloe-11s-seg.pt`, 별도 학습 없음). `OPENAI_API_KEY`는 서버 `.env` 전용이고 역할별 설정은 `.env.example`에 있다. 환경변수 변경 후에는 서버를 재시작해야 한다. `gpt-6-luna`는 `temperature`를 거부하므로 요청에서 보내지 않는다.

프롬프트는 `backend/prompts/`에서 코드 수정 없이 갱신할 수 있다. `GET /api/ai/status`는 키 값을 노출하지 않고 가용성만 보고한다. `POST /api/ai/search/prepare`는 combined/image/context 계획과 필터를 돌려준다. `POST /api/ai/vision/match-public`은 공개 기관 사진과 설명을 대조해 0~100 점수를 반환한다. LangGraph는 사진 없으면 LLM만, 사진 있으면 VLM 설명 → joint 멀티모달을 호출하고, 로컬 임베딩이 성공하면 폴백을 생략한다. 크롭은 객체 ≥2개 또는 종류 ≥2가지일 때만 수행하며 VLM census가 게이팅을 보강한다.

AI 안내·동의는 팝업이 아니라 `/lost-found` 하단 요약으로 처리한다. 실패 시 원문 검색으로 폴백한다. 직접 찾기는 점수 재정렬 없이 공개 API 순서를 유지한다. 유사도 점수는 동일 실물·소유권·회수 보장이 아니다. 전체 이관 상태와 실측 수치는 `../vision_search_planning/14_코덱스_이관_핸드오프.md`를 참조한다.

실검색 평가: `.\.venv\Scripts\python.exe scripts\eval_visual_search.py`(결과는 `data/eval/`, gitignored). 이관 시점 백엔드 pytest **97개 통과**, 이미지 R@1 **1.000**.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/auth/signup` | `{email, password, nickname?, recoveryQuestion, recoveryAnswer}` 가입 후 세션 쿠키 발급 |
| POST | `/api/auth/login` | `{email, password}` 로그인 후 세션 쿠키 발급 |
| GET | `/api/auth/me` | 현재 로그인 사용자. 미로그인이면 401 |
| POST | `/api/auth/logout` | 서버 세션 삭제 + 쿠키 삭제 |
| GET | `/api/auth/recovery-questions` | 보안 질문 목록 |
| POST | `/api/auth/find-email` | `{nickname, recoveryQuestion, recoveryAnswer}` → `{emails}` |
| POST | `/api/auth/reset-password` | `{email, recoveryQuestion, recoveryAnswer, newPassword}` → 비밀번호 변경·기존 세션 종료 |
| POST | `/api/auth/kakao/start` | `{returnTo}` → 카카오 인가 URL과 `state` 쿠키 |
| POST | `/api/auth/kakao/callback` | `{code, state}` → 토큰 교환·사용자 조회·세션 발급 |
| POST | `/api/lostfound/search` | `{keyword, page?, rows?, hints?}` → 경찰서·포털기관 습득물 통합 검색 |
| POST | `/api/lostfound/browse` | 공식 코드표 필터로 전체 스캔, 건수·페이지 재계산(공개 순서 유지) |
| GET | `/api/lostfound/map-config` | Kakao **JavaScript 키만** 전달(REST/서비스키는 서버 전용) |
| POST | `/api/lostfound/geocode` · `/api/lostfound/route` | 보관장소 좌표·길안내(서버 REST 키 사용) |
| GET | `/api/lostfound/{source}/{atcId}/{fdSn}` | 선택한 습득물 1건 상세 + 보관장소 좌표·카카오맵 링크 |
| GET | `/api/ai/status` · POST `/api/ai/search/prepare` · `/api/ai/vision/match-public` | AI 상태·조건 분석·공개 사진/설명 대조(키 값 비노출) |
| GET | `/api/health` · `/health` | 상태 확인(같은 응답, `/health`는 스키마 제외 별칭) |

## 보안 메모

- 비밀번호와 보안 질문 답변은 PBKDF2-HMAC-SHA256(200,000회, salt 16바이트)로 해싱한다. 평문은 저장하지 않는다. 답변은 공백·대소문자를 정규화해 검증한다.
- 비밀번호 재설정은 해당 사용자의 모든 세션을 삭제하므로 기존 로그인은 종료된다.
- 세션 토큰은 `secrets.token_urlsafe(32)`로 만들고 **해시만 DB에 저장**한다. 브라우저에는 HttpOnly·SameSite=Lax 쿠키로 전달한다.
- 카카오 `state`는 httponly 쿠키 + DB 기록으로 검증하고, 콜백에서 일회용으로 삭제한다.
- `Origin` 헤더를 검사하고 CORS 출처를 `.env`의 `GEUGEO_ALLOWED_ORIGINS`로 제한한다.
- `client_secret`과 REST API 키는 서버에서만 쓴다. 프론트엔드에는 `VITE_KAKAO_*` 변수가 없다.
- 카카오 콘솔의 **앱 > 플랫폼 키 > REST API 키 > 클라이언트 시크릿**에서 발급된 값을 `.env`의 `KAKAO_CLIENT_SECRET`에 넣어야 토큰 교환이 된다. 비어 있으면 카카오가 `KOE010(invalid_client)`을 반환한다. 값을 바꾼 뒤에는 서버를 재시작해야 적용된다.
- DB는 `backend/data/app.db`(git 제외)다. **로그인 상태의 ‘찾은 기록’·‘사진 등록해 두기’ 항목만 계정에 저장**하고, F1/F2 검색 입력·참고 사진·갤러리 원본은 브라우저에만 둔다.
- 경찰청 서비스키도 `.env`의 `POLICE_SERVICE_KEY`에만 둔다. **디코딩된 키**를 넣어야 한다(인코딩된 키를 그대로 넣으면 이중 인코딩으로 인증 실패). 브라우저 번들에는 절대 넣지 않는다.
- 경찰청 API는 XML만 지원한다. 경찰서(`LosfundInfoInqireService`)와 포털기관(`LosPtfundInfoInqireService`)을 모두 조회한다. 목록 검색·선택 건 상세 외에 공식 코드표 필터 API(`getLosfundInfoAccToClAreaPd`/`getPtLosfundInfoAccToClAreaPd`)를 분류·지역·색상·기간 필터에 사용한다. 코드 없는 값은 기존 텍스트 필터로 폴백한다.
- 검색 결과는 `lostfound_cache`에 5분, 상세는 24시간, 카카오 지오코딩 결과는 `geo_cache`에 30일 캐시한다. 캐시 키에 사용자 ID는 넣지 않는다.
- 카카오맵은 서버에서 보관장소를 지오코딩해 좌표와 `map.kakao.com/link/map/...` 링크만 반환한다. JavaScript 키를 브라우저에 노출하지 않는다.

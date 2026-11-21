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

### AI search pipeline

The AI search API uses three replaceable, OpenAI-compatible roles: `llm` for text and filter interpretation, `vlm` for reference-image descriptions, and `vision` for candidate-image comparison. All three default to GPT-6 Luna (`gpt-6-luna`). Set `OPENAI_API_KEY` in the server-only `.env` to enable them; role-specific API keys, base URLs, providers, and model names are available in `.env.example`. Restart the backend after changing environment settings.

Prompts live in `backend/prompts/` and can be edited without changing application code. `GET /api/ai/status` reports model availability without exposing keys. `POST /api/ai/search/prepare` returns editable combined, image, and context query plans plus suggested filters. `POST /api/ai/vision/compare` scores up to 12 supplied candidate images. Every AI request requires explicit external-processing consent; image/query payloads are processed in memory only, and the OpenAI request disables response storage. Provider abuse-monitoring and retention policies may still apply.

F1/F2 input and result-assistant flows use the prepare endpoint after explicit consent, and their summaries retain the original text and AI plan. `/direct-search` intentionally remains general keyword search plus public-result filters for now. Candidate-comparison is an API foundation only; result scoring/reordering is not yet connected and must never be described as proof that two photos show the same physical item. Without configured keys, AI endpoints return a clear configuration error; regular search remains available.

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
| GET | `/api/lostfound/{source}/{atcId}/{fdSn}` | 선택한 습득물 1건 상세 + 보관장소 좌표·카카오맵 링크 |
| GET | `/api/health` | 상태 확인 |

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
- 경찰청 API는 XML만 지원한다. 경찰서(`LosfundInfoInqireService`)와 포털기관(`LosPtfundInfoInqireService`)을 모두 조회하되, 목록 검색과 선택 건 상세만 호출한다. 분류/기간/위치기반 오퍼레이션은 호출하지 않는다.
- 검색 결과는 `lostfound_cache`에 5분, 상세는 24시간, 카카오 지오코딩 결과는 `geo_cache`에 30일 캐시한다. 캐시 키에 사용자 ID는 넣지 않는다.
- 카카오맵은 서버에서 보관장소를 지오코딩해 좌표와 `map.kakao.com/link/map/...` 링크만 반환한다. JavaScript 키를 브라우저에 노출하지 않는다.

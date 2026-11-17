# 그거어디? Frontend

홈·검색 입력 화면 1차 구현. React + TypeScript + Vite.

```powershell
cd "C:\Users\mbc\Documents\git\비전 AI 활용하여 웹서비스 만들기\frontend"
npm install
npm run dev
```

개발 서버: http://127.0.0.1:5173

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

## 구현 범위

- `/`: 비로그인 홈, `/gallery`: 갤러리에서 사진 찾기, `/lost-found`: 분실물 찾기.
- 네비게이션의 홈 항목은 제거하고 로고로 홈에 복귀한다. 두 검색 모드는 네비게이션 바로 아래의 전환 영역에 배치한다.
- 경로별 독립된 텍스트·참고 사진. 모드를 바꿔도 서로의 사진을 자동 전달하지 않는다.
- 실제 로컬 사진 미리보기/변경/삭제, 드래그 앤 드롭, 이미지 디코드 오류, 빈 입력 안내.
- 실제 폴더/다중 사진 선택. 연결한 자료 전체를 검색 대상으로 표시한다. 참고 사진은 검색 모집단을 대신하지 않는다.
- 글만/사진만/혼합의 검색 입력 확인. F2 요청 계약은 항상 이미지·설명조건 두 경로다.
- 반응형 내비·로그인 안내·갤러리 관리·사진 처리 안내·네이티브 모달.
- 한글 IME 조합 중 Enter 전송 방지, Shift+Enter 줄바꿈, 키보드 탭·모드 화살표·focus·Escape.

## 아직 연결하지 않은 기능

AI/VLM/임베딩·검색 결과·경찰청 API·계정 인증·서버 원본/벡터 저장·로컬 인덱스 영속화는 구현하지 않았다. 파일은 메모리와 Blob URL로만 미리 보고 서버로 전송하지 않는다. 새로고침하면 연결과 입력이 사라진다. 검색 버튼은 현재 입력 요약을 열며 검색 성공/로딩을 꾸미지 않는다. 사진 예시는 샘플이다.

추후 실제 검색은 features/search/model.ts의 입력 계약에 어댑터를 연결한다. 모델 키와 비밀값을 프론트엔드 환경변수에 넣지 않는다.

## 디자인·출처

[`docs/DESIGN.md`](docs/DESIGN.md)의 방향과 제품 경계를 따른다. Design process adapted from **unslop by Damir Sokolovsky (@heydamir)** — [원본](https://github.com/heydamir/unslop), [CC BY4.0](https://creativecommons.org/licenses/by/4.0/). 스킬을 실제 설치하고 signs/tokens/visuals/refs 지침을 읽어 적용했다. Figma 파일은 변경하지 않았다.

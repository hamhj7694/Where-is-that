import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, LockKeyhole, LogOut } from 'lucide-react'
import Modal from '../../components/Modal'
import type { GallerySource } from '../search/model'
import { DemoNotice, PageHeading } from './components'
import { AuthGate } from './ValuablesPages'
import { OFFICIAL_SEARCH_URL, safeReturn, type Valuable } from './data'

interface AccountProps { session: boolean; items: Valuable[]; onDemoLogin: () => void; onLogout: () => void }

export function LoginPage({ session, onDemoLogin }: AccountProps) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = safeReturn(params.get('returnTo'), '/valuables')
  return <main id="main-content" className="content-workspace"><div className="login-panel"><LockKeyhole aria-hidden="true" /><PageHeading title={session ? '체험 계정으로 보고 있어요' : '소중한 것들을 내 계정에'} description="사진 원본과 사진별 검색정보를 보관해요." />
    {params.get('state') === 'error' && <p className="inline-error" role="alert">로그인 실패 상태 예시예요. 다시 시도해 주세요.</p>}
    {params.get('state') === 'expired' && <p className="inline-error" role="alert">로그인 만료 상태 예시예요.</p>}
    <button className="button button--primary" onClick={() => { onDemoLogin(); navigate(next, { replace: true }) }}>{session ? '계속하기' : '체험용 계정으로 보기'}<ArrowRight aria-hidden="true" /></button>
    <Link className="button button--secondary" to="/">검색으로 돌아가기</Link><p className="field__help">실제 로그인·서버 저장은 아직 연결되지 않았어요.</p></div></main>
}

export function AccountPage({ session, items, onLogout }: AccountProps) {
  const [confirm, setConfirm] = useState(false)
  const navigate = useNavigate()
  if (!session) return <AuthGate returnTo="/account" />
  return <main id="main-content" className="content-workspace"><PageHeading title="내 계정" /><DemoNotice>체험용 계정 · 실제 계정이 생성되지 않아요.</DemoNotice>
    <section className="settings-group"><h2>소중한 것들</h2><div className="settings-row"><div><strong>임시 항목 {items.length}개</strong><p>현재 브라우저에서만 확인해요.</p></div><Link className="button button--secondary" to="/valuables">목록 보기<ArrowRight aria-hidden="true" /></Link></div></section>
    <section className="settings-group"><h2>계정</h2><div className="settings-row"><div><strong>체험 계정</strong><p>로그아웃하면 임시 변경 내용이 사라져요.</p></div><button className="button button--secondary" onClick={() => setConfirm(true)}><LogOut aria-hidden="true" />로그아웃</button></div></section>
    <Modal open={confirm} title="체험 계정에서 나갈까요?" focusKey="logout" onClose={() => setConfirm(false)}><p>임시 변경 내용은 사라져요. 기기 원본과 갤러리 연결은 유지해요.</p><div className="button-row"><button className="button button--secondary" onClick={() => setConfirm(false)}>취소</button><button className="button button--primary" onClick={() => { onLogout(); setConfirm(false); navigate('/') }}>로그아웃</button></div></Modal>
  </main>
}

export function SettingsPage({ gallery, session, onOpenGallery, onDisconnect }: { gallery: GallerySource | null; session: boolean; onOpenGallery: () => void; onDisconnect: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return <main id="main-content" className="content-workspace"><PageHeading title="설정" />
    <section className="settings-group"><h2>갤러리</h2><div className="settings-row"><div><strong>{gallery ? gallery.name + ' · ' + gallery.files.length + '장' : '연결한 갤러리 없음'}</strong><p>기기의 원본은 그대로 유지해요.</p></div><button className="button button--secondary" onClick={onOpenGallery}>{gallery ? '갤러리 관리' : '갤러리 연결'}</button></div>
      <div className="settings-row"><div><strong>검색정보</strong><p>현재 체험에서는 검색 인덱스를 저장하지 않아요.</p></div><span className="status-badge">미생성</span></div>
      {gallery && <div className="settings-row"><div><strong>갤러리 연결 해제</strong><p>원본 사진을 삭제하지 않아요.</p></div><button className="button button--secondary" onClick={() => setConfirm(true)}>연결 해제</button></div>}</section>
    <section className="settings-group"><h2>계정과 데이터</h2><div className="settings-row"><div><strong>소중한 것들</strong><p>{session ? '브라우저 안의 임시 항목이에요.' : '계정에 등록한 사진을 관리해요.'}</p></div><Link className="button button--secondary" to={session ? '/account' : '/auth/login?returnTo=%2Faccount'}>{session ? '계정 보기' : '로그인'}</Link></div><div className="settings-row"><div><strong>사진 처리</strong></div><Link className="button button--secondary" to="/privacy">범위 확인</Link></div></section>
    <Modal open={confirm} title="갤러리 연결을 해제할까요?" focusKey="disconnect" onClose={() => setConfirm(false)}><p>연결 정보와 갤러리 검색 기록을 지워요. 기기의 원본은 삭제하지 않아요.</p><div className="button-row"><button className="button button--secondary" onClick={() => setConfirm(false)}>취소</button><button className="button button--primary" onClick={() => { onDisconnect(); setConfirm(false) }}>연결 해제</button></div></Modal>
  </main>
}

export function InfoPage({ page }: { page: 'privacy' | 'about' }) {
  return <main id="main-content" className="content-workspace"><PageHeading title={page === 'privacy' ? '사진 처리 안내' : '화면 체험 안내'} back={{ to: '/', label: '검색으로' }} />
    {page === 'privacy' ? <><DemoNotice>현재는 브라우저 메모리에서만 처리해요. 서버 전송·저장은 없어요.</DemoNotice><section className="settings-group"><h2>현재 체험</h2><dl className="detail-facts"><div><dt>사진과 입력</dt><dd>이 브라우저에서만 미리보기</dd></div><div><dt>유지 기간</dt><dd>새로고침하면 초기화</dd></div><div><dt>원본</dt><dd>기기에서 변경·삭제하지 않음</dd></div></dl></section>
      <section className="settings-group"><h2>정식 서비스의 저장 범위</h2><dl className="detail-facts"><div><dt>갤러리 검색</dt><dd>기기의 원본과 로컬 검색정보</dd></div><div><dt>분실물 검색</dt><dd>선택 사진만 서버에서 일시 처리</dd></div><div><dt>소중한 것들</dt><dd>명시 등록한 원본 전체와 사진별 검색용 임베딩을 계정 서버에 저장</dd></div></dl><p className="field__help">갤러리 전체를 계정에 자동 등록하지 않아요. 등록한 자료는 목록·상세에서 확인하고 삭제해요.</p></section></>
      : <><DemoNotice>프론트엔드 체험 · AI·경찰청 API·실제 계정 저장은 미연결이에요.</DemoNotice><section className="settings-group"><h2>지금 해볼 수 있어요</h2><div className="settings-row"><div><strong>사진·입력·화면 이동</strong><p>샘플 후보와 임시 물건을 둘러보세요.</p></div><Link className="button button--secondary" to="/preview">화면 목록</Link></div></section>
        <section className="settings-group"><h2>공식 데이터 출처</h2><p className="field__help">아래 API의 실제 응답·사진 가용성은 아직 검증하지 않았어요.</p><div className="source-links"><a href="https://www.data.go.kr/data/15058696/openapi.do" target="_blank" rel="noreferrer">경찰청_습득물정보 조회 서비스<ArrowRight aria-hidden="true" /></a><a href="https://www.data.go.kr/data/15057670/openapi.do" target="_blank" rel="noreferrer">경찰청_포털기관 습득물정보 조회 서비스<ArrowRight aria-hidden="true" /></a><a href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">경찰민원24 습득물 검색 안내<ArrowRight aria-hidden="true" /></a></div></section></>}
  </main>
}

export function PreviewIndex() {
  const groups = [
    { title: '검색', links: [['홈', '/'], ['갤러리 입력', '/gallery'], ['분실물 입력', '/lost-found'], ['갤러리 결과', '/gallery/results'], ['찾은 기록', '/history']] },
    { title: '분실물 후보', links: [['두 검색 결과', '/lost-found/results'], ['사진 전체 보기', '/lost-found/results/image'], ['설명·조건 전체 보기', '/lost-found/results/context'], ['후보 상세', '/lost-found/item/demo/demo-01'], ['사진 없는 후보', '/lost-found/item/demo/demo-08']] },
    { title: '소중한 것들', links: [['물건 목록·로그인', '/valuables'], ['물건 등록', '/valuables/new'], ['임시 물건 상세', '/valuables/sample-v1'], ['수정', '/valuables/sample-v1/edit'], ['로그인', '/auth/login'], ['계정', '/account'], ['설정', '/settings'], ['사진 처리', '/privacy']] },
    { title: '검색 상태', links: [['전체 빈 결과', '/lost-found/results?state=empty'], ['이미지 0·설명 정상', '/lost-found/results?state=image-empty'], ['이미지 오류·설명 정상', '/lost-found/results?state=image-error'], ['설명 오류·이미지 정상', '/lost-found/results?state=context-error'], ['전체 오류', '/lost-found/results?state=error'], ['로딩', '/lost-found/results?state=loading'], ['사진 해석 실패', '/lost-found/results?state=interpretation-error'], ['동의 필요', '/lost-found/results?state=consent-required'], ['기록 변경', '/lost-found/results?state=stale']] },
    { title: '위치 상태', links: ['verified', 'address_only', 'ambiguous', 'missing', 'provider_error'].map(state => [state, '/lost-found/item/demo/demo-01?location=' + state]) },
    { title: '갤러리·등록 상태', links: [['권한 거부', '/gallery/results?state=permission'], ['폴더 미지원', '/gallery/results?state=unsupported'], ['검색 준비', '/gallery/results?state=indexing'], ['원본 접근 실패', '/gallery/photo/sample-wallet?state=missing'], ['원본 저장 중', '/valuables/new?state=original-saving'], ['검색정보 처리 중', '/valuables/new?state=vector-saving'], ['원본 저장 실패', '/valuables/new?state=original-error'], ['검색정보 처리 실패', '/valuables/new?state=vector-error'], ['완료 상태 예시', '/valuables/new?state=complete']] },
  ]
  return <main id="main-content" className="content-workspace"><PageHeading title="화면 미리보기" description="모든 화면과 주요 상태를 확인해요." /><DemoNotice>상태 예시는 실제 처리·검색·저장 결과가 아니에요.</DemoNotice><div className="preview-groups">{groups.map(group => <section className="settings-group" key={group.title}><h2>{group.title}</h2><div className="preview-links">{group.links.map(([label, to]) => <Link key={to} to={to}>{label}<ArrowRight aria-hidden="true" /></Link>)}</div></section>)}</div></main>
}

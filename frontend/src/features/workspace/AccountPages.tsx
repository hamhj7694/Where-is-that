import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, Camera, LockKeyhole, LogOut, MessageCircle, Trash2 } from 'lucide-react'
import { ACCOUNT_DELETE_CONFIRMATION, fileToDataUrl } from '../account/content'
import { useAuth } from '../auth/AuthContext'
import { findEmail, resetPassword, type SignupInput } from '../auth/api'
import { authErrorMessage, messageFromError } from '../auth/messages'
import { RECOVERY_QUESTIONS } from '../auth/recovery'
import Modal from '../../components/Modal'
import type { GallerySource } from '../search/model'
import { DemoNotice, PageHeading } from './components'
import { AuthGate } from './ValuablesPages'
import { OFFICIAL_SEARCH_URL, safeReturn, type Valuable } from './data'

interface AccountProps { session: boolean; items: Valuable[]; onLogout: () => void }

export function LoginPage({ session }: AccountProps) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { signIn, beginKakaoLogin } = useAuth()
  const next = safeReturn(params.get('returnTo'), '/valuables')
  const [mode, setMode] = useState<'choice' | 'email'>('choice')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(params.get('error') ? authErrorMessage(params.get('error')) : '')
  const [busy, setBusy] = useState(false)
  const signupTo = '/auth/signup?returnTo=' + encodeURIComponent(next)

  const handleEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(email, password)
      navigate(next, { replace: true })
    } catch (reason) {
      setError(messageFromError(reason))
    } finally {
      setBusy(false)
    }
  }

  const handleKakao = async () => {
    setError('')
    setBusy(true)
    try {
      await beginKakaoLogin(next)
    } catch (reason) {
      setError(messageFromError(reason))
      setBusy(false)
    }
  }

  return <main id="main-content" className="content-workspace"><div className="login-panel"><LockKeyhole aria-hidden="true" />
    <PageHeading title={session ? '이미 로그인했어요' : '소중한 물건 사진을 계정에'} description="사진 원본과 사진별 검색정보를 보관해요." />
    {session
      ? <button type="button" className="button button--primary" onClick={() => navigate(next, { replace: true })}>계속하기<ArrowRight aria-hidden="true" /></button>
      : <>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button type="button" className="button button--primary kakao-login-button" disabled={busy} onClick={() => { void handleKakao() }}><MessageCircle aria-hidden="true" />카카오로 로그인<ArrowRight aria-hidden="true" /></button>
        <div className="login-divider"><span>또는</span></div>
        {mode === 'choice'
          ? <button type="button" className="button button--secondary" onClick={() => setMode('email')}>이메일로 로그인</button>
          : <form className="login-form" onSubmit={event => { void handleEmail(event) }}>
            <div className="field"><label htmlFor="login-email">이메일</label><input id="login-email" type="email" autoComplete="email" value={email} maxLength={254} required onChange={event => setEmail(event.target.value)} /></div>
            <div className="field"><label htmlFor="login-password">비밀번호</label><input id="login-password" type="password" autoComplete="current-password" value={password} maxLength={64} required onChange={event => setPassword(event.target.value)} /></div>
            <button className="button button--primary" type="submit" disabled={busy}>로그인<ArrowRight aria-hidden="true" /></button>
            <div className="login-links">
              <Link to={'/auth/find?mode=email&returnTo=' + encodeURIComponent(next)}>아이디 찾기</Link>
              <Link to={'/auth/find?mode=password&returnTo=' + encodeURIComponent(next)}>비밀번호 찾기</Link>
            </div>
            <button type="button" className="text-button" onClick={() => { setMode('choice'); setError('') }}>다른 방법으로</button>
          </form>}
        <Link className="button button--secondary" to={signupTo}>회원가입</Link>
      </>}
    <Link className="button button--ink" to="/">검색으로 돌아가기</Link>
    <p className="field__help">로그인으로 본인 확인을 해요. 로그인 전에 만든 목록과 기록은 이 계정으로 이관돼요.</p>
  </div></main>
}

export function SignupPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { signUp } = useAuth()
  const next = safeReturn(params.get('returnTo'), '/valuables')
  const [email, setEmail] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [question, setQuestion] = useState(RECOVERY_QUESTIONS[0])
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    if (password !== confirm) { setError('비밀번호가 일치하지 않아요.'); return }
    setBusy(true)
    try {
      const input: SignupInput = {
        email,
        password,
        nickname,
        recoveryQuestion: question,
        recoveryAnswer: answer,
      }
      await signUp(input)
      navigate(next, { replace: true })
    } catch (reason) {
      setError(messageFromError(reason))
    } finally {
      setBusy(false)
    }
  }

  return <main id="main-content" className="content-workspace"><div className="login-panel"><LockKeyhole aria-hidden="true" />
    <PageHeading title="회원가입" description="이메일로 계정을 만들어요." />
    {error && <p className="inline-error" role="alert">{error}</p>}
    <form className="login-form" onSubmit={event => { void handleSubmit(event) }}>
      <div className="field"><label htmlFor="signup-email">이메일</label><input id="signup-email" type="email" autoComplete="email" value={email} maxLength={254} required onChange={event => setEmail(event.target.value)} /></div>
      <div className="field"><label htmlFor="signup-nickname">닉네임 <span>선택</span></label><input id="signup-nickname" type="text" value={nickname} maxLength={20} onChange={event => setNickname(event.target.value)} /></div>
      <div className="field"><label htmlFor="signup-password">비밀번호</label><input id="signup-password" type="password" autoComplete="new-password" value={password} minLength={8} maxLength={64} required onChange={event => setPassword(event.target.value)} /><p className="field__help">8자 이상 64자 이하로 입력해 주세요.</p></div>
      <div className="field"><label htmlFor="signup-confirm">비밀번호 확인</label><input id="signup-confirm" type="password" autoComplete="new-password" value={confirm} minLength={8} maxLength={64} required onChange={event => setConfirm(event.target.value)} /></div>
      <div className="field"><label htmlFor="signup-question">보안 질문</label><select id="signup-question" value={question} onChange={event => setQuestion(event.target.value)}>{RECOVERY_QUESTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select><p className="field__help">비밀번호를 잊었을 때 계정을 찾는 데 사용해요.</p></div>
      <div className="field"><label htmlFor="signup-answer">보안 질문 답변</label><input id="signup-answer" type="text" value={answer} minLength={2} maxLength={100} required onChange={event => setAnswer(event.target.value)} /><p className="field__help">답변은 암호화되어 저장되며 아이디·비밀번호 찾기에 필요해요.</p></div>
      <button className="button button--primary" type="submit" disabled={busy}>가입하기<ArrowRight aria-hidden="true" /></button>
    </form>
    <Link className="button button--ink" to={'/auth/login?returnTo=' + encodeURIComponent(next)}>로그인으로 돌아가기</Link>
    <p className="field__help">가입하면 로그인 전에 만든 목록과 기록이 이 계정으로 이관돼요.</p>
  </div></main>
}

export function FindAccountPage({ mode }: { mode: 'email' | 'password' }) {
  const [params] = useSearchParams()
  const { signOut } = useAuth()
  const next = safeReturn(params.get('returnTo'), '/valuables')
  const [question, setQuestion] = useState(RECOVERY_QUESTIONS[0])
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [answer, setAnswer] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [foundEmails, setFoundEmails] = useState<string[] | null>(null)
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const loginTo = '/auth/login?returnTo=' + encodeURIComponent(next)
  const otherMode = '/auth/find?mode=' + (mode === 'email' ? 'password' : 'email') + '&returnTo=' + encodeURIComponent(next)

  const handleFindEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      setFoundEmails(await findEmail(nickname, question, answer))
    } catch (reason) {
      setError(messageFromError(reason))
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) { setError('비밀번호가 일치하지 않아요.'); return }
    setBusy(true)
    try {
      await resetPassword(email, question, answer, newPassword)
      await signOut()
      setChanged(true)
    } catch (reason) {
      setError(messageFromError(reason))
    } finally {
      setBusy(false)
    }
  }

  const questionField = <div className="field"><label htmlFor="find-question">보안 질문</label><select id="find-question" value={question} onChange={event => setQuestion(event.target.value)}>{RECOVERY_QUESTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
  const answerField = <div className="field"><label htmlFor="find-answer">보안 질문 답변</label><input id="find-answer" type="text" value={answer} minLength={2} maxLength={100} required autoComplete="off" onChange={event => setAnswer(event.target.value)} /></div>

  return <main id="main-content" className="content-workspace"><div className="login-panel"><LockKeyhole aria-hidden="true" />
    <PageHeading title={mode === 'email' ? '아이디 찾기' : '비밀번호 찾기'} description={mode === 'email' ? '가입할 때 등록한 닉네임과 보안 질문으로 이메일을 찾아요.' : '가입할 때 등록한 이메일과 보안 질문으로 비밀번호를 다시 설정해요.'} />
    {error && <p className="inline-error" role="alert">{error}</p>}
    {mode === 'email'
      ? (foundEmails
        ? <><p className="field__help" role="status">가입한 이메일이에요.</p><ul className="recovery-result">{foundEmails.map(value => <li key={value}>{value}</li>)}</ul><Link className="button button--primary" to={loginTo}>로그인하기<ArrowRight aria-hidden="true" /></Link></>
        : <form className="login-form" onSubmit={event => { void handleFindEmail(event) }}>
          <div className="field"><label htmlFor="find-nickname">닉네임</label><input id="find-nickname" type="text" value={nickname} maxLength={20} required onChange={event => setNickname(event.target.value)} /></div>
          {questionField}
          {answerField}
          <button className="button button--primary" type="submit" disabled={busy}>이메일 찾기<ArrowRight aria-hidden="true" /></button>
        </form>)
      : (changed
        ? <><p className="field__help" role="status">비밀번호를 바꿨어요. 기존 로그인은 종료되어 다시 로그인해 주세요.</p><Link className="button button--primary" to={loginTo}>로그인하기<ArrowRight aria-hidden="true" /></Link></>
        : <form className="login-form" onSubmit={event => { void handleReset(event) }}>
          <div className="field"><label htmlFor="find-email">이메일</label><input id="find-email" type="email" autoComplete="email" value={email} maxLength={254} required onChange={event => setEmail(event.target.value)} /></div>
          {questionField}
          {answerField}
          <div className="field"><label htmlFor="find-new-password">새 비밀번호</label><input id="find-new-password" type="password" autoComplete="new-password" value={newPassword} minLength={8} maxLength={64} required onChange={event => setNewPassword(event.target.value)} /><p className="field__help">8자 이상 64자 이하로 입력해 주세요.</p></div>
          <div className="field"><label htmlFor="find-confirm-password">새 비밀번호 확인</label><input id="find-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} minLength={8} maxLength={64} required onChange={event => setConfirmPassword(event.target.value)} /></div>
          <button className="button button--primary" type="submit" disabled={busy}>비밀번호 변경<ArrowRight aria-hidden="true" /></button>
        </form>)}
    <Link className="text-button" to={otherMode}>{mode === 'email' ? '비밀번호 찾기' : '아이디 찾기'}로 전환</Link>
    <Link className="button button--ink" to={loginTo}>로그인으로 돌아가기</Link>
  </div></main>
}

function formatVisitDate(value: string | null | undefined) {
  if (!value) return '정보 없음'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '정보 없음'
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function AccountPage({ session, items, onLogout }: AccountProps) {
  const [confirm, setConfirm] = useState(false)
  const navigate = useNavigate()
  const { user, updateProfile, deleteAccount } = useAuth()
  const [nickname, setNickname] = useState('')
  const [profileImage, setProfileImage] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileSaved, setProfileSaved] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    setNickname(user.nickname)
    setProfileImage(user.profileImage)
  }, [user?.id])

  if (!session) return <AuthGate returnTo="/account" />
  const provider = user?.provider === 'kakao' ? '카카오 계정' : '이메일 계정'

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProfileError(''); setProfileSaved(false)
    const trimmed = nickname.trim()
    if (!trimmed) { setProfileError('닉네임을 입력해 주세요.'); return }
    setProfileBusy(true)
    try {
      await updateProfile(trimmed, profileImage)
      setProfileSaved(true)
    } catch (reason) {
      setProfileError(messageFromError(reason))
    } finally {
      setProfileBusy(false)
    }
  }

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { setProfileError('이미지 파일을 선택해 주세요.'); return }
    if (file.size > 8 * 1024 * 1024) { setProfileError('8MB 이하 이미지를 선택해 주세요.'); return }
    try {
      setProfileImage(await fileToDataUrl(file))
      setProfileError(''); setProfileSaved(false)
    } catch (reason) {
      setProfileError(messageFromError(reason))
    }
  }

  async function confirmDelete() {
    if (deleteConfirmation !== ACCOUNT_DELETE_CONFIRMATION) return
    setDeleteBusy(true); setDeleteError('')
    try {
      await deleteAccount(ACCOUNT_DELETE_CONFIRMATION)
      setDeleteOpen(false)
      navigate('/')
    } catch (reason) {
      setDeleteError(messageFromError(reason))
    } finally {
      setDeleteBusy(false)
    }
  }

  return <main id="main-content" className="content-workspace">
    <PageHeading title="내 계정" />
    <DemoNotice>{provider}으로 로그인했어요. 등록한 사진과 검색 기록은 이 계정에 저장돼요.</DemoNotice>

    <section className="settings-group"><h2>프로필</h2>
      <form className="account-profile" onSubmit={event => { void saveProfile(event) }}>
        <div className="account-profile__media">
          <div className="account-avatar" aria-hidden="true">
            {profileImage ? <img src={profileImage} alt="" /> : <span>{(nickname || '?').slice(0, 1)}</span>}
          </div>
          <div className="account-profile__media-actions">
            <span className="account-profile__label">프로필 이미지</span>
            <label className="button button--secondary account-profile__choose" htmlFor="account-image">
              <Camera aria-hidden="true" />사진 선택
              <input id="account-image" className="visually-hidden" type="file" accept="image/*" aria-describedby="account-image-help" onChange={event => { void chooseImage(event) }} />
            </label>
            <p id="account-image-help" className="field__help">8MB 이하 이미지를 선택해 주세요. 카카오 프로필 사진이 기본으로 표시돼요.</p>
          </div>
        </div>
        <div className="account-profile__fields">
          <div className="field"><label htmlFor="account-nickname">닉네임</label>
            <input id="account-nickname" type="text" value={nickname} maxLength={20} required onChange={event => { setNickname(event.target.value); setProfileSaved(false) }} />
            <p className="field__help">서비스에서 표시될 이름이에요.</p>
          </div>
          <div className="button-row">
            <button className="button button--primary" type="submit" disabled={profileBusy}>저장</button>
            {profileImage && <button type="button" className="button button--secondary" disabled={profileBusy} onClick={() => { setProfileImage(''); setProfileSaved(false) }}>이미지 제거</button>}
          </div>
          {profileError && <p className="inline-error" role="alert">{profileError}</p>}
          {profileSaved && <p className="field__help" role="status">프로필을 저장했어요.</p>}
        </div>
      </form>
    </section>

    <section className="settings-group"><h2>계정 정보</h2>
      <dl className="detail-facts">
        <div><dt>로그인 방식</dt><dd>{provider}</dd></div>
        <div><dt>이메일</dt><dd>{user?.email || '이메일 정보 없음'}</dd></div>
        <div><dt>회원가입일</dt><dd>{formatVisitDate(user?.createdAt)}</dd></div>
        <div><dt>최신 방문일</dt><dd>{formatVisitDate(user?.lastVisitAt)}</dd></div>
      </dl>
    </section>

    <section className="settings-group"><h2>사진 등록해 두기</h2><div className="settings-row"><div><strong>계정에 저장된 항목 {items.length}개</strong><p>로그인한 계정에서 다시 확인할 수 있어요.</p></div><Link className="button button--secondary" to="/valuables">목록 보기<ArrowRight aria-hidden="true" /></Link></div></section>

    <section className="settings-group"><h2>계정</h2><div className="settings-row"><div><strong>{user?.nickname ?? provider}</strong><p>{user?.email || '이메일 정보 없음'} · 사진과 검색 기록은 계정에 저장돼요.</p></div><button className="button button--secondary" onClick={() => setConfirm(true)}><LogOut aria-hidden="true" />로그아웃</button></div></section>

    <section className="settings-group danger-zone"><h2>위험 구역</h2>
      <div className="settings-row"><div><strong>계정 탈퇴</strong><p>회원 탈퇴하면 이 계정을 복구할 수 없어요. 검색 기록과 등록한 소중한 물건 사진이 웹에서 모두 삭제됩니다. 기기에 있는 원본 사진은 삭제되지 않아요.</p></div></div>
      <label className="field history-delete-confirmation" htmlFor="account-delete-confirmation"><span>탈퇴하려면 ‘{ACCOUNT_DELETE_CONFIRMATION}’를 입력해 주세요.</span>
        <input id="account-delete-confirmation" autoComplete="off" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} />
      </label>
      <div className="button-row"><button type="button" className="button button--danger" disabled={deleteConfirmation !== ACCOUNT_DELETE_CONFIRMATION || deleteBusy} onClick={() => { setDeleteError(''); setDeleteOpen(true) }}><Trash2 aria-hidden="true" />탈퇴</button></div>
      {deleteError && <p className="inline-error" role="alert">{deleteError}</p>}
    </section>

    <Modal open={confirm} title="로그아웃할까요?" focusKey="logout" onClose={() => setConfirm(false)}><p>계정에 저장된 내용은 그대로 남아요. 기기 원본과 갤러리 연결은 유지해요.</p><div className="button-row"><button className="button button--secondary" onClick={() => setConfirm(false)}>취소</button><button className="button button--primary" onClick={() => { onLogout(); setConfirm(false); navigate('/') }}>로그아웃</button></div></Modal>
    <Modal open={deleteOpen} title="정말 계정을 탈퇴할까요?" focusKey="account-delete" onClose={() => setDeleteOpen(false)} footer={<div className="button-row"><button className="button button--secondary" onClick={() => setDeleteOpen(false)}>취소</button><button className="button button--danger" disabled={deleteBusy} onClick={() => { void confirmDelete() }}>탈퇴</button></div>}><p>검색 기록과 계정에 저장한 소중한 물건 사진이 모두 삭제돼요. 이 작업은 되돌릴 수 없어요.</p></Modal>
  </main>
}

export function SettingsPage({ gallery, session, onOpenGallery, onDisconnect }: { gallery: GallerySource | null; session: boolean; onOpenGallery: () => void; onDisconnect: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return <main id="main-content" className="content-workspace"><PageHeading title="설정" />
    <section className="settings-group"><h2>갤러리</h2><div className="settings-row"><div><strong>{gallery ? gallery.name + ' · ' + gallery.files.length + '장' : '연결한 갤러리 없음'}</strong><p>기기의 원본은 그대로 유지해요.</p></div><button className="button button--secondary" onClick={onOpenGallery}>{gallery ? '갤러리 관리' : '갤러리 연결'}</button></div>
      <div className="settings-row"><div><strong>검색정보</strong><p>현재 체험에서는 검색 인덱스를 저장하지 않아요.</p></div><span className="status-badge">미생성</span></div>
      {gallery && <div className="settings-row"><div><strong>갤러리 연결 해제</strong><p>원본 사진을 삭제하지 않아요.</p></div><button className="button button--secondary" onClick={() => setConfirm(true)}>연결 해제</button></div>}</section>
    <section className="settings-group"><h2>계정과 데이터</h2><div className="settings-row"><div><strong>소중한 물건 사진 보관함</strong><p>{session ? '계정에 저장된 항목이에요.' : '로그인하면 계정에 저장된 사진을 관리해요.'}</p></div><Link className="button button--secondary" to={session ? '/account' : '/auth/login?returnTo=%2Faccount'}>{session ? '계정 보기' : '로그인'}</Link></div><div className="settings-row"><div><strong>사진 처리</strong></div><Link className="button button--secondary" to="/privacy">범위 확인</Link></div></section>
    <Modal open={confirm} title="갤러리 연결을 해제할까요?" focusKey="disconnect" onClose={() => setConfirm(false)}><p>연결 정보와 갤러리 검색 기록을 지워요. 기기의 원본은 삭제하지 않아요.</p><div className="button-row"><button className="button button--secondary" onClick={() => setConfirm(false)}>취소</button><button className="button button--primary" onClick={() => { onDisconnect(); setConfirm(false) }}>연결 해제</button></div></Modal>
  </main>
}

export function InfoPage({ page }: { page: 'privacy' | 'about' }) {
  return <main id="main-content" className="content-workspace"><PageHeading title={page === 'privacy' ? '사진 처리 안내' : '화면 체험 안내'} back={{ to: '/', label: '검색으로' }} />
    {page === 'privacy' ? <><DemoNotice>검색 입력은 브라우저에서 처리하고, 등록한 사진과 검색 기록은 로그인한 계정에 저장해요.</DemoNotice><section className="settings-group"><h2>현재 저장 범위</h2><dl className="detail-facts"><div><dt>검색 입력·미리보기</dt><dd>이 브라우저에서만 처리</dd></div><div><dt>찾은 기록·등록 항목</dt><dd>로그인한 계정에 저장</dd></div><div><dt>기기 원본</dt><dd>변경·삭제하지 않음</dd></div></dl></section>
      <section className="settings-group"><h2>계정 탈퇴 시</h2><dl className="detail-facts"><div><dt>삭제 범위</dt><dd>계정의 검색 기록과 등록한 사진</dd></div><div><dt>남는 항목</dt><dd>기기에 있는 원본 사진</dd></div></dl><p className="field__help">갤러리 전체를 계정에 자동 등록하지 않아요. 등록한 자료는 목록·상세에서 확인하고 삭제해요.</p></section></>
      : <><DemoNotice>화면 체험용 안내예요. 실제 서비스와 다를 수 있어요.</DemoNotice><section className="settings-group"><h2>지금 해볼 수 있어요</h2><div className="settings-row"><div><strong>사진·입력·화면 이동</strong><p>샘플 후보와 임시 물건을 둘러보세요.</p></div><Link className="button button--secondary" to="/preview">화면 목록</Link></div></section>
        <section className="settings-group"><h2>공식 데이터 출처</h2><p className="field__help">아래 공개 정보의 응답과 사진 제공 여부는 달라질 수 있어요.</p><div className="source-links"><a href="https://www.data.go.kr/data/15058696/openapi.do" target="_blank" rel="noreferrer">경찰청_습득물정보 조회 서비스<ArrowRight aria-hidden="true" /></a><a href="https://www.data.go.kr/data/15057670/openapi.do" target="_blank" rel="noreferrer">경찰청_포털기관 습득물정보 조회 서비스<ArrowRight aria-hidden="true" /></a><a href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">경찰민원24 습득물 검색 안내<ArrowRight aria-hidden="true" /></a></div></section></>}
  </main>
}

export function PreviewIndex() {
  const groups = [
    { title: '검색', links: [['홈', '/'], ['갤러리 입력', '/gallery'], ['분실물 입력', '/lost-found'], ['갤러리 결과', '/gallery/results'], ['찾은 기록', '/history']] },
    { title: '분실물 후보', links: [['두 검색 결과', '/lost-found/results'], ['사진 전체 보기', '/lost-found/results/image'], ['설명·조건 전체 보기', '/lost-found/results/context'], ['후보 상세', '/lost-found/item/demo/demo-01'], ['사진 없는 후보', '/lost-found/item/demo/demo-08']] },
    { title: '사진 등록해 두기', links: [['물건 목록·로그인', '/valuables'], ['물건 등록', '/valuables/new'], ['임시 물건 상세', '/valuables/sample-v1'], ['수정', '/valuables/sample-v1/edit'], ['로그인', '/auth/login'], ['회원가입', '/auth/signup'], ['아이디 찾기', '/auth/find?mode=email'], ['비밀번호 찾기', '/auth/find?mode=password'], ['계정', '/account'], ['설정', '/settings'], ['사진 처리', '/privacy']] },
    { title: '검색 상태', links: [['전체 빈 결과', '/lost-found/results?state=empty'], ['이미지 0·설명 정상', '/lost-found/results?state=image-empty'], ['이미지 오류·설명 정상', '/lost-found/results?state=image-error'], ['설명 오류·이미지 정상', '/lost-found/results?state=context-error'], ['전체 오류', '/lost-found/results?state=error'], ['로딩', '/lost-found/results?state=loading'], ['사진 해석 실패', '/lost-found/results?state=interpretation-error'], ['동의 필요', '/lost-found/results?state=consent-required'], ['기록 변경', '/lost-found/results?state=stale']] },
    { title: '위치 상태', links: ['verified', 'address_only', 'ambiguous', 'missing', 'provider_error'].map(state => [state, '/lost-found/item/demo/demo-01?location=' + state]) },
    { title: '갤러리·등록 상태', links: [['권한 거부', '/gallery/results?state=permission'], ['폴더 미지원', '/gallery/results?state=unsupported'], ['검색 준비', '/gallery/results?state=indexing'], ['원본 접근 실패', '/gallery/photo/sample-wallet?state=missing'], ['원본 저장 중', '/valuables/new?state=original-saving'], ['검색정보 처리 중', '/valuables/new?state=vector-saving'], ['원본 저장 실패', '/valuables/new?state=original-error'], ['검색정보 처리 실패', '/valuables/new?state=vector-error'], ['완료 상태 예시', '/valuables/new?state=complete']] },
  ]
  return <main id="main-content" className="content-workspace"><PageHeading title="화면 미리보기" description="모든 화면과 주요 상태를 확인해요." /><DemoNotice>상태 예시는 실제 처리·검색·저장 결과가 아니에요.</DemoNotice><div className="preview-groups">{groups.map(group => <section className="settings-group" key={group.title}><h2>{group.title}</h2><div className="preview-links">{group.links.map(([label, to]) => <Link key={to} to={to}>{label}<ArrowRight aria-hidden="true" /></Link>)}</div></section>)}</div></main>
}

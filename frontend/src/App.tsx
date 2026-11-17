import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, FolderOpen, Images, Menu, ShieldCheck } from 'lucide-react'
import Modal from './components/Modal'
import SearchComposer from './features/search/SearchComposer'
import GalleryPreview from './features/search/GalleryPreview'
import GalleryConnection from './features/search/GalleryConnection'
import { createSearchRecord, disconnectGalleryHistory, overwriteGallerySearch, recordPath, refineGalleryRecord, removeSearchRecord, resolveGalleryAssistant, updateSearchAssistant, type SearchRecord } from './features/search/history'
import type { GalleryAssistantState } from './features/search/gallery-search-model'
import { copy } from './features/search/copy'
import { appendGallery, collectGallery, getReferencePhotos, MAX_LOST_REFERENCE_PHOTOS, snapshotSearchDraft, validateSearch, type GallerySource, type SearchDraft, type SearchMode } from './features/search/model'
import { prepareGallerySelection } from './features/search/gallery-deduplication'
import type { GalleryImportResult } from './features/search/useGalleryImport'
import WorkspaceRouter from './features/workspace/WorkspaceRouter'
import { initialValuables, localPhotoId, type AppPhoto, type Valuable } from './features/workspace/data'
import './styles/pages.css'

const modePaths = { gallery: '/gallery', lost: '/lost-found' } as const
type Overlay = 'menu' | 'disconnect' | null

export default function App() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const mode: SearchMode = pathname.startsWith('/lost-found') ? 'lost' : 'gallery'
  const isHome = pathname === '/'
  const isInputPage = ['/', '/gallery', '/lost-found'].includes(pathname)
  const [drafts, setDrafts] = useState<Record<SearchMode, SearchDraft>>({ gallery: { query: '', photo: null }, lost: { query: '', photo: null } })
  const [errors, setErrors] = useState<Record<SearchMode, string>>({ gallery: '', lost: '' })
  const [gallery, setGallery] = useState<GallerySource | null>(null)
  const [records, setRecords] = useState<SearchRecord[]>([])
  const [galleryError, setGalleryError] = useState('')
  const [showGalleryManager, setShowGalleryManager] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [announcement, setAnnouncement] = useState('')
  const [session, setSession] = useState(false)
  const [items, setItems] = useState<Valuable[]>(initialValuables)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const draft = drafts[mode]
  const error = errors[mode]
  const needsGallery = mode === 'gallery' && (!gallery || showGalleryManager)

  useEffect(() => {
    if (isInputPage) document.title = isHome ? '그거어디? — 내 사진 · 내 물건 찾기' : copy[mode].name + ' — 그거어디?'
    window.scrollTo(0, 0)
  }, [mode, isHome, isInputPage, pathname])

  function changeDraft(patch: Partial<SearchDraft>) {
    setDrafts(previous => {
      const next = { ...previous[mode], ...patch }
      if (mode === 'gallery') return { ...previous, gallery: next }
      const photos = patch.photos !== undefined ? [...patch.photos]
        : Object.hasOwn(patch, 'photo') ? patch.photo ? [patch.photo] : []
          : [...getReferencePhotos(previous.lost)]
      return { ...previous, lost: { ...next, photo: photos[0] ?? null, photos } }
    })
    setErrors(previous => ({ ...previous, [mode]: '' })); setAnnouncement('')
  }

  function changeMode(next: SearchMode) { navigate(modePaths[next]); setAnnouncement('') }
  function handleModeKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'gallery' : event.key === 'End' ? 'lost' : mode === 'gallery' ? 'lost' : 'gallery'
    changeMode(next); requestAnimationFrame(() => document.getElementById('mode-' + next)?.focus())
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const problem = validateSearch(mode, draft, gallery)
    if (problem) {
      setErrors(previous => ({ ...previous, [mode]: problem === 'empty' ? copy.emptyInput : problem === 'too-many-photos' ? '참고 사진은 ' + MAX_LOST_REFERENCE_PHOTOS + '장까지 추가할 수 있어요.' : copy.missingGallery }))
      if (problem === 'gallery') openGallery(); else textarea.current?.focus()
      return
    }
    const record = createSearchRecord(mode, draft, gallery)
    setRecords(previous => [record, ...previous])
    navigate(recordPath(record))
  }

  function openGallery() { setGalleryError(''); setShowGalleryManager(true); navigate('/gallery') }
  function refineGallerySearch(parent: SearchRecord, assistant: GalleryAssistantState) {
    const base = resolveGalleryAssistant(records, parent).baseQuery
    const next = refineGalleryRecord({ ...parent, assistantBaseQuery: base }, assistant)
    if (!next) return
    setRecords(previous => [next, ...previous])
    setDrafts(previous => ({ ...previous, gallery: snapshotSearchDraft('gallery', next.draft) }))
    navigate(recordPath(next))
  }
  function commitGallerySearch(id: string | null, nextDraft: SearchDraft) {
    if (id) setRecords(previous => overwriteGallerySearch(previous, id, nextDraft))
    setDrafts(previous => ({ ...previous, gallery: snapshotSearchDraft('gallery', nextDraft) }))
  }
  function returnFromGallery() {
    setShowGalleryManager(false)
    setGalleryError('')
    navigate(-1)
  }
  async function connectGallery(files: readonly File[], signal: AbortSignal): Promise<GalleryImportResult> {
    const selection = await prepareGallerySelection([], files, signal)
    signal.throwIfAborted()
    const source = collectGallery(selection.files)
    if (!source) return { added: 0, duplicateCount: selection.duplicateCount, error: '선택한 항목에서 이미지를 찾지 못했어요. 다른 사진이나 폴더를 골라 주세요.' }
    setGalleryError(''); setGallery(source); setErrors(previous => ({ ...previous, gallery: '' }))
    setAnnouncement(source.files.length.toLocaleString('ko-KR') + '장의 이미지를 연결했어요.' + (selection.duplicateCount ? ' 중복 ' + selection.duplicateCount.toLocaleString('ko-KR') + '장은 건너뛰었어요.' : '')); setShowGalleryManager(false)
    requestAnimationFrame(() => textarea.current?.focus())
    return { added: source.files.length, duplicateCount: selection.duplicateCount }
  }

  async function addGallery(files: readonly File[], signal: AbortSignal): Promise<GalleryImportResult> {
    const selection = await prepareGallerySelection(gallery?.files ?? [], files, signal)
    signal.throwIfAborted()
    if (!selection.imageCount) return { added: 0, duplicateCount: 0, error: '선택한 항목에서 이미지를 찾지 못했어요. 다른 사진이나 폴더를 골라 주세요.' }
    if (!selection.files.length) return { added: 0, duplicateCount: selection.duplicateCount }
    setGallery(previous => appendGallery(previous, selection.files))
    setAnnouncement(selection.files.length.toLocaleString('ko-KR') + '장의 이미지를 추가했어요.' + (selection.duplicateCount ? ' 중복 ' + selection.duplicateCount.toLocaleString('ko-KR') + '장은 건너뛰었어요.' : ''))
    requestAnimationFrame(() => textarea.current?.focus())
    return { added: selection.files.length, duplicateCount: selection.duplicateCount }
  }

  function disconnectGallery() {
    setGallery(null); setRecords(disconnectGalleryHistory); setShowGalleryManager(false)
    setGalleryError(''); setOverlay(null)
    setAnnouncement('갤러리 연결과 갤러리 검색 기록을 지웠어요. 원본은 그대로예요.')
    requestAnimationFrame(() => document.getElementById('gallery-connect-heading')?.focus())
  }

  async function transferPhoto(photo: AppPhoto) {
    let file = photo.file
    if (!file && photo.sampleUrl?.startsWith('/images/')) {
      const response = await fetch(photo.sampleUrl)
      if (!response.ok) throw new Error('sample unavailable')
      const blob = await response.blob(); file = new File([blob], photo.name + '.jpg', { type: blob.type })
    }
    if (!file) throw new Error('photo unavailable')
    setDrafts(previous => ({ ...previous, lost: { query: '', photo: file, photos: [file] } })); setErrors(previous => ({ ...previous, lost: '' }))
    setAnnouncement('선택한 사진 한 장을 참고 사진으로 추가했어요.'); navigate('/lost-found')
  }

  const utilityNavigation = <><NavLink to="/history" onClick={() => setOverlay(null)}>찾은 기록</NavLink><NavLink to="/valuables" onClick={() => setOverlay(null)}>소중한 것들</NavLink><NavLink to="/settings" onClick={() => setOverlay(null)}>설정</NavLink></>
  return <div className={'app-shell' + (isInputPage ? '' : ' app-shell--content')}><a className="skip-link" href="#main-content">본문으로 바로 가기</a>
    <header className="site-header"><div className="site-header__inner"><Link className="brand" to="/" aria-label="그거어디? 홈"><span>그거어디<span className="brand__question">?</span></span></Link><span className="brand-description">내 사진 · 내 물건 찾기</span>
      <nav className="desktop-nav" aria-label="주 메뉴">{utilityNavigation}</nav><div className="header-actions"><Link className="login-link" to={session ? '/account' : '/auth/login'}>{session ? '체험 계정' : '로그인'}</Link><button type="button" className="icon-button menu-toggle" aria-label="메뉴 열기" aria-haspopup="dialog" onClick={() => setOverlay('menu')}><Menu /></button></div></div></header>
    {isInputPage && <nav className="mode-bar" aria-label="검색 기능"><div className="mode-bar__inner"><div className="mode-tabs" role="tablist" aria-label="검색 방식 선택" onKeyDown={handleModeKeys}>
      {(['gallery', 'lost'] as const).map(item => <button type="button" key={item} id={'mode-' + item} role="tab" aria-selected={mode === item} aria-controls={isInputPage ? 'search-panel' : 'main-content'} tabIndex={mode === item ? 0 : -1} onClick={() => changeMode(item)}>{item === 'gallery' ? <Images aria-hidden="true" /> : <SearchModeIcon />}<span className="mode-label">{copy[item].name}</span></button>)}
    </div></div></nav>}
    {isInputPage ? <main id="main-content" className="search-workspace"><section className="search-area" aria-labelledby="page-heading"><div className="page-intro"><h1 id="page-heading">{isHome ? '그거 어디 있지?' : needsGallery ? '갤러리에서 사진 찾기' : copy[mode].title}</h1><p>{needsGallery ? '사진을 연결한 다음, 글이나 참고 사진으로 찾아보세요.' : copy[mode].description}</p></div>
      <div id="search-panel" role="tabpanel" aria-labelledby={'mode-' + mode}>{needsGallery ? <GalleryConnection gallery={gallery} error={galleryError} onConnect={connectGallery} onCancel={returnFromGallery} onDisconnect={() => setOverlay('disconnect')} /> : <>
        <div className="search-scope"><div className="gallery-scope__header"><div className="search-scope__text"><strong>{mode === 'gallery' ? '연결한 갤러리 전체' : '경찰청 공개 습득물 정보'}</strong>{mode === 'gallery' && gallery && <small>{gallery.name} · {gallery.files.length.toLocaleString('ko-KR')}장</small>}</div>
          {mode === 'gallery' && <div className="gallery-scope__actions"><button type="button" className="scope-action" onClick={openGallery}><FolderOpen aria-hidden="true" /><span>갤러리 관리</span><ChevronRight aria-hidden="true" /></button><button type="button" className="scope-action scope-action--quiet" onClick={() => setOverlay('disconnect')}>갤러리 해제</button></div>}
        </div>{mode === 'gallery' && <GalleryPreview key={gallery?.files[0] ? localPhotoId(gallery.files[0]) : 'disconnected'} gallery={gallery} onAdd={addGallery} />}</div>
        <SearchComposer mode={mode} draft={draft} textareaRef={textarea} error={error} onDraft={changeDraft} onSubmit={submit} onError={message => setErrors(previous => ({ ...previous, [mode]: message }))} />
        {error && <p id="search-error" role="alert" className="form-error">{error}</p>}<div className="search-notes">{mode === 'gallery' ? <p className="scope-note"><ShieldCheck aria-hidden="true" /><span>원본은 기기에 그대로 있어요. {copy.aiNotice}</span></p> : <p>{copy.aiNotice} {copy.publicLimit}</p>}<p className="preview-disclosure">프론트엔드 체험 · AI 검색 미연결</p></div></>}
      </div><p className="announcement" role="status" aria-live="polite">{announcement}</p></section></main>
      : <WorkspaceRouter gallery={gallery} drafts={drafts} records={records} onDeleteRecord={id => setRecords(previous => removeSearchRecord(previous, id))} onEditRecord={record => { setDrafts(previous => ({ ...previous, [record.mode]: snapshotSearchDraft(record.mode, record.draft) })); navigate(modePaths[record.mode]) }} session={session} items={items} onOpenGallery={openGallery} onAddGallery={addGallery} onDisconnect={disconnectGallery}
        onAssistantChange={(id, patch) => setRecords(previous => updateSearchAssistant(previous, id, patch))} onRefineRecord={refineGallerySearch}
        onCommitGallerySearch={commitGallerySearch}
        onDemoLogin={() => setSession(true)} onLogout={() => { setSession(false); setItems(initialValuables) }} onSave={item => setItems(previous => previous.some(value => value.id === item.id) ? previous.map(value => value.id === item.id ? item : value) : [...previous, item])}
        onDelete={id => setItems(previous => previous.filter(value => value.id !== id))} onTransfer={transferPhoto} />}
    <footer className="site-footer"><p>그거어디? <span>내 사진 · 내 물건 찾기</span></p><div><Link to="/privacy">사진 처리 안내</Link></div></footer>
    <Modal open={overlay !== null} focusKey={overlay ?? ''} title={overlay === 'disconnect' ? '갤러리 연결을 해제할까요?' : '메뉴'} onClose={() => setOverlay(null)}>
      {overlay === 'menu' && <nav className="mobile-nav" aria-label="모바일 주 메뉴"><NavLink to="/gallery" onClick={() => setOverlay(null)}>{copy.gallery.name}</NavLink><NavLink to="/lost-found" onClick={() => setOverlay(null)}>{copy.lost.name}</NavLink>{utilityNavigation}</nav>}
      {overlay === 'disconnect' && <><p>연결 정보와 갤러리 검색 기록을 지워요. 기기의 원본은 삭제하지 않아요.</p><div className="button-row"><button type="button" className="button button--secondary" onClick={() => setOverlay(null)}>취소</button><button type="button" className="button button--primary" onClick={disconnectGallery}>갤러리 해제</button></div></>}
    </Modal>
  </div>
}

function SearchModeIcon() { return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 2.5H3v3M14 2.5h3v3M17 14.5v3h-3M6 17.5H3v-3" /><circle cx="9" cy="9" r="3.5" /><path d="m11.5 11.5 3 3" /></svg> }

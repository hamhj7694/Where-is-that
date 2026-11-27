import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, FolderOpen, Images, Menu, ShieldCheck } from 'lucide-react'
import Modal from './components/Modal'
import { fetchContent, saveContent } from './features/account/api'
import { deserializeContent, serializeContent } from './features/account/content'
import SearchComposer from './features/search/SearchComposer'
import GalleryPreview from './features/search/GalleryPreview'
import GalleryConnection from './features/search/GalleryConnection'
import { clearGalleryRankSnapshot, clearLostResultsSnapshot, createSearchRecord, disconnectGalleryHistory, overwriteGallerySearch, overwriteLostSearch, recordPath, refineGalleryRecord, refineLostRecord, removeSearchRecord, resolveGalleryAssistant, resolveLostAssistant, updateSearchAssistant, type SearchRecord } from './features/search/history'
import useGuestHistory from './features/search/useGuestHistory'
import type { GalleryAssistantState } from './features/search/gallery-search-model'
import { copy } from './features/search/copy'
import { appendGallery, collectGallery, getReferencePhotos, getReferencePhotoViews, isImageFile, MAX_LOST_REFERENCE_PHOTOS, snapshotSearchDraft, validateSearch, type GallerySource, type ReferencePhotoView, type SearchDraft, type SearchMode } from './features/search/model'
import { loadGallery, saveGallery } from './features/search/gallery-store'
import { prepareGallerySelection } from './features/search/gallery-deduplication'
import type { GalleryImportOptions, GalleryImportResult } from './features/search/useGalleryImport'
import { prepareFileLocations, rememberFileLocations, rememberNativeFileLocations, type FileLocationAssignment } from './features/search/file-location-model'
import { flushPendingBookmarks } from './features/workspace/bookmarks'
import WorkspaceRouter from './features/workspace/WorkspaceRouter'
import { useAuth } from './features/auth/AuthContext'
import { initialValuables, localPhotoId, type AppPhoto, type Valuable } from './features/workspace/data'
import './styles/pages.css'

const modePaths = { gallery: '/gallery', lost: '/lost-found' } as const
const LAST_SEARCH_PATH_KEY = 'geugeo-eodi:last-search-path'
const LAST_DIRECT_SEARCH_PATH_KEY = 'geugeo-eodi:last-direct-search-path'
type Overlay = 'menu' | 'disconnect' | null
type AccountSnapshot = { userId: number; items: Valuable[]; records: SearchRecord[] }

function readLastSearchPath(): '/gallery' | '/lost-found' {
  try { return window.localStorage.getItem(LAST_SEARCH_PATH_KEY) === '/lost-found' ? '/lost-found' : '/gallery' } catch { return '/gallery' }
}

function readLastDirectSearchPath(): string {
  try {
    const value = window.localStorage.getItem(LAST_DIRECT_SEARCH_PATH_KEY)
    return value && value.startsWith('/direct-search') ? value : '/direct-search'
  } catch { return '/direct-search' }
}

export default function App() {
  const { pathname, search, key: locationKey } = useLocation()
  const navigate = useNavigate()
  const mode: SearchMode = pathname.startsWith('/lost-found') ? 'lost' : 'gallery'
  const [lastSearchPath, setLastSearchPath] = useState<'/gallery' | '/lost-found'>(readLastSearchPath)
  const [lastDirectSearchPath, setLastDirectSearchPath] = useState(readLastDirectSearchPath)
  const isHome = pathname === '/'
  const isInputPage = ['/', '/gallery', '/lost-found'].includes(pathname)
  // 상세 페이지가 직접 찾기에서 열렸으면 헤더도 직접 찾기 흐름으로 표시한다.
  const fromDirectSearch = new URLSearchParams(search).get('back')?.startsWith('/direct-search') ?? false
  const [drafts, setDrafts] = useState<Record<SearchMode, SearchDraft>>({ gallery: { query: '', photo: null }, lost: { query: '', photo: null } })
  const [errors, setErrors] = useState<Record<SearchMode, string>>({ gallery: '', lost: '' })
  const [gallery, setGallery] = useState<GallerySource | null>(null)
  const [galleryRestored, setGalleryRestored] = useState(false)
  const galleryRef = useRef<GallerySource | null>(null)
  const guestHistory = useGuestHistory()
  const [accountRecords, setAccountRecords] = useState<SearchRecord[]>([])
  const searchSubmitted = useRef(false)
  const [autoRankRecordId, setAutoRankRecordId] = useState<string | null>(null)
  const [galleryRankSeed, setGalleryRankSeed] = useState(0)
  const [galleryError, setGalleryError] = useState('')
  const [showGalleryManager, setShowGalleryManager] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [announcement, setAnnouncement] = useState('')
  const { user, authenticated: session, ready, signOut } = useAuth()
  const [items, setItems] = useState<Valuable[]>(initialValuables)
  const [contentError, setContentError] = useState('')
  const [accountLoadError, setAccountLoadError] = useState('')
  const [accountLoadAttempt, setAccountLoadAttempt] = useState(0)
  const itemsRef = useRef(items)
  const recordsRef = useRef(accountRecords)
  const loadedAccount = useRef<AccountSnapshot | null>(null)
  const accountWrites = useRef(Promise.resolve())
  const [settledUserId, setSettledUserId] = useState<number | null>(null)
  const accountReady = !!user && loadedAccount.current?.userId === user.id
  const accountLoading = !!user && settledUserId !== user.id
  const historyReady = ready && guestHistory.ready && !accountLoading
  const records = accountReady
    ? [...guestHistory.records, ...accountRecords].sort((a, b) => b.createdAt - a.createdAt)
    : guestHistory.records
  const addRecord = accountReady ? setAccountRecords : guestHistory.setRecords
  const textarea = useRef<HTMLTextAreaElement>(null)
  const draft = drafts[mode]
  const error = errors[mode]
  const needsGallery = mode === 'gallery' && (!gallery || showGalleryManager)

  useEffect(() => {
    if (isInputPage) document.title = isHome ? '그거어디? — 내 사진 · 내 물건 찾기' : copy[mode].name + ' — 그거어디?'
    window.scrollTo(0, 0)
  }, [mode, isHome, isInputPage, pathname])

  useEffect(() => { searchSubmitted.current = false }, [locationKey])

  // 해제 예정으로 남아 있던 북마크는 페이지를 떠날 때 정리한다.
  useEffect(() => { flushPendingBookmarks() }, [pathname, search])

  useEffect(() => {
    const next = pathname.startsWith('/lost-found') ? '/lost-found' : pathname.startsWith('/gallery') ? '/gallery' : null
    if (!next || next === lastSearchPath) return
    setLastSearchPath(next)
    try { window.localStorage.setItem(LAST_SEARCH_PATH_KEY, next) } catch { /* Storage is optional; in-memory state still works. */ }
  }, [pathname, lastSearchPath])

  // 직접 찾기의 페이지·검색 조건을 기억해 헤더로 다시 들어와도 유지한다.
  useEffect(() => {
    if (pathname !== '/direct-search') return
    const next = pathname + search
    if (next === lastDirectSearchPath) return
    setLastDirectSearchPath(next)
    try { window.localStorage.setItem(LAST_DIRECT_SEARCH_PATH_KEY, next) } catch { /* Storage is optional. */ }
  }, [pathname, search, lastDirectSearchPath])

  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { recordsRef.current = accountRecords }, [accountRecords])
  useEffect(() => { galleryRef.current = gallery }, [gallery])

  // 연결한 폴더·사진은 브라우저에 보관해 페이지 이동과 새로고침 후에도 되살린다.
  useEffect(() => {
    let active = true
    void loadGallery().then(source => {
      if (!active) return
      if (source && !galleryRef.current) setGallery(source)
      setGalleryRestored(true)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!galleryRestored) return
    void saveGallery(gallery)
  }, [gallery, galleryRestored])

  useEffect(() => {
    if (!ready) return
    if (!user) {
      if (loadedAccount.current || settledUserId !== null) {
        loadedAccount.current = null
        setSettledUserId(null)
        setItems(initialValuables)
        setAccountRecords([])
        setDrafts({ gallery: { query: '', photo: null }, lost: { query: '', photo: null } })
        setErrors({ gallery: '', lost: '' })
        setContentError('')
        setAccountLoadError('')
      }
      return
    }
    let active = true
    loadedAccount.current = null
    setAccountLoadError('')
    void fetchContent().then(account => {
      if (!active) return
      const restored = deserializeContent(account)
      loadedAccount.current = { userId: user.id, items: restored.items, records: restored.records }
      setItems(restored.items)
      setAccountRecords(restored.records)
      // 예전 계정 검색 기록에서도 연결했던 갤러리를 열 수 있다.
      if (!galleryRef.current) {
        const savedGallery = restored.records.find(record => record.gallery)?.gallery
        if (savedGallery) setGallery(savedGallery)
      }
      setContentError('')
    }).catch(reason => {
      if (!active) return
      setAccountLoadError(reason instanceof Error ? reason.message : '계정 내용을 불러오지 못했어요.')
    }).finally(() => { if (active) setSettledUserId(user.id) })
    return () => { active = false }
  }, [ready, user?.id, accountLoadAttempt])

  function retryAccountLoad() {
    setSettledUserId(null)
    setAccountLoadAttempt(attempt => attempt + 1)
  }

  // The account endpoint replaces the entire payload. Send writes in order so
  // search history and view timestamps cannot overwrite an item save.
  function writeAccount(account: AccountSnapshot, updateItems?: (previous: Valuable[]) => Valuable[]) {
    const write = accountWrites.current.then(async () => {
      const checkAccount = () => {
        if (loadedAccount.current !== account) throw new Error('로그인 상태를 다시 확인해 주세요.')
      }
      checkAccount()
      const previous = itemsRef.current
      const recordsToSave = recordsRef.current
      const nextItems = updateItems ? updateItems(previous) : previous
      if (!updateItems && account.items === nextItems && account.records === recordsToSave) return
      const payload = await serializeContent(nextItems, recordsToSave)
      checkAccount()
      await saveContent(payload)
      checkAccount()
      account.items = nextItems
      account.records = recordsToSave
      if (updateItems) {
        const committed = itemsRef.current === previous ? nextItems : updateItems(itemsRef.current)
        itemsRef.current = committed
        setItems(committed)
      }
      setContentError('')
    })
    accountWrites.current = write.catch(() => undefined)
    return write
  }

  async function saveValuables(updateItems: (previous: Valuable[]) => Valuable[]) {
    const account = loadedAccount.current
    if (!user || account?.userId !== user.id) throw new Error('보관함을 다시 불러온 뒤 시도해 주세요.')
    await writeAccount(account, updateItems)
  }

  function saveValuable(item: Valuable) {
    return saveValuables(previous => previous.some(value => value.id === item.id)
      ? previous.map(value => value.id === item.id ? { ...item, viewedAt: value.viewedAt ?? item.viewedAt } : value)
      : [...previous, item])
  }

  useEffect(() => {
    const account = loadedAccount.current
    if (!user || account?.userId !== user.id || (items === account.items && accountRecords === account.records)) return
    let active = true
    const timer = window.setTimeout(() => {
      void writeAccount(account)
        .catch(reason => { if (active) setContentError(reason instanceof Error ? reason.message : '계정에 저장하지 못했어요.') })
    }, 400)
    return () => { active = false; window.clearTimeout(timer) }
  }, [items, accountRecords, user?.id])

  function updateRecord(id: string, update: (previous: SearchRecord[]) => SearchRecord[]) {
    const updateRecords = guestHistory.records.some(record => record.id === id) ? guestHistory.setRecords : setAccountRecords
    updateRecords(update)
  }

  function deleteRecord(id: string) {
    clearGalleryRankSnapshot(id)
    clearLostResultsSnapshot('record:' + id)
    updateRecord(id, previous => removeSearchRecord(previous, id))
  }

  function changeDraft(patch: Partial<SearchDraft>) {
    setDrafts(previous => {
      const next = { ...previous[mode], ...patch }
      if (mode === 'gallery') return { ...previous, gallery: next }
      const previousPhotos = getReferencePhotos(previous.lost)
      const previousViews = getReferencePhotoViews(previous.lost)
      const photos = patch.photos !== undefined ? [...patch.photos]
        : Object.hasOwn(patch, 'photo') ? patch.photo ? [patch.photo] : []
          : [...previousPhotos]
      const views = patch.photoViews !== undefined ? [...patch.photoViews]
        : Object.hasOwn(patch, 'photo') && patch.photos === undefined ? photos.map((): ReferencePhotoView => 'unspecified')
          : patch.photos === undefined ? [...previousViews]
          : photos.map(file => {
            const previousIndex = previousPhotos.indexOf(file)
            return previousIndex < 0 ? 'unspecified' : previousViews[previousIndex]
          })
      const normalized = { ...next, photo: photos[0] ?? null, photos, photoViews: views }
      return { ...previous, lost: { ...normalized, photoViews: getReferencePhotoViews(normalized) } }
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

  function submit(nextDraft: SearchDraft = draft, authorizeContextRank = false) {
    if (searchSubmitted.current) return
    if (!ready || accountLoading) {
      setErrors(previous => ({ ...previous, [mode]: '검색 기록을 불러오고 있어요. 잠시 뒤 다시 검색해 주세요.' }))
      return
    }
    const problem = validateSearch(mode, nextDraft, gallery)
    if (problem) {
      setErrors(previous => ({ ...previous, [mode]: problem === 'empty' ? copy.emptyInput : problem === 'too-many-photos' ? '참고 사진은 ' + MAX_LOST_REFERENCE_PHOTOS + '장까지 추가할 수 있어요.' : copy.missingGallery }))
      if (problem === 'gallery') openGallery(); else textarea.current?.focus()
      return
    }
    const record = createSearchRecord(mode, nextDraft, gallery)
    searchSubmitted.current = true
    addRecord(previous => [record, ...previous])
    setDrafts(previous => ({ ...previous, [mode]: snapshotSearchDraft(mode, nextDraft) }))
    setAutoRankRecordId(mode === 'lost' && authorizeContextRank ? record.id : null)
    if (mode === 'gallery') setGalleryRankSeed(value => value + 1)
    navigate(recordPath(record))
  }

  function openGallery() { setGalleryError(''); setShowGalleryManager(true); navigate('/gallery') }
  function refineGallerySearch(parent: SearchRecord, assistant: GalleryAssistantState) {
    const base = resolveGalleryAssistant(records, parent).baseQuery
    const next = refineGalleryRecord({ ...parent, assistantBaseQuery: base }, assistant)
    if (!next) return
    applyRefinedSearch(next)
  }
  function commitGallerySearch(id: string | null, nextDraft: SearchDraft) {
    if (id) {
      clearGalleryRankSnapshot(id)
      updateRecord(id, previous => overwriteGallerySearch(previous, id, nextDraft))
    }
    setDrafts(previous => ({ ...previous, gallery: snapshotSearchDraft('gallery', nextDraft) }))
    setGalleryRankSeed(value => value + 1)
  }
  function refineLostSearch(parent: SearchRecord, assistant: GalleryAssistantState) {
    const base = resolveLostAssistant(records, parent).baseQuery
    const next = refineLostRecord({ ...parent, assistantBaseQuery: base }, assistant)
    if (!next) return
    applyRefinedSearch(next)
  }
  function applyRefinedSearch(next: SearchRecord) {
    if (next.mode === 'gallery') clearGalleryRankSnapshot(next.id)
    else clearLostResultsSnapshot('record:' + next.id)
    updateRecord(next.id, previous => previous.map(record => record.id === next.id ? next : record))
    setDrafts(previous => ({ ...previous, [next.mode]: snapshotSearchDraft(next.mode, next.draft) }))
    if (next.mode === 'gallery') setGalleryRankSeed(value => value + 1)
    const params = new URLSearchParams(search)
    for (const key of ['page', 'state', 'combinedState', 'imageState', 'contextState']) params.delete(key)
    if (params.toString() !== search.replace(/^\?/, '')) navigate({ pathname, search: params.toString() }, { replace: true })
  }
  function commitLostSearch(id: string | null, nextDraft: SearchDraft, authorizeContextRank = false) {
    let recordId = id
    if (id) {
      clearLostResultsSnapshot('record:' + id)
      updateRecord(id, previous => overwriteLostSearch(previous, id, nextDraft))
    }
    else {
      const next = createSearchRecord('lost', nextDraft, null)
      recordId = next.id
      addRecord(previous => [next, ...previous]); navigate(recordPath(next))
    }
    setDrafts(previous => ({ ...previous, lost: snapshotSearchDraft('lost', nextDraft) }))
    setAutoRankRecordId(authorizeContextRank ? recordId : null)
  }
  function returnFromGallery() {
    setShowGalleryManager(false)
    setGalleryError('')
    navigate(-1)
  }
  function prepareLocations(files: readonly File[], options?: GalleryImportOptions): FileLocationAssignment[] {
    return options?.basePath?.trim() ? prepareFileLocations(files.filter(isImageFile), options.basePath) : []
  }
  async function connectGallery(files: readonly File[], signal: AbortSignal, options?: GalleryImportOptions): Promise<GalleryImportResult> {
    let locations: FileLocationAssignment[]
    try { locations = prepareLocations(files, options) } catch (reason) { return { added: 0, duplicateCount: 0, error: reason instanceof Error ? reason.message : '폴더 경로를 확인해 주세요.' } }
    const selection = await prepareGallerySelection([], files, signal)
    signal.throwIfAborted()
    const source = collectGallery(selection.files)
    if (!source) return { added: 0, duplicateCount: selection.duplicateCount, error: '선택한 항목에서 이미지를 찾지 못했어요. 다른 사진이나 폴더를 골라 주세요.' }
    const connected = new Set(source.files)
    rememberFileLocations(locations.filter(location => connected.has(location.file)))
    rememberNativeFileLocations(options?.nativeLocations?.filter(location => connected.has(location.file)) ?? [])
    setGalleryError(''); setGallery(source); setErrors(previous => ({ ...previous, gallery: '' }))
    setAnnouncement(source.files.length.toLocaleString('ko-KR') + '장의 이미지를 연결했어요.' + (selection.duplicateCount ? ' 중복 ' + selection.duplicateCount.toLocaleString('ko-KR') + '장은 건너뛰었어요.' : '')); setShowGalleryManager(false)
    requestAnimationFrame(() => textarea.current?.focus())
    return { added: source.files.length, duplicateCount: selection.duplicateCount }
  }

  async function addGallery(files: readonly File[], signal: AbortSignal, options?: GalleryImportOptions): Promise<GalleryImportResult> {
    let locations: FileLocationAssignment[]
    try { locations = prepareLocations(files, options) } catch (reason) { return { added: 0, duplicateCount: 0, error: reason instanceof Error ? reason.message : '폴더 경로를 확인해 주세요.' } }
    const selection = await prepareGallerySelection(gallery?.files ?? [], files, signal)
    signal.throwIfAborted()
    if (!selection.imageCount) return { added: 0, duplicateCount: 0, error: '선택한 항목에서 이미지를 찾지 못했어요. 다른 사진이나 폴더를 골라 주세요.' }
    if (!selection.files.length) return { added: 0, duplicateCount: selection.duplicateCount }
    const added = new Set(selection.files)
    rememberFileLocations(locations.filter(location => added.has(location.file)))
    rememberNativeFileLocations(options?.nativeLocations?.filter(location => added.has(location.file)) ?? [])
    setGallery(previous => appendGallery(previous, selection.files))
    setAnnouncement(selection.files.length.toLocaleString('ko-KR') + '장의 이미지를 추가했어요.' + (selection.duplicateCount ? ' 중복 ' + selection.duplicateCount.toLocaleString('ko-KR') + '장은 건너뛰었어요.' : ''))
    requestAnimationFrame(() => textarea.current?.focus())
    return { added: selection.files.length, duplicateCount: selection.duplicateCount }
  }

  function disconnectGallery() {
    for (const record of records) if (record.mode === 'gallery') clearGalleryRankSnapshot(record.id)
    guestHistory.setRecords(disconnectGalleryHistory)
    if (accountReady) setAccountRecords(disconnectGalleryHistory)
    setGallery(null); setShowGalleryManager(false)
    setGalleryError(''); setOverlay(null)
    setAnnouncement('갤러리 연결과 갤러리 검색 기록을 지웠어요. 원본은 그대로예요.')
    requestAnimationFrame(() => document.getElementById('gallery-connect-heading')?.focus())
  }

  async function transferPhoto(photos: readonly AppPhoto[]) {
    const selected = photos.slice(0, MAX_LOST_REFERENCE_PHOTOS)
    if (!selected.length) throw new Error('photo unavailable')
    const files = await Promise.all(selected.map(async photo => {
      let file = photo.file
      if (!file && photo.sampleUrl?.startsWith('/images/')) {
        const response = await fetch(photo.sampleUrl)
        if (!response.ok) throw new Error('sample unavailable')
        const blob = await response.blob(); file = new File([blob], photo.name + '.jpg', { type: blob.type })
      }
      if (!file) throw new Error('photo unavailable')
      return file
    }))
    setDrafts(previous => ({ ...previous, lost: { query: '', photo: files[0], photos: files, photoViews: selected.map(photo => photo.photoView ?? 'unspecified') } })); setErrors(previous => ({ ...previous, lost: '' }))
    setAnnouncement(`선택한 사진 ${files.length}장을 참고 사진으로 추가했어요.`); navigate('/lost-found')
  }

  const utilityNavigation = <><NavLink to="/history" onClick={() => setOverlay(null)}>찾은 기록</NavLink><NavLink to="/valuables" onClick={() => setOverlay(null)}>사진 등록해 두기</NavLink><NavLink to="/settings" onClick={() => setOverlay(null)}>설정</NavLink></>
  return <div className={'app-shell' + (isInputPage ? '' : ' app-shell--content')}><a className="skip-link" href="#main-content">본문으로 바로 가기</a>
    <header className="site-header"><div className="site-header__inner"><Link className="brand" to="/" aria-label="그거어디? 홈"><span>그거어디<span className="brand__question">?</span></span></Link><NavLink className={({ isActive }) => 'brand-description' + (isActive && !fromDirectSearch ? ' active' : '')} to={lastSearchPath} aria-label="내 사진 · 내 물건 찾기 검색으로 이동">내 사진 · 내 물건 찾기</NavLink><NavLink className={({ isActive }) => 'header-direct-link' + (isActive || fromDirectSearch ? ' active' : '')} to={lastDirectSearchPath}>직접 찾기</NavLink>
      <nav className="desktop-nav" aria-label="주 메뉴">{utilityNavigation}</nav><div className="header-actions"><Link className="login-link" to={session ? '/account' : '/auth/login'}>{session ? (user?.nickname ?? '내 계정') : '로그인'}</Link><button type="button" className="icon-button menu-toggle" aria-label="메뉴 열기" aria-haspopup="dialog" onClick={() => setOverlay('menu')}><Menu /></button></div></div></header>
    {isInputPage && <nav className="mode-bar" aria-label="검색 기능"><div className="mode-bar__inner"><div className="mode-tabs" role="tablist" aria-label="검색 방식 선택" onKeyDown={handleModeKeys}>
      {(['gallery', 'lost'] as const).map(item => <button type="button" key={item} id={'mode-' + item} role="tab" aria-selected={mode === item} aria-controls={isInputPage ? 'search-panel' : 'main-content'} tabIndex={mode === item ? 0 : -1} onClick={() => changeMode(item)}>{item === 'gallery' ? <Images aria-hidden="true" /> : <SearchModeIcon />}<span className="mode-label">{copy[item].name}</span></button>)}
    </div></div></nav>}
    {isInputPage ? <main id="main-content" className="search-workspace"><section className="search-area" aria-labelledby="page-heading"><div className="page-intro"><h1 id="page-heading">{needsGallery ? '사진을 연결해 주세요' : copy[mode].title}</h1><p>{needsGallery ? '연결하면 갤러리 전체에서 사진을 찾을 수 있어요.' : copy[mode].description}</p></div>
      <div id="search-panel" role="tabpanel" aria-labelledby={'mode-' + mode}>{needsGallery ? <GalleryConnection gallery={gallery} error={galleryError} onConnect={connectGallery} onCancel={returnFromGallery} onDisconnect={() => setOverlay('disconnect')} /> : <>
        <SearchComposer mode={mode} draft={draft} textareaRef={textarea} error={error} onDraft={changeDraft} onSubmit={submit} onError={message => setErrors(previous => ({ ...previous, [mode]: message }))} />
        {error && <p id="search-error" role="alert" className="form-error">{error}</p>}
        <div className="search-notes"><p className="scope-note"><ShieldCheck aria-hidden="true" /><span>{mode === 'gallery' ? copy.aiNotice : copy.publicLimit}</span></p>
          <details className="privacy-details"><summary>데이터 처리 자세히 보기</summary><p>{mode === 'lost' ? 'AI 검색 요청에 입력한 내용과 참고 사진을 사용해요. 공개된 습득물 기록과 비교해 후보를 보여줘요.' : 'AI 비교 요청에 입력한 내용과 비교할 사진을 사용해요. 기기에 있는 파일은 그대로 유지해요.'}</p></details>
        </div>
        <div className="search-scope"><div className="gallery-scope__header"><div className="search-scope__text"><span className="search-scope__label">검색 대상</span><strong>{mode === 'gallery' ? '연결한 갤러리 전체' : copy.publicScope}</strong>{mode === 'gallery' && gallery && <small>{gallery.name} · {gallery.files.length.toLocaleString('ko-KR')}장</small>}</div>
          {mode === 'gallery' && <div className="gallery-scope__actions"><button type="button" className="scope-action" onClick={openGallery}><FolderOpen aria-hidden="true" /><span>갤러리 관리</span><ChevronRight aria-hidden="true" /></button><button type="button" className="scope-action scope-action--quiet" onClick={() => setOverlay('disconnect')}>갤러리 해제</button></div>}
        </div>{mode === 'gallery' && <GalleryPreview key={gallery?.files[0] ? localPhotoId(gallery.files[0]) : 'disconnected'} gallery={gallery} onAdd={addGallery} />}</div></>}
      </div><p className="announcement" role="status" aria-live="polite">{announcement}</p></section></main>
      : <WorkspaceRouter gallery={gallery} galleryReady={galleryRestored} historyReady={historyReady} authReady={ready} accountLoading={accountLoading} accountLoadError={accountLoadError} onRetryAccountLoad={retryAccountLoad} drafts={drafts} records={records} autoRankRecordId={autoRankRecordId} galleryRankSeed={galleryRankSeed} onConsumeAiRankConsent={recordId => setAutoRankRecordId(current => current === recordId ? null : current)} onDeleteRecord={deleteRecord} onEditRecord={record => { setDrafts(previous => ({ ...previous, [record.mode]: snapshotSearchDraft(record.mode, record.draft) })); navigate(modePaths[record.mode]) }} session={session} items={items} onOpenGallery={openGallery} onAddGallery={addGallery} onDisconnect={disconnectGallery}
        onAssistantChange={(id, patch) => updateRecord(id, previous => updateSearchAssistant(previous, id, patch))} onRefineRecord={(parent, assistant) => parent.mode === 'lost' ? refineLostSearch(parent, assistant) : refineGallerySearch(parent, assistant)}
        onCommitGallerySearch={commitGallerySearch} onCommitLostSearch={commitLostSearch}
        onLogout={() => { void signOut() }} onSave={saveValuable}
        onDelete={id => saveValuables(previous => previous.filter(value => value.id !== id))} onView={id => setItems(previous => previous.map(value => value.id === id ? { ...value, viewedAt: Date.now() } : value))} onTransfer={transferPhoto} />}
    {contentError && <p className="content-sync-error" role="alert">{contentError}</p>}
    {guestHistory.storageError && <p className="content-sync-error" role="alert">이 브라우저에 검색 기록을 저장하지 못했어요.</p>}
    <footer className="site-footer"><p>그거어디? <span>내 사진 · 내 물건 찾기</span></p><div><Link to="/privacy">사진 처리 안내</Link></div></footer>
    <Modal open={overlay !== null} focusKey={overlay ?? ''} title={overlay === 'disconnect' ? '갤러리 연결을 해제할까요?' : '메뉴'} onClose={() => setOverlay(null)}>
      {overlay === 'menu' && <nav className="mobile-nav" aria-label="모바일 주 메뉴"><NavLink to="/gallery" onClick={() => setOverlay(null)}>{copy.gallery.name}</NavLink><NavLink to="/lost-found" onClick={() => setOverlay(null)}>{copy.lost.name}</NavLink><NavLink className={({ isActive }) => isActive || fromDirectSearch ? 'active' : ''} to={lastDirectSearchPath} onClick={() => setOverlay(null)}>직접 찾기</NavLink>{utilityNavigation}</nav>}
      {overlay === 'disconnect' && <><p>연결 정보와 갤러리 검색 기록을 지워요. 기기의 원본은 삭제하지 않아요.</p><div className="button-row"><button type="button" className="button button--secondary" onClick={() => setOverlay(null)}>취소</button><button type="button" className="button button--primary" onClick={disconnectGallery}>갤러리 해제</button></div></>}
    </Modal>
  </div>
}

function SearchModeIcon() { return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 2.5H3v3M14 2.5h3v3M17 14.5v3h-3M6 17.5H3v-3" /><circle cx="9" cy="9" r="3.5" /><path d="m11.5 11.5 3 3" /></svg> }

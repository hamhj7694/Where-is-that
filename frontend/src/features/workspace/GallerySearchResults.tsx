import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, MessageSquare } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { AI_GALLERY_RANK_LIMIT, GALLERY_CHANNELS, GALLERY_PREVIEW_LIMIT, createGalleryAssistantState, galleryPreviewItems, sortGalleryByRank, toGalleryRankMap, uniqueGalleryItems, type GalleryAssistantState, type GalleryRankMap, type GallerySearchChannel } from '../search/gallery-search-model'
import { compareCandidates } from '../search/ai-search-api'
import { validateSearch, type GallerySource, type SearchDraft } from '../search/model'
import { copy } from '../search/copy'
import SearchComposer from '../search/SearchComposer'
import { localPhotoId, photoFromFile, type AppPhoto } from './data'
import { DemoNotice, EmptyState, NoPhoto, PageHeading, Pagination, PhotoImage, RetryButton } from './components'
import GallerySearchAssistant from './GallerySearchAssistant'
import GalleryQuerySummary from './GalleryQuerySummary'
import Modal from '../../components/Modal'
import '../../styles/gallery-search.css'

export interface GallerySearchActions {
  assistant?: GalleryAssistantState
  onAssistantChange?: (patch: Partial<GalleryAssistantState>) => void
  onRefine?: (state: GalleryAssistantState) => void
  onCommitSearch: (draft: SearchDraft) => void
  /** 검색이 새로 커밋될 때마다 증가해 AI 사진 분석을 다시 트리거한다. */
  rankSeed?: number
}

interface Props extends GallerySearchActions {
  gallery: GallerySource | null
  draft: SearchDraft
  channel?: GallerySearchChannel
  onEdit?: () => void
  fromHistory?: boolean
  onOpenGallery: () => void
}

// StrictMode 개발 환경에서 같은 검색의 effect가 두 번 실행돼도 AI 호출은 한 번만 보낸다.
const rankRequests = new Map<string, ReturnType<typeof compareCandidates>>()
function requestRanking(key: string, input: Parameters<typeof compareCandidates>[0]) {
  const running = rankRequests.get(key)
  if (running) return running
  const started = compareCandidates(input)
  rankRequests.set(key, started)
  void started.then(() => undefined, () => undefined).finally(() => {
    if (rankRequests.get(key) === started) rankRequests.delete(key)
  })
  return started
}

const channelCopy = {
  combined: { title: '종합 검색', description: 'AI가 매긴 종합 관련성 순서', more: '종합 검색 더보기' },
  image: { title: '이미지 검색', description: 'AI가 매긴 이미지 유사도 순서', more: '이미지 검색 더보기' },
  context: { title: '맥락 검색', description: 'AI가 매긴 맥락 관련성 순서', more: '맥락 검색 더보기' },
} as const

type ChannelState = 'preview' | 'loading' | 'empty' | 'error'
const scrollPositions = new Map<string, number>()
const sourceProblems: Record<string, [string, string]> = {
  permission: ['갤러리에 접근할 수 없어요', '다시 연결하거나 사진을 직접 선택해 주세요.'],
  unsupported: ['사진을 직접 선택해 주세요', '이 환경에서는 폴더 연결을 사용할 수 없어요.'],
  'missing-source': ['갤러리를 다시 연결해 주세요', '연결이 해제되었거나 원본을 찾지 못했어요.'],
  'index-error': ['검색 준비를 완료하지 못했어요', '원본과 접근 권한을 확인해 주세요.'],
}

function useWideResults() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1100px)')
    const change = () => setWide(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return wide
}

function stateFor(params: URLSearchParams, channel: GallerySearchChannel): ChannelState {
  const specific = params.get(channel + 'State')
  if (specific && ['preview', 'loading', 'empty', 'error'].includes(specific)) return specific as ChannelState
  const state = params.get('state')
  if (state === 'loading' || state === 'indexing' || state === channel + '-loading') return 'loading'
  if (state === 'empty' || state === channel + '-empty') return 'empty'
  if (state === 'error' || state === channel + '-error' || state === 'partial-' + channel) return 'error'
  return 'preview'
}

function GalleryResultCard({ photo, to }: { photo: AppPhoto; to: string }) {
  return <Link className="gallery-result-card" to={to} aria-label={photo.name + ' 이미지 보기'}>
    <div className="gallery-result-card__image"><PhotoImage photo={photo} /></div>
    <div className="gallery-result-card__caption"><strong title={photo.name}>{photo.name}</strong><span>{photo.kind === 'screenshot' ? '스크린샷' : '사진'}</span></div>
  </Link>
}

export default function GallerySearchResults({ gallery, draft, channel, fromHistory, onOpenGallery, assistant: savedAssistant, onAssistantChange, onRefine, onCommitSearch, rankSeed }: Props) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [localAssistant, setLocalAssistant] = useState(createGalleryAssistantState)
  const [editor, setEditor] = useState<{ draft: SearchDraft; photoEdit: boolean } | null>(null)
  const [editorError, setEditorError] = useState('')
  const [editNotice, setEditNotice] = useState('')
  const wide = useWideResults()
  const panelId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const assistantInput = useRef<HTMLTextAreaElement>(null)
  const editorInput = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const restoringScroll = useRef(true)
  const assistant = savedAssistant ?? localAssistant
  const open = !editor && (assistant.open ?? wide)
  const photos = useMemo(() => uniqueGalleryItems((gallery?.files ?? []).map(file => photoFromFile(file, localPhotoId(file)))), [gallery])
  const [ranking, setRanking] = useState<GalleryRankMap | null>(null)
  const [referenceDescriptions, setReferenceDescriptions] = useState<string[]>([])
  const [rankBusy, setRankBusy] = useState(false)
  const [rankStatus, setRankStatus] = useState('')
  const [rankError, setRankError] = useState('')
  const [rankRetry, setRankRetry] = useState(0)
  // 파일 객체 identity가 바뀌어도 같은 검색이면 재분석하지 않도록 키로 묶는다.
  const rankKey = [rankSeed ?? 0, rankRetry, draft.query, draft.photo ? localPhotoId(draft.photo) : '', gallery?.files.length ?? 0].join('|')
  useEffect(() => {
    if (!gallery || (!draft.query.trim() && !draft.photo)) {
      setRanking(null); setReferenceDescriptions([]); setRankStatus(''); setRankError(''); setRankBusy(false)
      return
    }
    const candidates = uniqueGalleryItems(gallery.files.map(file => photoFromFile(file, localPhotoId(file))))
      .filter((item): item is AppPhoto & { file: File } => !!item.file)
      .slice(0, AI_GALLERY_RANK_LIMIT)
    if (!candidates.length) return
    let cancelled = false
    setRankBusy(true); setRanking(null); setReferenceDescriptions([]); setRankStatus(''); setRankError('')
    void requestRanking(rankKey, {
      mode: 'gallery',
      query: draft.query,
      references: draft.photo ? [draft.photo] : [],
      candidates: candidates.map(item => ({ id: item.id, file: item.file })),
    }).then(({ results, referenceDescriptions }) => {
      if (cancelled) return
      setRanking(toGalleryRankMap(results))
      setReferenceDescriptions(referenceDescriptions)
      setRankStatus(referenceDescriptions.length
        ? `AI가 참고 사진을 분석하고 검색어와 함께 반영해 연결된 사진 ${results.length}장의 종합·이미지·맥락 순서를 정했어요.`
        : `AI가 검색어를 반영해 연결된 사진 ${results.length}장의 종합·이미지·맥락 순서를 정했어요.`)
    }).catch(cause => {
      if (cancelled) return
      setRankError(cause instanceof Error ? cause.message : 'AI 사진 분석에 실패했어요.')
    }).finally(() => { if (!cancelled) setRankBusy(false) })
    return () => { cancelled = true }
  }, [rankKey])
  const pageKey = location.pathname + location.search
  useLayoutEffect(() => {
    const saved = scrollPositions.get(pageKey) ?? 0
    restoringScroll.current = true
    let restoreFrame = 0
    const frame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        window.scrollTo({ top: saved, left: 0, behavior: 'instant' })
        restoringScroll.current = false
      })
    })
    const remember = () => { if (!restoringScroll.current) scrollPositions.set(pageKey, window.scrollY) }
    window.addEventListener('scroll', remember, { passive: true })
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(restoreFrame); window.removeEventListener('scroll', remember) }
  }, [pageKey])

  function changeAssistant(patch: Partial<GalleryAssistantState>) {
    if (onAssistantChange) onAssistantChange(patch)
    else setLocalAssistant(previous => ({ ...previous, ...patch }))
  }
  function showAssistant(next: boolean) {
    changeAssistant({ open: next })
    requestAnimationFrame(() => { if (next) assistantInput.current?.focus(); else toggle.current?.focus() })
  }
  function startEditing(photoEdit = false) {
    setEditor({ draft: { ...draft }, photoEdit }); setEditorError(''); setEditNotice('')
    if (!photoEdit) requestAnimationFrame(() => editorInput.current?.focus())
  }
  function cancelEditing() {
    setEditor(null); setEditorError('')
    requestAnimationFrame(() => editButton.current?.focus())
  }
  function commitEditing(submittedDraft?: SearchDraft) {
    if (!editor) return
    const nextDraft = submittedDraft ?? editor.draft
    const problem = validateSearch('gallery', nextDraft, gallery)
    if (problem) { setEditorError(problem === 'empty' ? copy.emptyInput : copy.missingGallery); return }
    onCommitSearch({ query: nextDraft.query.trim(), photo: nextDraft.photo })
    const next = new URLSearchParams(params)
    for (const key of ['page', 'state', 'combinedState', 'imageState', 'contextState']) next.delete(key)
    const nextKey = location.pathname + (next.size ? '?' + next.toString() : '')
    scrollPositions.set(nextKey, 0)
    if (next.toString() !== params.toString()) { restoringScroll.current = true; setParams(next, { replace: true }) }
    setEditor(null); setEditorError(''); setLocalAssistant(createGalleryAssistantState()); setEditNotice('검색 내용을 수정했어요.')
    requestAnimationFrame(() => editButton.current?.focus())
  }
  function rememberScroll() { scrollPositions.set(pageKey, window.scrollY); restoringScroll.current = true }
  function linkTo(which?: GallerySearchChannel) {
    const next = new URLSearchParams(params)
    next.delete('view'); next.delete('page')
    return '/gallery/results' + (which ? '/' + which : '') + (next.size ? '?' + next.toString() : '')
  }
  function photoLink(photo: AppPhoto) {
    const next = new URLSearchParams({ back: pageKey })
    if (params.get('record')) next.set('record', params.get('record')!)
    return '/gallery/photo/' + photo.id + '?' + next.toString()
  }
  function retry(which: GallerySearchChannel) {
    const next = new URLSearchParams(params); next.set(which + 'State', 'preview'); setParams(next)
  }
  function changePage(nextPage: number) {
    rememberScroll()
    const next = new URLSearchParams(params); next.set('page', String(nextPage)); setParams(next)
  }

  if (!gallery) return <main id="main-content" className="content-workspace"><PageHeading title="찾은 이미지" /><EmptyState title="갤러리를 연결해 주세요" description="사진이나 폴더를 연결한 다음 검색할 수 있어요."><button type="button" className="button button--primary" onClick={onOpenGallery}>갤러리 연결</button></EmptyState></main>
  const sourceProblem = sourceProblems[params.get('state') ?? '']
  if (sourceProblem) return <main id="main-content" className="content-workspace"><PageHeading title="찾은 이미지" /><EmptyState title={sourceProblem[0]} description={sourceProblem[1]} error><button type="button" className="button button--primary" onClick={onOpenGallery}>갤러리 연결</button><RetryButton onClick={() => { const next = new URLSearchParams(params); next.delete('state'); setParams(next) }} /></EmptyState></main>
  if (!draft.query.trim() && !draft.photo) return <main id="main-content" className="content-workspace"><PageHeading title="찾은 이미지" /><EmptyState title="찾고 싶은 사진을 알려 주세요"><Link className="button button--primary" to="/gallery">갤러리에서 사진 찾기</Link></EmptyState></main>

  function renderChannel(which: GallerySearchChannel, full = false) {
    const text = channelCopy[which]
    const state = stateFor(params, which)
    const ranked = sortGalleryByRank(photos, ranking, which)
    const totalPages = Math.max(1, Math.ceil(ranked.length / 12))
    const page = Math.min(totalPages, Math.max(1, Math.floor(Number(params.get('page')) || 1)))
    const shown = full ? ranked.slice((page - 1) * 12, page * 12) : galleryPreviewItems(ranked)
    return <section className="gallery-result-section" key={which} aria-labelledby={panelId + '-' + which}>
      <div className="gallery-result-section__heading"><div><h2 id={panelId + '-' + which}>{text.title}</h2><p>{text.description}</p></div>
        {!full && state === 'preview' && photos.length > GALLERY_PREVIEW_LIMIT && <Link className="gallery-result-section__more" to={linkTo(which)}>{text.more}<ArrowRight aria-hidden="true" /></Link>}
      </div>
      {state === 'error' ? <EmptyState title="이 검색 기준을 불러오지 못했어요" description="다른 기준도 살펴볼 수 있어요." error><RetryButton onClick={() => retry(which)} /></EmptyState>
        : state === 'loading' ? <div className="gallery-result-grid" aria-busy="true" aria-label={text.title + ' 로딩 화면 미리보기'}>{Array.from({ length: GALLERY_PREVIEW_LIMIT }, (_, index) => <div className="gallery-result-skeleton" key={index} />)}</div>
        : state === 'empty' || !shown.length ? <EmptyState title="미리볼 이미지가 없어요" description="검색 조건이나 연결한 갤러리를 확인해 주세요." />
        : <>{full && totalPages > 1 && <Pagination page={page} pages={totalPages} onChange={changePage} inputId={'gallery-' + which + '-page-top'} position="top" />}
          <div className="gallery-result-grid">{shown.map(photo => <GalleryResultCard photo={photo} key={photo.id} to={photoLink(photo)} />)}
          {!full && Array.from({ length: Math.max(0, GALLERY_PREVIEW_LIMIT - shown.length) }, (_, index) => <div className="gallery-result-placeholder" key={'empty-' + index}><div className="gallery-result-card__image"><NoPhoto /></div></div>)}
        </div>
          {full && totalPages > 1 && <Pagination page={page} pages={totalPages} onChange={changePage} inputId={'gallery-' + which + '-page-bottom'} />}
        </>}
    </section>
  }

  const assistantToggle = <button type="button" className="button button--secondary" ref={toggle} aria-controls={panelId} aria-expanded={open} disabled={!!editor} onClick={() => showAssistant(!open)}><MessageSquare aria-hidden="true" />{open ? '도우미 접기' : '검색 도우미'}</button>
  return <div className={'gallery-search-shell' + (wide && open ? ' gallery-search-shell--open' : '')}><main id="main-content" className="content-workspace gallery-results" onClickCapture={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0 && event.target instanceof Element && event.target.closest('a')) rememberScroll() }}>
    <PageHeading title={channel ? channelCopy[channel].title + ' 결과' : '찾은 이미지'} back={channel ? { to: linkTo(), label: '찾은 이미지로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} action={wide ? assistantToggle : undefined} />
    <DemoNotice>{rankBusy ? 'AI가 연결된 사진을 분석하고 있어요…' : rankStatus || '연결된 사진을 기준으로 검색 결과를 보여줘요.'}</DemoNotice>
    {editor ? <div className="gallery-query-editor"><SearchComposer mode="gallery" draft={editor.draft} error={editorError} textareaRef={editorInput} initialAttachmentOpen={editor.photoEdit} submitLabel="다시 검색"
      onDraft={patch => { setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous); setEditorError('') }} onSubmit={commitEditing} onError={setEditorError}
      secondaryAction={<button type="button" className="button button--secondary gallery-query-editor__cancel" onClick={cancelEditing}>취소</button>} />
      {editorError && <p id="search-error" className="form-error" role="alert">{editorError}</p>}
    </div> : <GalleryQuerySummary key={draft.query + ':' + (draft.photo ? localPhotoId(draft.photo) : 'text')} draft={draft} editButtonRef={editButton} onEdit={startEditing} />}
    {referenceDescriptions.length > 0 && <div className="ai-plan gallery-reference-analysis">
      <p className="ai-plan__original"><strong>참고 사진 분석</strong> · AI가 읽은 대상과 요소를 작성한 검색어와 함께 반영했어요.</p>
      <div className="ai-plan__images"><ul>{referenceDescriptions.map((description, index) => <li key={index}>{description}</li>)}</ul></div>
    </div>}
    <p role="status" className="gallery-query-status">{editNotice}</p>
    {rankError && <p className="form-error" role="alert">{rankError}</p>}
    {rankError && <button type="button" className="button button--secondary" onClick={() => setRankRetry(count => count + 1)}>사진 분석 다시 시도</button>}
    <div className="gallery-results__toolbar"><p>검색 범위 · {gallery.name} · {gallery.files.length.toLocaleString('ko-KR')}장</p>
      {!wide && assistantToggle}
    </div>
    <div className="gallery-results__sections">{channel ? renderChannel(channel, true) : GALLERY_CHANNELS.map(which => renderChannel(which))}</div>
  </main>
    {wide ? open && <div className="gallery-assistant-dock"><GallerySearchAssistant id={panelId} wide state={assistant} baseQuery={draft.query} inputRef={assistantInput} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} /></div>
      : <Modal open={open} title="검색 도우미" focusKey={panelId} className="gallery-assistant-modal" initialFocus={assistantInput} onClose={() => showAssistant(false)}><GallerySearchAssistant id={panelId} wide={false} hideHeading state={assistant} baseQuery={draft.query} inputRef={assistantInput} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} /></Modal>}
  </div>
}

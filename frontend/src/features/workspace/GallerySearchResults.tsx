import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, MessageSquare } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { AI_GALLERY_RANK_LIMIT, GALLERY_CHANNELS, GALLERY_PREVIEW_LIMIT, createGalleryAssistantState, galleryPreviewItems, galleryRankSignature, galleryResultItems, sortGalleryByRank, uniqueGalleryItems, type GalleryAssistantState, type GalleryRankMap, type GallerySearchChannel } from '../search/gallery-search-model'
import { rankConnectedGallery, type GalleryRankCandidate } from '../search/gallery-local-rank'
import { validateSearch, type GallerySource, type SearchDraft } from '../search/model'
import { copy } from '../search/copy'
import { findIdenticalGalleryFiles } from '../search/gallery-deduplication'
import { clearGalleryRankSnapshot, readGalleryRankSnapshot, saveGalleryRankSnapshot } from '../search/history'
import SearchComposer from '../search/SearchComposer'
import { localPhotoId, photoFromFile, type AppPhoto } from './data'
import { withMinimumVisible } from './ai-loading'
import { AiSearching, DemoNotice, EmptyState, PageHeading, Pagination, PhotoImage, RetryButton } from './components'
import GallerySearchAssistant from './GallerySearchAssistant'
import AiQueryOptimizer from './AiQueryOptimizer'
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

const channelCopy = {
  combined: { title: '추천 사진', description: '적어둔 내용과 사진 특징을 함께 살펴봤어요.', more: '추천 사진 더보기' },
  image: { title: '닮은 사진', description: '참고 사진과 닮은 특징을 먼저 보여줘요.', more: '닮은 사진 더보기' },
  context: { title: '설명이 잘 맞는 사진', description: '적어둔 내용과 잘 맞는 사진을 먼저 보여줘요.', more: '잘 맞는 사진 더보기' },
} as const

function textForChannel(which: GallerySearchChannel, hasReference: boolean, hasQuery: boolean) {
  if (which === 'image' && !hasReference) return {
    title: '사진 속 특징', description: '색상·모양 같은 사진 속 특징을 살펴봤어요.', more: '사진 특징 결과 더보기',
  }
  if (!hasQuery && which === 'combined') return { ...channelCopy.combined, description: '참고 사진을 바탕으로 골랐어요.' }
  if (!hasQuery && which === 'context') return { ...channelCopy.context, description: '참고 사진에서 본 특징을 기준으로 비교해요.' }
  return channelCopy[which]
}

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

function GalleryResultCard({ photo, to, exactMatch, score }: { photo: AppPhoto; to: string; exactMatch: boolean; score?: number }) {
  return <Link className="gallery-result-card" to={to} aria-label={photo.name + ' 이미지 보기' + (exactMatch ? ' · 참고 사진과 같은 이미지' : '')}
    data-rank-score={score} data-rank-basis={import.meta.env.DEV && exactMatch ? '동일 파일 우선' : undefined}>
    <div className="gallery-result-card__image"><PhotoImage photo={photo} /></div>
    <div className="gallery-result-card__caption"><strong title={photo.name}>{photo.name}</strong>
      {exactMatch ? <span className="gallery-result-card__match">참고 사진과 같은 이미지</span> : <span>{photo.kind === 'screenshot' ? '스크린샷' : '사진'}</span>}
    </div>
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
  const [rankChecked, setRankChecked] = useState(0)
  const [rankError, setRankError] = useState('')
  const [rankRetry, setRankRetry] = useState(0)
  const [exactMatches, setExactMatches] = useState<Set<string>>(() => new Set())
  const [exactBusy, setExactBusy] = useState(false)
  const recordId = params.get('record')
  const referencePhoto = draft.photo
  const galleryFiles = gallery?.files
  const hasQuery = !!draft.query.trim()
  const showLoading = (exactBusy || rankBusy) && exactMatches.size === 0
  useLayoutEffect(() => {
    setExactMatches(new Set())
    if (!referencePhoto || !galleryFiles?.length) {
      setExactBusy(false)
      return
    }
    const controller = new AbortController()
    setExactBusy(true)
    void findIdenticalGalleryFiles(referencePhoto, galleryFiles, controller.signal).then(matches => {
      if (!controller.signal.aborted) setExactMatches(new Set(matches.map(localPhotoId)))
    }).catch(() => {
      // An unavailable local check must not block the regular ranking.
    }).finally(() => {
      if (!controller.signal.aborted) setExactBusy(false)
    })
    return () => controller.abort()
  }, [referencePhoto, galleryFiles])
  const candidates = useMemo(() => photos.filter((item): item is AppPhoto & GalleryRankCandidate => !!item.file), [photos])
  const candidateIds = candidates.map(photo => photo.id)
  const referenceId = referencePhoto ? localPhotoId(referencePhoto) : ''
  const rankSignature = galleryRankSignature(draft.query, referenceId, candidateIds)
  const rankKey = JSON.stringify([recordId, rankSeed, rankRetry, rankSignature])
  // 페인트 전에 로딩을 켜서 결과 화면이 먼저 번쩍이지 않게 한다.
  useLayoutEffect(() => {
    if (!candidates.length || (!hasQuery && !referencePhoto)) {
      setRanking(null); setReferenceDescriptions([]); setRankChecked(0); setRankError(''); setRankBusy(false)
      return
    }
    const saved = recordId && readGalleryRankSnapshot(recordId, rankSignature)
    if (saved) {
      setRanking(saved.ranking); setReferenceDescriptions(saved.descriptions); setRankChecked(candidates.length)
      setRankError(''); setRankBusy(false)
      return
    }
    const legacySignature = JSON.stringify([draft.query, referenceId, candidateIds.slice(0, AI_GALLERY_RANK_LIMIT)])
    const legacy = recordId && readGalleryRankSnapshot(recordId, legacySignature)
    const descriptions = (legacy ? legacy.descriptions : draft.aiPlan?.imageDescriptions ?? [])
      .map(description => description.trim()).filter(Boolean)
    const controller = new AbortController()
    const startedAt = Date.now()
    setRankBusy(true); setRanking(null); setReferenceDescriptions(descriptions); setRankChecked(0); setRankError('')
    // StrictMode cleans up its first effect before the microtask starts the scan.
    const scan = Promise.resolve().then(() => rankConnectedGallery(
      draft.query, referencePhoto, candidates, controller.signal, setRankChecked,
    ))
    void withMinimumVisible(startedAt, scan).then(scores => {
      if (controller.signal.aborted) return
      const count = Object.keys(scores).length
      if (!count) throw new Error('연결한 사진을 읽지 못했어요. 사진 형식을 확인하고 다시 시도해 주세요.')
      setRanking(scores)
      if (recordId) saveGalleryRankSnapshot(recordId, { signature: rankSignature, ranking: scores, descriptions, count })
    }).catch(cause => {
      if (controller.signal.aborted) return
      setRankError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : '이 기기의 사진 분석에 연결하지 못했어요.')
    }).finally(() => { if (!controller.signal.aborted) setRankBusy(false) })
    return () => controller.abort()
  }, [rankKey])
  const rankedPhotos = useMemo(() => galleryResultItems(photos, ranking, exactMatches), [photos, exactMatches, ranking])
  const rankedCount = ranking ? Object.keys(ranking).length : 0
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
    const text = textForChannel(which, !!draft.photo, hasQuery)
    const state = stateFor(params, which)
    const axis = which === 'combined' ? 'score' : which === 'image' ? 'imageSimilarity' : 'contextRelevance'
    const ranked = sortGalleryByRank(rankedPhotos, ranking, which, exactMatches)
    const totalPages = Math.max(1, Math.ceil(ranked.length / 12))
    const page = Math.min(totalPages, Math.max(1, Math.floor(Number(params.get('page')) || 1)))
    const shown = full ? ranked.slice((page - 1) * 12, page * 12) : galleryPreviewItems(ranked)
    return <section className="gallery-result-section" key={which} aria-labelledby={panelId + '-' + which}>
      <div className="gallery-result-section__heading"><div><h2 id={panelId + '-' + which}>{text.title}</h2><p>{text.description}</p></div>
        {!full && state === 'preview' && ranked.length > GALLERY_PREVIEW_LIMIT && <Link className="gallery-result-section__more" to={linkTo(which)}>{text.more}<ArrowRight aria-hidden="true" /></Link>}
      </div>
      {state === 'error' ? <EmptyState title="결과를 불러오지 못했어요" description="다른 결과를 살펴보거나 다시 시도해 주세요." error><RetryButton onClick={() => retry(which)} /></EmptyState>
        : state === 'loading' ? <AiSearching compact label="사진을 골라보고 있어요" />
        : state === 'empty' || !shown.length ? <EmptyState title="여기서는 찾은 사진이 없어요" description="검색 내용을 바꾸거나 다른 결과를 살펴보세요." />
        : <>{full && totalPages > 1 && <Pagination page={page} pages={totalPages} onChange={changePage} inputId={'gallery-' + which + '-page-top'} position="top" />}
          <div className="gallery-result-grid">{shown.map(photo => <GalleryResultCard photo={photo} key={photo.id} to={photoLink(photo)}
            exactMatch={exactMatches.has(photo.id)} score={import.meta.env.DEV ? ranking?.[photo.id]?.[axis] : undefined} />)}</div>
          {full && totalPages > 1 && <Pagination page={page} pages={totalPages} onChange={changePage} inputId={'gallery-' + which + '-page-bottom'} />}
        </>}
    </section>
  }

  const assistantToggle = <button type="button" className="button button--secondary" ref={toggle} aria-controls={panelId} aria-expanded={open} disabled={!!editor} onClick={() => showAssistant(!open)}><MessageSquare aria-hidden="true" />{open ? '도우미 접기' : '검색 도우미'}</button>
  return <div className={'gallery-search-shell' + (wide && open ? ' gallery-search-shell--open' : '')}><main id="main-content" className="content-workspace gallery-results" onClickCapture={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0 && event.target instanceof Element && event.target.closest('a')) rememberScroll() }}>
    <PageHeading title={channel ? textForChannel(channel, !!draft.photo, hasQuery).title : '찾은 이미지'} back={channel ? { to: linkTo(), label: '찾은 이미지로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} action={wide ? assistantToggle : undefined} />
    {(!rankError || exactMatches.size > 0) && <DemoNotice>
      {exactMatches.size > 0 && '참고 사진과 같은 이미지를 먼저 보여줘요. '}
      {rankBusy ? `연결한 사진을 확인하고 있어요 · ${rankChecked.toLocaleString('ko-KR')}/${candidates.length.toLocaleString('ko-KR')}장`
        : rankedCount ? `연결한 사진 ${rankedCount.toLocaleString('ko-KR')}장을 비교했어요.`
          : exactBusy ? '연결한 사진에서 같은 파일을 찾고 있어요…' : null}
      {rankedCount > 0 && rankedCount < candidates.length && ` ${(candidates.length - rankedCount).toLocaleString('ko-KR')}장은 읽지 못했어요.`}
    </DemoNotice>}
    <div className="result-search-tools">
      {editor ? <div className="gallery-query-editor"><SearchComposer mode="gallery" draft={editor.draft} error={editorError} textareaRef={editorInput} initialAttachmentOpen={editor.photoEdit} submitLabel="다시 검색"
        onDraft={patch => { setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous); setEditorError('') }} onSubmit={commitEditing} onError={setEditorError}
        secondaryAction={<button type="button" className="button button--secondary gallery-query-editor__cancel" onClick={cancelEditing}>취소</button>} />
        {editorError && <p id="search-error" className="form-error" role="alert">{editorError}</p>}
      </div> : <GalleryQuerySummary key={draft.query + ':' + (draft.photo ? localPhotoId(draft.photo) : 'text')} draft={draft} editButtonRef={editButton} onEdit={startEditing} />}
      {!editor && referenceDescriptions.length > 0 && <section className="gallery-reference-analysis" aria-labelledby={panelId + '-reference'}>
        <h2 id={panelId + '-reference'}>참고 사진에서 본 특징</h2>
        {referenceDescriptions.map((description, index) => <p key={index}>{description}</p>)}
      </section>}
      {!editor && onRefine && <AiQueryOptimizer mode="gallery" baseQuery={draft.query} state={assistant} onChange={changeAssistant} onApply={onRefine} />}
      <p role="status" className="gallery-query-status">{editNotice}</p>
      {rankError && <div className="result-search-tools__error">
        <p className="form-error" role="alert">{rankError}</p>
        <button type="button" className="button button--secondary" onClick={() => {
          if (recordId) clearGalleryRankSnapshot(recordId)
          setRankRetry(count => count + 1)
        }}>사진 분석 다시 시도</button>
      </div>}
    </div>
    <div className="gallery-results__toolbar"><p>검색 범위 · {gallery.name} · {gallery.files.length.toLocaleString('ko-KR')}장</p>
      {!wide && assistantToggle}
    </div>
    <div className="gallery-results__sections">{showLoading
      ? <AiSearching label="연결한 사진 전체에서 찾고 있어요" />
      : (!rankError || rankedPhotos.length > 0) && (channel ? renderChannel(channel, true) : GALLERY_CHANNELS.map(which => renderChannel(which)))}</div>
  </main>
    {wide ? open && <div className="gallery-assistant-dock"><GallerySearchAssistant id={panelId} wide state={assistant} baseQuery={draft.query} inputRef={assistantInput} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} /></div>
      : <Modal open={open} title="검색 도우미" focusKey={panelId} className="gallery-assistant-modal" initialFocus={assistantInput} onClose={() => showAssistant(false)}><GallerySearchAssistant id={panelId} wide={false} hideHeading state={assistant} baseQuery={draft.query} inputRef={assistantInput} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} /></Modal>}
  </div>
}

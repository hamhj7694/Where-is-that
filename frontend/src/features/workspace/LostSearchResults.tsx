import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, MessageSquare } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import Modal from '../../components/Modal'
import SearchComposer from '../search/SearchComposer'
import { copy } from '../search/copy'
import { createGalleryAssistantState, GALLERY_PREVIEW_LIMIT, uniqueGalleryItems, type GalleryAssistantState } from '../search/gallery-search-model'
import { getReferencePhotos, snapshotSearchDraft, validateSearch, MAX_LOST_REFERENCE_PHOTOS, type SearchDraft } from '../search/model'
import { LOST_RESULT_CHANNELS, filterCandidateRecords, lostResultChannelState, type LostResultChannel } from '../search/lost-result-model'
import type { Candidate } from '../search/catalog-model'
import { DemoNotice, EmptyState, FoundCard, PageHeading, RetryButton } from './components'
import { localPhotoId, OFFICIAL_SEARCH_URL, sampleCandidates } from './data'
import GalleryQuerySummary from './GalleryQuerySummary'
import GallerySearchAssistant from './GallerySearchAssistant'
import LostResultFilters from './LostResultFilters'
import '../../styles/gallery-search.css'
import '../../styles/lost-results.css'

export interface LostSearchActions {
  assistant?: GalleryAssistantState
  onAssistantChange?: (patch: Partial<GalleryAssistantState>) => void
  onRefine?: (state: GalleryAssistantState) => void
  onCommitSearch: (draft: SearchDraft) => void
}
interface Props extends LostSearchActions { draft: SearchDraft; channel?: LostResultChannel; fromHistory?: boolean }
const titles = { combined: '종합', image: '사진 특징이 비슷한 후보', context: '설명·조건이 비슷한 후보' }
const descriptions = { combined: '사진과 설명·조건 기준의 후보를 모아 봐요.', image: '색상·모양 등 사진의 특징을 살펴보세요.', context: '물건 설명과 습득 정보를 살펴보세요.' }
const scrollPositions = new Map<string, number>()

function useWideResults() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches)
  useEffect(() => { const media = window.matchMedia('(min-width: 1100px)'); const change = () => setWide(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change) }, [])
  return wide
}

export default function LostSearchResults({ draft, channel, fromHistory, assistant: savedAssistant, onAssistantChange, onRefine, onCommitSearch }: Props) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [localAssistant, setLocalAssistant] = useState(createGalleryAssistantState)
  const [editor, setEditor] = useState<{ draft: SearchDraft; photoEdit: boolean } | null>(null)
  const [editorError, setEditorError] = useState('')
  const [editNotice, setEditNotice] = useState('')
  const wide = useWideResults()
  const id = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const editorInput = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const restoringScroll = useRef(true)
  const assistant = savedAssistant ?? localAssistant
  const open = !editor && (assistant.open ?? wide)
  const pageKey = location.pathname + location.search
  useLayoutEffect(() => {
    const saved = scrollPositions.get(pageKey) ?? 0
    restoringScroll.current = true
    let second = 0
    const frame = requestAnimationFrame(() => { second = requestAnimationFrame(() => { window.scrollTo({ top: saved, left: 0, behavior: 'instant' }); restoringScroll.current = false }) })
    const remember = () => { if (!restoringScroll.current) scrollPositions.set(pageKey, window.scrollY) }
    window.addEventListener('scroll', remember, { passive: true })
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(second); window.removeEventListener('scroll', remember) }
  }, [pageKey])

  const imageSource = filterCandidateRecords(sampleCandidates.filter(item => item.photoStatus === 'verified_photo' && !!item.image), params)
  const contextSource = filterCandidateRecords([...sampleCandidates.slice(4), ...sampleCandidates.slice(0, 4)], params)
  const counts = { image: imageSource.length, context: contextSource.length }
  const statusFor = (which: LostResultChannel) => lostResultChannelState(params, which, counts)
  const combinedSource = uniqueGalleryItems([
    ...(statusFor('image') === 'success' ? imageSource : []),
    ...(statusFor('context') === 'success' ? contextSource : []),
  ])

  function changeAssistant(patch: Partial<GalleryAssistantState>) { if (onAssistantChange) onAssistantChange(patch); else setLocalAssistant(previous => ({ ...previous, ...patch })) }
  function showAssistant(next: boolean) { changeAssistant({ open: next }); requestAnimationFrame(() => next ? input.current?.focus() : toggle.current?.focus()) }
  function startEditing(photoEdit = false) { setEditor({ draft: snapshotSearchDraft('lost', draft), photoEdit }); setEditorError(''); setEditNotice(''); if (!photoEdit) requestAnimationFrame(() => editorInput.current?.focus()) }
  function cancelEditing() { setEditor(null); setEditorError(''); requestAnimationFrame(() => editButton.current?.focus()) }
  function commitEditing(event: FormEvent) {
    event.preventDefault()
    if (!editor) return
    const problem = validateSearch('lost', editor.draft, null)
    if (problem) { setEditorError(problem === 'too-many-photos' ? `참고 사진은 ${MAX_LOST_REFERENCE_PHOTOS}장까지 추가할 수 있어요.` : copy.emptyInput); return }
    onCommitSearch(snapshotSearchDraft('lost', editor.draft))
    const next = new URLSearchParams(params)
    for (const key of ['page', 'state', 'combinedState', 'imageState', 'contextState']) next.delete(key)
    const nextKey = location.pathname + (next.size ? '?' + next.toString() : '')
    scrollPositions.set(nextKey, 0)
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
    setEditor(null); setEditorError(''); setLocalAssistant(createGalleryAssistantState()); setEditNotice('검색 내용을 수정했어요.')
    requestAnimationFrame(() => editButton.current?.focus())
  }
  function rememberScroll() { scrollPositions.set(pageKey, window.scrollY); restoringScroll.current = true }
  function linkTo(which?: LostResultChannel) { const next = new URLSearchParams(params); next.delete('page'); return '/lost-found/results' + (which ? '/' + which : '') + (next.size ? '?' + next.toString() : '') }
  function retry(which: LostResultChannel) {
    const next = new URLSearchParams(params)
    if (which === 'combined') { next.delete('state'); next.set('imageState', 'success'); next.set('contextState', 'success') }
    next.set(which + 'State', 'success'); setParams(next)
  }
  function changePage(page: number) { rememberScroll(); const next = new URLSearchParams(params); next.set('page', String(page)); setParams(next) }

  if (!draft.query.trim() && !getReferencePhotos(draft).length) return <main id="main-content" className="content-workspace"><PageHeading title="비슷한 물건 후보" /><EmptyState title="잃어버린 물건을 알려 주세요"><Link to="/lost-found" className="button button--primary">분실물 찾기</Link></EmptyState></main>

  function renderSection(which: LostResultChannel, full = false) {
    const status = statusFor(which)
    const items: Candidate[] = which === 'combined' ? combinedSource : which === 'image' ? imageSource : contextSource
    const pages = Math.max(1, Math.ceil(items.length / 12))
    const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get('page')) || 1)))
    const shown = full ? items.slice((page - 1) * 12, page * 12) : items.slice(0, GALLERY_PREVIEW_LIMIT)
    const available = status === 'success' || status === 'partial'
    return <section className="gallery-result-section lost-result-section" key={which} aria-labelledby={id + '-' + which}>
      <div className="gallery-result-section__heading"><div><h2 id={id + '-' + which}>{titles[which]}</h2><p>{descriptions[which]}</p></div>{!full && available && items.length > GALLERY_PREVIEW_LIMIT && <Link className="gallery-result-section__more" to={linkTo(which)}>{titles[which]} 더보기<ArrowRight aria-hidden="true" /></Link>}</div>
      {status === 'partial' && <p className="lost-results__partial" role="status">일부 검색 기준을 불러오지 못했어요. 확인 가능한 샘플 후보를 보여드려요. <button type="button" onClick={() => retry('combined')}>다시 시도</button></p>}
      {status === 'loading' ? <div className="gallery-result-grid" aria-busy="true" aria-label={titles[which] + ' 로딩 상태 샘플'}>{Array.from({ length: GALLERY_PREVIEW_LIMIT }, (_, index) => <div className="gallery-result-skeleton" key={index} />)}</div>
        : status === 'error' ? <EmptyState title="이 기준의 후보를 불러오지 못했어요" description="다른 검색 기준도 살펴볼 수 있어요." error><RetryButton onClick={() => retry(which)} /></EmptyState>
          : status === 'confirmation' ? <EmptyState title="검색 내용을 확인해 주세요" description="입력 확인이 필요한 상태의 화면 예시예요."><button type="button" className="button button--secondary" onClick={() => startEditing()}>검색 수정</button><RetryButton onClick={() => retry(which)} /></EmptyState>
            : status === 'empty' || !shown.length ? <EmptyState title="이 조건에 맞는 후보가 없어요" description="공개 정보가 없거나 부족할 수 있어요."><button type="button" className="button button--secondary" onClick={() => startEditing()}>검색 수정</button><a className="button button--secondary" href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">공식 검색 안내</a></EmptyState>
              : <><div className="gallery-result-grid lost-result-grid">{shown.map(item => <FoundCard key={item.id} item={item} to={'/lost-found/item/demo/' + item.id + '?back=' + encodeURIComponent(pageKey)} />)}</div>
                {full && pages > 1 && <div className="pagination"><button type="button" className="button button--secondary" disabled={page <= 1} onClick={() => changePage(page - 1)}>이전</button><span>{page} / {pages}</span><button type="button" className="button button--secondary" disabled={page >= pages} onClick={() => changePage(page + 1)}>다음</button></div>}</>}
    </section>
  }
  const assistantToggle = <button type="button" className="button button--secondary" ref={toggle} aria-controls={id} aria-expanded={open} disabled={!!editor} onClick={() => showAssistant(!open)}><MessageSquare aria-hidden="true" />{open ? '도우미 접기' : '검색 도우미'}</button>
  const assistantPanel = <GallerySearchAssistant id={id} mode="lost" wide={wide} hideHeading={!wide} state={assistant} inputRef={input} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} />
  return <div className={'gallery-search-shell lost-search-shell' + (wide && open ? ' gallery-search-shell--open' : '')}><main id="main-content" className="content-workspace gallery-results lost-results" onClickCapture={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0 && event.target instanceof Element && event.target.closest('a')) rememberScroll() }}>
    <PageHeading title={channel ? titles[channel] : '비슷한 물건 후보'} back={channel ? { to: linkTo(), label: '비슷한 물건 후보로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} action={wide ? assistantToggle : undefined} />
    <DemoNotice>샘플 후보 · 실제 검색 결과가 아니에요. AI·공개 API 미연결</DemoNotice>
    {editor ? <div className="gallery-query-editor"><SearchComposer mode="lost" draft={editor.draft} error={editorError} textareaRef={editorInput} initialAttachmentOpen={editor.photoEdit} submitLabel="다시 검색" onDraft={patch => { setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous); setEditorError('') }} onSubmit={commitEditing} onError={setEditorError} secondaryAction={<button type="button" className="button button--secondary gallery-query-editor__cancel" onClick={cancelEditing}>취소</button>} />{editorError && <p id="search-error" className="form-error" role="alert">{editorError}</p>}</div>
      : <GalleryQuerySummary mode="lost" key={draft.query + ':' + getReferencePhotos(draft).map(localPhotoId).join('|')} draft={draft} editButtonRef={editButton} onEdit={startEditing} />}
    <p className="gallery-query-status" role="status">{editNotice}</p>
    <div className="gallery-results__toolbar"><p>검색 범위 · 경찰청 공개 습득물 정보</p>{!wide && assistantToggle}</div>
    <LostResultFilters />
    {params.get('state') === 'stale' && <p className="inline-error">공식 기록이 변경된 상태 예시예요.</p>}
    <div className="gallery-results__sections">{channel ? renderSection(channel, true) : LOST_RESULT_CHANNELS.map(which => renderSection(which))}</div>
    <p className="field__help result-disclaimer">같은 물건인지와 보관 여부는 보관기관에 확인해 주세요. AI가 잘못 찾거나 놓칠 수 있고, 공개 정보가 부족하면 검색이 제한될 수 있어요.</p>
  </main>{wide ? open && <div className="gallery-assistant-dock">{assistantPanel}</div> : <Modal open={open} title="검색 도우미" focusKey={id} className="gallery-assistant-modal" initialFocus={input} onClose={() => showAssistant(false)}>{assistantPanel}</Modal>}</div>
}

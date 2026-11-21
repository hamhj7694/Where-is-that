import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, MessageSquare, Sparkles } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import Modal from '../../components/Modal'
import SearchComposer from '../search/SearchComposer'
import { copy } from '../search/copy'
import { createGalleryAssistantState, GALLERY_PREVIEW_LIMIT, uniqueGalleryItems, type GalleryAssistantState } from '../search/gallery-search-model'
import { getReferencePhotos, snapshotSearchDraft, validateSearch, MAX_LOST_REFERENCE_PHOTOS, type SearchDraft } from '../search/model'
import { LOST_RESULT_CHANNELS, filterCandidateRecords, lostResultChannelState, readLostResultFilters, type LostResultChannel } from '../search/lost-result-model'
import type { Candidate } from '../search/catalog-model'
import { dedupeLostFound, REGIONS, searchLostFound, toCandidate, type FoundItem, type LostSearchHints } from '../search/lostfound-api'
import { rankLostContextCandidates, type AiContextRankCandidate, type AiContextRankedCandidate, type AiLocationRelation } from '../search/ai-search-api'
import { criteriaFromPlan, criteriaToHints, criteriaLabels, hasSearchCriteria, matchPublicItem, resolveApiKeyword, type AiSearchCriteria } from '../search/ai-match-model'
import { EmptyState, FoundCard, PageHeading, Pagination, RetryButton } from './components'
import { localPhotoId, OFFICIAL_SEARCH_URL } from './data'
import GalleryQuerySummary from './GalleryQuerySummary'
import GallerySearchAssistant from './GallerySearchAssistant'
import LostResultFilters from './LostResultFilters'
import '../../styles/gallery-search.css'
import '../../styles/lost-results.css'

export interface LostSearchActions {
  autoRankContext?: boolean
  onConsumeAutoRankConsent?: () => void
  assistant?: GalleryAssistantState
  onAssistantChange?: (patch: Partial<GalleryAssistantState>) => void
  onRefine?: (state: GalleryAssistantState) => void
  onCommitSearch: (draft: SearchDraft, autoRankConsent?: boolean) => void
}
interface Props extends LostSearchActions { draft: SearchDraft; channel?: LostResultChannel; fromHistory?: boolean }
const titles = { combined: '종합', image: '사진 특징이 비슷한 후보', context: '설명·조건이 비슷한 후보' }
const descriptions = { combined: '사진과 설명·조건 기준의 후보를 모아 봐요.', image: '색상·모양 등 사진의 특징을 살펴보세요.', context: '물건 설명과 습득 정보를 살펴보세요.' }
const scrollPositions = new Map<string, number>()
const API_ROWS = 40

interface LiveState {
  raw: FoundItem[]
  fetched: number
  total: number
  apiPage: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  partial: boolean
}
const initialLive = (loading: boolean): LiveState => ({ raw: [], fetched: 0, total: 0, apiPage: 0, loading, loadingMore: false, error: null, partial: false })
type ContextRankInput = Parameters<typeof rankLostContextCandidates>[0]
const locationRelationLabels: Record<AiLocationRelation, string> = {
  direct_match: '습득 장소 직접 일치',
  possible_nearby: '주변 지역 가능성',
  regional_context: '넓은 지역 맥락',
  uncertain: '장소 근거 불확실',
  not_applicable: '장소 조건 없음',
}

function toAiContextRankCandidate(item: FoundItem): AiContextRankCandidate {
  return {
    id: toCandidate(item).id,
    name: item.name,
    subject: item.subject,
    notes: item.notes,
    category: item.category,
    color: item.color,
    foundDate: item.foundDate,
    foundTime: item.foundTime,
    foundPlace: item.foundPlace,
    storagePlace: item.storagePlace,
    orgName: item.orgName,
    address: item.address,
    status: item.status,
    keepType: '',
    placeName: item.place?.name ?? '',
    placeAddress: item.place?.address ?? '',
    placeRoadAddress: item.place?.roadAddress ?? '',
    placeCategory: item.place?.category ?? '',
  }
}

interface CriteriaResult {
  items: Candidate[]
  scores: Map<string, number>
  hits: Map<string, string[]>
  allInclude: Set<string>
  matched: number
  dropped: number
}

/** 공개 JSON에 AND/OR/NOT·사진 특징을 적용해 후보를 걸러내고 관련도 순으로 정렬한다. */
function applyCriteria(raw: readonly FoundItem[], criteria: AiSearchCriteria): CriteriaResult {
  const entries = dedupeLostFound(raw).map(item => ({
    candidate: toCandidate(item),
    match: matchPublicItem(item, criteria),
  }))
  const kept = entries.filter(entry => !entry.match.excludedBy)
  kept.sort((left, right) => right.match.score - left.match.score)
  return {
    items: kept.map(entry => entry.candidate),
    scores: new Map(kept.map(entry => [entry.candidate.id, entry.match.score])),
    hits: new Map(kept.map(entry => [entry.candidate.id, entry.match.hits])),
    allInclude: new Set(kept.filter(entry => entry.match.allInclude).map(entry => entry.candidate.id)),
    matched: kept.filter(entry => entry.match.hits.length > 0).length,
    dropped: entries.length - kept.length,
  }
}

function sortByRank<T extends Candidate>(items: readonly T[], scores: ReadonlyMap<string, number>, fallback?: ReadonlyMap<string, number>): T[] {
  const positions = new Map(items.map((item, index) => [item.id, index]))
  return [...items].sort((left, right) => {
    const leftScore = scores.get(left.id) ?? fallback?.get(left.id)
    const rightScore = scores.get(right.id) ?? fallback?.get(right.id)
    if (leftScore === undefined && rightScore === undefined) return (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0)
    if (leftScore === undefined) return 1
    if (rightScore === undefined) return -1
    return rightScore - leftScore || (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0)
  })
}

function useWideResults() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches)
  useEffect(() => { const media = window.matchMedia('(min-width: 1100px)'); const change = () => setWide(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change) }, [])
  return wide
}

export default function LostSearchResults({ draft, channel, fromHistory, autoRankContext, onConsumeAutoRankConsent, assistant: savedAssistant, onAssistantChange, onRefine, onCommitSearch }: Props) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [localAssistant, setLocalAssistant] = useState(createGalleryAssistantState)
  const [editor, setEditor] = useState<{ draft: SearchDraft; photoEdit: boolean } | null>(null)
  const [editorError, setEditorError] = useState('')
  const [editNotice, setEditNotice] = useState('')
  const [rankBusy, setRankBusy] = useState(false)
  const [rankError, setRankError] = useState('')
  const [contextRank, setContextRank] = useState<{ scope: string; results: AiContextRankedCandidate[] } | null>(null)
  const wide = useWideResults()
  const id = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const editorInput = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const restoringScroll = useRef(true)
  const rankRequestSequence = useRef(0)
  const autoRankConsumed = useRef(false)
  const consumeAutoRankRef = useRef(onConsumeAutoRankConsent)
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

  // 샘플 후보 대신 경찰청 공개 API 결과를 사용한다.
  const [live, setLive] = useState<LiveState>(() => initialLive(true))
  const [reloadToken, setReloadToken] = useState(0)
  const criteria = useMemo(() => criteriaFromPlan(draft.aiPlan, draft.query), [draft.aiPlan, draft.query])
  const hints = useMemo<LostSearchHints>(() => criteriaToHints(criteria), [criteria])
  const hintsKey = useMemo(() => JSON.stringify(hints), [hints])
  const keyword = resolveApiKeyword(criteria, draft.aiPlan?.channels.combined.query || draft.aiPlan?.channels.image.query || draft.query)
  const pageParam = params.get('page')
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    const plan = draft.aiPlan
    if (!plan) return
    // '신림역 근처' 같은 자연어 장소는 JSON 조건 매칭에만 쓰고, 시도 단위가 아니면 하드 필터로 넣지 않는다.
    const suggestedRegion = plan.filters.region
    const region = REGIONS.some(name => suggestedRegion === name || suggestedRegion.startsWith(name)) ? suggestedRegion : ''
    const suggestions: Record<string, string> = {
      category: plan.filters.category,
      region,
      view: plan.filters.view,
      from: plan.filters.fromDate,
      to: plan.filters.toDate,
    }
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(suggestions)) {
      if (!next.get(key) && value) next.set(key, value)
    }
    next.delete('page')
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
  }, [draft.aiPlan, params, setParams])

  useEffect(() => {
    if (!keyword) { setLive(initialLive(false)); return }
    let cancelled = false
    setLive(initialLive(true))
    searchLostFound(keyword, 1, API_ROWS, hints)
      .then(payload => {
        if (cancelled) return
        setLive({
          raw: payload.items,
          fetched: payload.items.length,
          total: payload.total,
          apiPage: 1,
          loading: false,
          loadingMore: false,
          error: null,
          partial: payload.errors.length > 0,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error && error.message ? error.message : '검색 결과를 불러오지 못했어요.'
        setLive({ ...initialLive(false), error: message })
      })
    return () => { cancelled = true }
  }, [keyword, reloadToken, hintsKey])

  // 화면 표시용 중복 제거와 AI 맞춤 조건 적용을 누적된 전체 응답에 한 번에 적용한다(페이지 경계에도 안전).
  const liveItems = useMemo(() => dedupeLostFound(live.raw).map(item => toCandidate(item)), [live.raw])
  const criteriaResult = useMemo(() => applyCriteria(live.raw, criteria), [live.raw, criteria])
  const hasMore = live.fetched < live.total

  // 다음 페이지가 현재 받은 결과를 넘으면 API에서 다음 묶음을 이어 받는다.
  useEffect(() => {
    if (!keyword || live.loading || live.loadingMore || live.error) return
    if (loadingMoreRef.current || !hasMore) return
    const page = Math.max(1, Number(pageParam) || 1)
    if (liveItems.length >= page * 12) return
    const nextPage = live.apiPage + 1
    loadingMoreRef.current = true
    setLive(previous => ({ ...previous, loadingMore: true }))
    searchLostFound(keyword, nextPage, API_ROWS, hints)
      .then(payload => {
        setLive(previous => ({
          ...previous,
          raw: [...previous.raw, ...payload.items],
          fetched: previous.fetched + payload.items.length,
          total: payload.total,
          apiPage: nextPage,
          loadingMore: false,
          partial: previous.partial || payload.errors.length > 0,
        }))
      })
      .catch(() => setLive(previous => ({ ...previous, loadingMore: false })))
      .finally(() => { loadingMoreRef.current = false })
  }, [keyword, pageParam, live.loading, live.loadingMore, live.error, live.apiPage, liveItems.length, hasMore, hintsKey])

  // AI 순위는 현재 페이지 공개 후보만 보며, 나머지는 공개 JSON 조건 일치도 순을 유지한다.
  const imageSourceBase = filterCandidateRecords(criteriaResult.items.filter(item => item.photoStatus === 'verified_photo' && !!item.image), params)
  const contextSourceBase = filterCandidateRecords(criteriaResult.items, params)
  const contextPage = Math.max(1, Math.floor(Number(pageParam) || 1))
  const contextPageItems = contextSourceBase.slice((contextPage - 1) * 12, contextPage * 12)
  const contextPageLoaded = criteriaResult.items.length >= contextPage * 12 || !hasMore
  const rawByCandidateId = new Map(dedupeLostFound(live.raw).map(item => [toCandidate(item).id, item]))
  const contextPageCandidates = contextPageItems.flatMap(item => {
    const raw = rawByCandidateId.get(item.id)
    return raw ? [toAiContextRankCandidate(raw)] : []
  })
  const contextFilters = readLostResultFilters(params)
  const contextRankScope = JSON.stringify([
    keyword, hintsKey, draft.aiPlan?.originalQuery ?? draft.query, draft.aiPlan?.channels.context.query ?? draft.query,
    draft.aiPlan?.imageDescriptions ?? [], contextFilters, contextPage, reloadToken,
    contextPageCandidates.map(candidate => candidate.id),
  ])
  const rankScopeRef = useRef(contextRankScope)
  const activeRank = contextRank?.scope === contextRankScope ? contextRank.results : null
  const rankScores = new Map(activeRank?.map(result => [result.id, result.score]) ?? [])
  const imageSource = sortByRank(imageSourceBase, rankScores, criteriaResult.scores)
  const contextSource = sortByRank(contextSourceBase, rankScores, criteriaResult.scores)
  // 종합 채널도 이미지·문맥 채널과 동일하게 URL 필터와 JSON 조건을 적용한다.
  const combinedSource = sortByRank(filterCandidateRecords(uniqueGalleryItems(criteriaResult.items), params), rankScores, criteriaResult.scores)
  const suggestedFilters: [string, string][] = draft.aiPlan ? [
    ['category', draft.aiPlan.filters.category],
    ['region', draft.aiPlan.filters.region],
    ['view', draft.aiPlan.filters.view],
    ['from', draft.aiPlan.filters.fromDate],
    ['to', draft.aiPlan.filters.toDate],
  ] : []
  const planFiltersReady = suggestedFilters.every(([key, value]) => !value || !!params.get(key))
  useEffect(() => {
    consumeAutoRankRef.current = onConsumeAutoRankConsent
  }, [onConsumeAutoRankConsent])
  useEffect(() => {
    if (rankScopeRef.current === contextRankScope) return
    rankScopeRef.current = contextRankScope
    rankRequestSequence.current += 1
    autoRankConsumed.current = false
    setRankError('')
    setRankBusy(false)
  }, [contextRankScope])
  useEffect(() => {
    if (!autoRankContext || autoRankConsumed.current || live.loading || live.loadingMore || live.error || !contextPageLoaded || !planFiltersReady) return
    autoRankConsumed.current = true
    consumeAutoRankRef.current?.()
    if (!contextPageCandidates.length) return
    startContextRanking(contextRankScope, createContextRankInput(contextPageCandidates))
  }, [autoRankContext, contextRankScope, contextPageCandidates, contextPageLoaded, live.error, live.loading, live.loadingMore, planFiltersReady])
  const counts = { image: imageSource.length, context: contextSource.length }
  const statusFor = (which: LostResultChannel) => {
    const explicit = params.get('state') || params.get('combinedState') || params.get(which + 'State')
    if (explicit) return lostResultChannelState(params, which, counts)
    if (live.loading) return 'loading'
    if (live.error) return 'error'
    if (live.partial) return 'partial'
    return lostResultChannelState(params, which, counts)
  }

  function changeAssistant(patch: Partial<GalleryAssistantState>) { if (onAssistantChange) onAssistantChange(patch); else setLocalAssistant(previous => ({ ...previous, ...patch })) }
  function showAssistant(next: boolean) { changeAssistant({ open: next }); requestAnimationFrame(() => next ? input.current?.focus() : toggle.current?.focus()) }
  function startEditing(photoEdit = false) { setEditor({ draft: snapshotSearchDraft('lost', draft), photoEdit }); setEditorError(''); setEditNotice(''); if (!photoEdit) requestAnimationFrame(() => editorInput.current?.focus()) }
  function cancelEditing() { setEditor(null); setEditorError(''); requestAnimationFrame(() => editButton.current?.focus()) }
  function commitEditing(submittedDraft?: SearchDraft, autoRankConsent = false) {
    if (!editor) return
    const nextDraft = submittedDraft ?? editor.draft
    const problem = validateSearch('lost', nextDraft, null)
    if (problem) { setEditorError(problem === 'too-many-photos' ? `참고 사진은 ${MAX_LOST_REFERENCE_PHOTOS}장까지 추가할 수 있어요.` : copy.emptyInput); return }
    onCommitSearch(snapshotSearchDraft('lost', nextDraft), autoRankConsent)
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
  function retry() {
    const next = new URLSearchParams(params)
    for (const key of ['state', 'combinedState', 'imageState', 'contextState']) next.delete(key)
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
    setReloadToken(token => token + 1)
  }
  function changePage(page: number) { rememberScroll(); const next = new URLSearchParams(params); next.set('page', String(page)); setParams(next) }
  function createContextRankInput(candidates: AiContextRankCandidate[]): ContextRankInput {
    const filters = Object.fromEntries(Object.entries(contextFilters).filter(([, value]) => !!value))
    return {
      originalQuery: draft.aiPlan?.originalQuery || draft.query,
      searchQuery: draft.aiPlan?.channels.context.query || draft.aiPlan?.channels.combined.query || draft.query,
      imageDescriptions: draft.aiPlan?.imageDescriptions ?? [],
      filters,
      candidates,
    }
  }
  function startContextRanking(scope: string, request: ContextRankInput) {
    const requestId = ++rankRequestSequence.current
    setRankBusy(true)
    setRankError('')
    void rankLostContextCandidates(request).then(results => {
      if (requestId === rankRequestSequence.current) setContextRank({ scope, results })
    }).catch(cause => {
      if (requestId === rankRequestSequence.current) setRankError(cause instanceof Error ? cause.message : 'AI가 설명·장소 후보를 비교하지 못했어요.')
    }).finally(() => {
      if (requestId === rankRequestSequence.current) setRankBusy(false)
    })
  }
  function rankCurrentContext() {
    if (!contextPageCandidates.length) return
    startContextRanking(contextRankScope, createContextRankInput(contextPageCandidates))
  }
  function retryContextRanking() {
    if (!contextPageCandidates.length) return
    startContextRanking(contextRankScope, createContextRankInput(contextPageCandidates))
  }

  if (!draft.query.trim() && !getReferencePhotos(draft).length) return <main id="main-content" className="content-workspace"><PageHeading title="비슷한 물건 후보" /><EmptyState title="잃어버린 물건을 알려 주세요"><Link to="/lost-found" className="button button--primary">분실물 찾기</Link></EmptyState></main>

  function renderSection(which: LostResultChannel, full = false) {
    const status = statusFor(which)
    const items: Candidate[] = which === 'combined' ? combinedSource : which === 'image' ? imageSource : contextSource
    const pages = Math.max(1, Math.ceil(items.length / 12))
    // 마지막 페이지에서 '다음'을 누르면 페이지 번호를 먼저 올리고 API 추가 호출을 기다린다.
    const page = Math.max(1, Math.floor(Number(params.get('page')) || 1))
    const shown = full ? items.slice((page - 1) * 12, page * 12) : items.slice(0, GALLERY_PREVIEW_LIMIT)
    const sectionRank = which === 'context' && full ? activeRank : null
    const waitingForMore = full && page > pages && live.loadingMore
    const available = status === 'success' || status === 'partial'
    return <section className="gallery-result-section lost-result-section" key={which} aria-labelledby={id + '-' + which}>
      <div className="gallery-result-section__heading"><div><h2 id={id + '-' + which}>{titles[which]}</h2><p>{descriptions[which]}</p></div>{!full && available && items.length > GALLERY_PREVIEW_LIMIT && <Link className="gallery-result-section__more" to={linkTo(which)}>{titles[which]} 더보기<ArrowRight aria-hidden="true" /></Link>}</div>
      {status === 'partial' && <p className="lost-results__partial" role="status">일부 공개 정보를 불러오지 못했어요. 확인 가능한 결과를 보여드려요. <button type="button" onClick={() => retry()}>다시 시도</button></p>}
      {full && which === 'context' && available && contextPageCandidates.length > 0 && <div className="lost-context-ranker">
        <button type="button" className="button button--secondary" disabled={rankBusy} onClick={rankCurrentContext}><Sparkles aria-hidden="true" />{activeRank ? '다시 비교' : '비슷한 물건 찾기'}</button>
        <span>현재 페이지 공개 후보 {contextPageCandidates.length}개 · 원할 때만 분석</span>
      </div>}
      {status === 'loading' || waitingForMore ? <div className="gallery-result-grid" aria-busy="true" aria-label={titles[which] + ' 로딩 상태'}>{Array.from({ length: GALLERY_PREVIEW_LIMIT }, (_, index) => <div className="gallery-result-skeleton" key={index} />)}</div>
        : status === 'error' ? <EmptyState title="이 기준의 후보를 불러오지 못했어요" description="다른 검색 기준도 살펴볼 수 있어요." error><RetryButton onClick={() => retry()} /></EmptyState>
          : status === 'confirmation' ? <EmptyState title="검색 내용을 확인해 주세요" description="입력 확인이 필요한 상태의 화면 예시예요."><button type="button" className="button button--secondary" onClick={() => startEditing()}>검색 수정</button><RetryButton onClick={() => retry()} /></EmptyState>
            : status === 'empty' || !shown.length ? <EmptyState title="이 조건에 맞는 후보가 없어요" description="공개 정보가 없거나 부족할 수 있어요."><button type="button" className="button button--secondary" onClick={() => startEditing()}>검색 수정</button><a className="button button--secondary" href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">공식 검색 안내</a></EmptyState>
              : <>{full && (pages > 1 || hasMore) && <Pagination page={page} pages={pages} onChange={changePage} inputId={'lost-' + which + '-page-top'} position="top" allowBeyond={hasMore} />}
                <div className="gallery-result-grid lost-result-grid">{shown.map(item => <FoundCard key={item.id} item={item} to={'/lost-found/item/' + (item.source ?? 'police') + '/' + encodeURIComponent((item.atcId ?? item.id) + ':' + (item.fdSn ?? '1')) + '?back=' + encodeURIComponent(pageKey)} />)}</div>
                {sectionRank && <details className="lost-context-rank-details"><summary>AI 비교 근거와 장소 맥락 보기</summary><ol>{sectionRank.map(result => {
                  const item = shown.find(candidate => candidate.id === result.id)
                  return <li key={result.id}><strong>{item?.title ?? '공개 후보'} · 참고 점수 {result.score}/100</strong><ul>{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p><strong>{locationRelationLabels[result.locationRelation]}</strong>{result.locationEvidence ? ` · ${result.locationEvidence}` : ''}</p><p>{result.uncertainty}</p></li>
                })}</ol><p className="lost-context-rank-details__note">참고 점수는 일치 확률이 아니며, 같은 물건·소유권·회수를 확인하지 않습니다. 장소 추정은 공개 문구에 따른 가능성일 뿐이에요.</p></details>}
                {full && (pages > 1 || hasMore) && <Pagination page={page} pages={pages} onChange={changePage} inputId={'lost-' + which + '-page-bottom'} allowBeyond={hasMore} />}</>}
    </section>
  }
  const assistantToggle = <button type="button" className="button button--secondary" ref={toggle} aria-controls={id} aria-expanded={open} disabled={!!editor} onClick={() => showAssistant(!open)}><MessageSquare aria-hidden="true" />{open ? '도우미 접기' : '검색 도우미'}</button>
  const assistantPanel = <GallerySearchAssistant id={id} mode="lost" wide={wide} hideHeading={!wide} state={assistant} baseQuery={draft.query} inputRef={input} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} />
  return <div className={'gallery-search-shell lost-search-shell' + (wide && open ? ' gallery-search-shell--open' : '')}><main id="main-content" className="content-workspace gallery-results lost-results" onClickCapture={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0 && event.target instanceof Element && event.target.closest('a')) rememberScroll() }}>
    <PageHeading title={channel ? titles[channel] : '비슷한 물건 후보'} back={channel ? { to: linkTo(), label: '비슷한 물건 후보로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} action={wide ? assistantToggle : undefined} />
    {editor ? <div className="gallery-query-editor"><SearchComposer mode="lost" draft={editor.draft} error={editorError} textareaRef={editorInput} initialAttachmentOpen={editor.photoEdit} submitLabel="다시 검색" onDraft={patch => { setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous); setEditorError('') }} onSubmit={commitEditing} onError={setEditorError} secondaryAction={<button type="button" className="button button--secondary gallery-query-editor__cancel" onClick={cancelEditing}>취소</button>} />{editorError && <p id="search-error" className="form-error" role="alert">{editorError}</p>}</div>
      : <GalleryQuerySummary mode="lost" key={draft.query + ':' + getReferencePhotos(draft).map(localPhotoId).join('|')} draft={draft} editButtonRef={editButton} onEdit={startEditing} />}
    <p className="gallery-query-status" role="status">{editNotice}</p>
    <div className="gallery-results__toolbar"><p>검색 범위 · 경찰청 공개 습득물 정보</p>{!wide && assistantToggle}</div>
    {hasSearchCriteria(criteria) && !live.loading && !live.error && <div className="lost-ai-criteria" role="status">
      <p className="lost-ai-criteria__title">AI가 공개 정보에서 읽은 맞춤 조건</p>
      <div className="lost-ai-criteria__chips">{(['apiKeywords', 'include', 'any', 'exclude', 'imageFeatures'] as const).filter(key => criteria[key].length > 0).map(key => <span key={key} className={'lost-ai-criteria__chip lost-ai-criteria__chip--' + key}><strong>{criteriaLabels[key]}</strong>{criteria[key].join(' · ')}</span>)}</div>
      <p className="lost-ai-criteria__note">물품명·설명·특이사항·색상·습득 장소 같은 공개 정보를 기준으로 적용했어요. {criteriaResult.dropped > 0 && `NOT 조건에 걸린 ${criteriaResult.dropped}건을 제외하고, `}{criteriaResult.matched > 0 ? `${criteriaResult.matched}건이 조건과 일치해 먼저 보여드려요.` : '조건과 직접 일치하는 후보가 없어 넓은 검색 결과를 보여드려요.'}</p>
    </div>}
    <LostResultFilters />
    {rankBusy && <p className="lost-context-rank-status" role="status">AI가 공개 후보의 설명과 장소 정보를 비교해 관련도 순으로 정리하고 있어요.</p>}
    {rankError && <p className="lost-context-rank-status lost-context-rank-status--error" role="alert">{rankError}{contextPageCandidates.length > 0 && <> <button type="button" onClick={retryContextRanking}>다시 시도</button></>}</p>}
    {activeRank && !rankBusy && <p className="lost-context-rank-status" role="status">현재 페이지의 공개 후보 {activeRank.length}개를 AI 관련도 참고 순으로 정리했어요.</p>}
    {params.get('state') === 'stale' && <p className="inline-error">공식 기록이 변경된 상태 예시예요.</p>}
    <div className="gallery-results__sections">{channel ? renderSection(channel, true) : LOST_RESULT_CHANNELS.map(which => renderSection(which))}</div>
    <p className="field__help result-disclaimer">같은 물건인지와 보관 여부는 보관기관에 확인해 주세요. AI가 잘못 찾거나 놓칠 수 있고, 공개 정보가 부족하면 검색이 제한될 수 있어요.</p>
  </main>{wide ? open && <div className="gallery-assistant-dock">{assistantPanel}</div> : <Modal open={open} title="검색 도우미" focusKey={id} className="gallery-assistant-modal" initialFocus={input} onClose={() => showAssistant(false)}>{assistantPanel}</Modal>}
  </div>
}

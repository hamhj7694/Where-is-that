import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, MessageSquare, Sparkles } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import Modal from '../../components/Modal'
import SearchComposer from '../search/SearchComposer'
import { copy } from '../search/copy'
import { AiSearchPlanView } from '../search/AiSearchControls'
import { createGalleryAssistantState, GALLERY_PREVIEW_LIMIT, uniqueGalleryItems, type GalleryAssistantState } from '../search/gallery-search-model'
import { getReferencePhotos, snapshotSearchDraft, validateSearch, MAX_LOST_REFERENCE_PHOTOS, type SearchDraft } from '../search/model'
import { LOST_RESULT_CHANNELS, combinedLostScore, filterCandidateRecords, lostResultChannelState, readLostResultFilters, sortByRankTier, type LostResultChannel } from '../search/lost-result-model'
import type { Candidate } from '../search/catalog-model'
import { compactFoundItems, searchLostFound, toCandidate, type FoundItem, type LostSearchHints } from '../search/lostfound-api'
import { checkLostPhotos, uniqueLostPhotos } from '../search/lost-photo-deduplication'
import { readLostResultsSnapshot, saveLostResultsSnapshot, type LostResultsSnapshot } from '../search/history'
import { matchPublicItemImages, rankLostContextCandidates, type AiContextRankCandidate, type AiContextRankedCandidate, type AiLocationRelation, type AiVisualMatchResult } from '../search/ai-search-api'
import { criteriaFromPlan, criteriaToHints, criteriaLabels, hasSearchCriteria, matchPublicItem, resolveApiKeyword, type AiSearchCriteria } from '../search/ai-match-model'
import { AiSearching, EmptyState, FoundCard, PageHeading, Pagination, RetryButton } from './components'
import { localPhotoId, OFFICIAL_SEARCH_URL } from './data'
import { minimumWait, withMinimumVisible } from './ai-loading'
import GalleryQuerySummary from './GalleryQuerySummary'
import GallerySearchAssistant from './GallerySearchAssistant'
import AiQueryOptimizer from './AiQueryOptimizer'
import LostResultFilters from './LostResultFilters'
import PublicSearchScope from './PublicSearchScope'
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
const titles = { combined: '추천 후보', image: '사진이 닮은 후보', context: '설명이 잘 맞는 후보' }
const descriptions = { combined: '적어둔 내용과 사진 특징을 함께 살펴봤어요.', image: '색상·모양 등 사진의 특징을 살펴보세요.', context: '물건 설명과 습득 정보를 살펴보세요.' }
const scrollPositions = new Map<string, number>()
const API_ROWS = 40
const VISUAL_BATCH_ROWS = 12
const VISUAL_PARALLEL_BATCHES = 2
const NO_RANK_SCORES = new Map<string, number>()
const VISUAL_MATCH_MIN = 40
const VISUAL_ROUND_LIMIT = 96

interface LiveState {
  raw: FoundItem[]
  photoRaw: FoundItem[]
  contextRaw: FoundItem[]
  fetched: number
  total: number
  apiPage: number
  hasMore?: boolean
  scanLimitReached?: boolean
  coverage?: LostResultsSnapshot['coverage']
  periodCursor?: LostResultsSnapshot['periodCursor']
  loading: boolean
  loadingMore: boolean
  moreFailed?: boolean
  error: string | null
  partial: boolean
}
const initialLive = (loading: boolean): LiveState => ({ raw: [], photoRaw: [], contextRaw: [], fetched: 0, total: 0, apiPage: 0, loading, loadingMore: false, error: null, partial: false })
type ContextRankInput = Parameters<typeof rankLostContextCandidates>[0]
const locationRelationLabels: Record<AiLocationRelation, string> = {
  direct_match: '습득 장소 직접 일치',
  possible_nearby: '주변 지역 가능성',
  regional_context: '넓은 지역 맥락',
  uncertain: '장소 근거 불확실',
  not_applicable: '장소 조건 없음',
}

function toVisualMatchCandidate(item: FoundItem): { id: string; imageUrl: string; text: string } {
  const candidate = toCandidate(item)
  return {
    id: candidate.id,
    imageUrl: item.imageUrl ?? '',
    text: [item.name, item.subject, item.notes, item.color, item.category].filter(Boolean).join(' ').slice(0, 2000),
  }
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
}

/** AI가 해석한 특징은 순위에 반영하고, 필터로 선택하지 않은 후보는 남긴다. */
function applyCriteria(raw: readonly FoundItem[], criteria: AiSearchCriteria): CriteriaResult {
  const entries = uniqueGalleryItems(raw).map(item => {
    const match = matchPublicItem(item, criteria)
    return { candidate: toCandidate(item), match, score: match.excludedBy ? -1 : match.score }
  })
  entries.sort((left, right) => right.score - left.score)
  return {
    items: entries.map(entry => entry.candidate),
    scores: new Map(entries.map(entry => [entry.candidate.id, entry.score])),
    hits: new Map(entries.filter(entry => !entry.match.excludedBy).map(entry => [entry.candidate.id, entry.match.hits])),
  }
}

function newPhotosInResults(previous: readonly FoundItem[], incoming: readonly FoundItem[], fingerprints: ReadonlyMap<string, string>) {
  const previousIds = new Set(previous.map(item => item.id))
  const distinct = uniqueLostPhotos(uniqueGalleryItems([...previous, ...incoming]), item => item.imageUrl, fingerprints)
  return distinct.filter(item => !previousIds.has(item.id))
}

function useWideResults() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches)
  useEffect(() => { const media = window.matchMedia('(min-width: 1100px)'); const change = () => setWide(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change) }, [])
  return wide
}

export default function LostSearchResults({ draft, channel, fromHistory, autoRankContext, onConsumeAutoRankConsent, assistant: savedAssistant, onAssistantChange, onRefine, onCommitSearch }: Props) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const criteria = useMemo(() => criteriaFromPlan(draft.aiPlan, draft.query), [draft.aiPlan, draft.query])
  const aiFromDate = draft.aiPlan?.filters.fromDate ?? ''
  const aiToDate = draft.aiPlan?.filters.toDate ?? ''
  const hints = useMemo<LostSearchHints>(() => ({
    ...criteriaToHints(criteria),
    ...(aiFromDate || aiToDate ? { fromDate: aiFromDate, toDate: aiToDate } : {}),
  }), [criteria, aiFromDate, aiToDate])
  const hintsKey = useMemo(() => JSON.stringify(hints), [hints])
  const keyword = resolveApiKeyword(criteria, draft.aiPlan?.channels.combined.query || draft.aiPlan?.channels.image.query || draft.query)
  const references = getReferencePhotos(draft)
  const originalQuery = draft.query.trim().slice(0, 100)
  const photoCategory = draft.aiPlan?.filters.category || ''
  const { from: selectedFrom, to: selectedTo } = readLostResultFilters(params)
  const photoOptions = useMemo(() => ({
    originalQuery, photoSearch: true, photoCategory, periodSearch: true, fromDate: selectedFrom, toDate: selectedTo,
  }), [originalQuery, photoCategory, selectedFrom, selectedTo])
  const recordId = new URLSearchParams(location.search).get('record')
  // 기록은 id 기준, 아직 저장되지 않은 검색은 조건 기준으로 스냅샷을 찾는다.
  const snapshotKey = recordId ? 'record:' + recordId : 'query:' + keyword + ':' + hintsKey
  const previousSnapshot = useMemo(() => readLostResultsSnapshot(snapshotKey), [snapshotKey])
  const restoredSnapshot = previousSnapshot?.keyword === keyword && previousSnapshot.hintsKey === hintsKey ? previousSnapshot : null
  const [localAssistant, setLocalAssistant] = useState(createGalleryAssistantState)
  const [editor, setEditor] = useState<{ draft: SearchDraft; photoEdit: boolean } | null>(null)
  const [editorError, setEditorError] = useState('')
  const [editNotice, setEditNotice] = useState('')
  const [rankBusy, setRankBusy] = useState(false)
  const [rankError, setRankError] = useState('')
  const [contextRank, setContextRank] = useState<{ scope: string; results: AiContextRankedCandidate[] } | null>(restoredSnapshot?.rank ?? null)
  const [visualMatch, setVisualMatch] = useState<LostResultsSnapshot['visual']>(restoredSnapshot?.visual)
  const [visualBusy, setVisualBusy] = useState(false)
  const [visualError, setVisualError] = useState('')
  const wide = useWideResults()
  const id = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const editorInput = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const restoringScroll = useRef(true)
  const rankRequestSequence = useRef(0)
  const visualRequestSequence = useRef(0)
  const visualScopeRef = useRef('')
  const visualAutoConsumed = useRef(false)
  const externalPhotoConsent = useRef<SearchDraft | null>(null)
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

  // 샘플 후보 대신 경찰청 공개 API 결과를 사용한다. 기록이 있으면 검색 시점 결과를 그대로 복원한다.
  const [live, setLive] = useState<LiveState>(() => restoredSnapshot ? {
    raw: restoredSnapshot.raw,
    photoRaw: restoredSnapshot.photoRaw ?? [],
    contextRaw: restoredSnapshot.contextRaw ?? [],
    fetched: restoredSnapshot.fetched,
    total: restoredSnapshot.total,
    apiPage: restoredSnapshot.apiPage,
    hasMore: restoredSnapshot.hasMore,
    scanLimitReached: restoredSnapshot.scanLimitReached,
    coverage: restoredSnapshot.coverage,
    periodCursor: restoredSnapshot.periodCursor,
    loading: false,
    loadingMore: false,
    error: null,
    partial: restoredSnapshot.partial,
  } : initialLive(true))
  const [reloadToken, setReloadToken] = useState(0)
  const [newItems, setNewItems] = useState<FoundItem[]>(() => restoredSnapshot?.newRaw ?? [])
  const [photoFingerprints, setPhotoFingerprints] = useState<ReadonlyMap<string, string>>(() => new Map())
  const photoUrls = useMemo(() => {
    const relevantIds = new Set(visualMatch?.results.filter(result => result.basis === 'photo' && result.imageSimilarity >= VISUAL_MATCH_MIN).map(result => result.id))
    return [...live.raw, ...live.contextRaw, ...live.photoRaw.filter(item => relevantIds.has(toCandidate(item).id)), ...newItems].map(item => item.imageUrl)
  }, [live.raw, live.contextRaw, live.photoRaw, newItems, visualMatch])
  useEffect(() => {
    const controller = new AbortController()
    void Promise.resolve().then(() => checkLostPhotos(photoUrls, controller.signal, batch => {
      setPhotoFingerprints(previous => new Map([...previous, ...batch]))
    })).catch(() => { /* Unchecked photos keep their existing cards. */ })
    return () => controller.abort()
  }, [photoUrls])
  const visibleNewItems = useMemo(
    () => newPhotosInResults(live.raw, newItems, photoFingerprints),
    [live.raw, newItems, photoFingerprints],
  )
  const [baselineIds, setBaselineIds] = useState<string[]>(() => restoredSnapshot?.baselineIds ?? [])
  const [lastRefreshAt, setLastRefreshAt] = useState<number | undefined>(() => restoredSnapshot?.lastRefreshAt)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNotice, setRefreshNotice] = useState<{ message: string; error?: boolean } | null>(null)
  const pageParam = params.get('page')
  const searchRequest = useRef<{ ready: boolean; loadingMore: boolean; refreshing: boolean; autoPage?: string } | null>(null)
  const restoredSnapshotRef = useRef(restoredSnapshot)
  const initialDraft = useRef(draft)

  useEffect(() => {
    const current = { ready: false, loadingMore: false, refreshing: false }
    searchRequest.current = current
    const dispose = () => { if (searchRequest.current === current) searchRequest.current = null }
    setRefreshing(false)
    setRefreshNotice(null)
    // 기록을 열었으면 저장된 응답을 그대로 쓴다. 다시 공개 API를 호출하지 않는다.
    const snapshot = restoredSnapshotRef.current
    const snapshotFilters = readLostResultFilters(new URLSearchParams(snapshot?.params))
    if (snapshot && draft === initialDraft.current && snapshot.keyword === keyword && snapshot.hintsKey === hintsKey
      && snapshotFilters.from === selectedFrom && snapshotFilters.to === selectedTo) {
      current.ready = true
      return dispose
    }
    restoredSnapshotRef.current = null
    setContextRank(null)
    setVisualMatch(undefined)
    setNewItems([])
    setBaselineIds([])
    setLastRefreshAt(undefined)
    if (!keyword && !originalQuery && !references.length) { setLive(initialLive(false)); return dispose }
    setLive(initialLive(true))
    searchLostFound(keyword, 1, API_ROWS, hints, photoOptions)
      .then(payload => {
        if (searchRequest.current !== current) return
        current.ready = true
        setLive({
          raw: payload.items,
          photoRaw: payload.photoItems ?? [],
          contextRaw: payload.contextItems ?? [],
          fetched: payload.items.length,
          total: payload.total,
          apiPage: 1,
          hasMore: payload.hasMore ?? undefined,
          scanLimitReached: payload.scanLimitReached,
          coverage: payload.coverage ?? undefined,
          periodCursor: payload.periodCursor ?? undefined,
          loading: false,
          loadingMore: false,
          error: null,
          partial: payload.errors.length > 0,
        })
      })
      .catch((error: unknown) => {
        if (searchRequest.current !== current) return
        const message = error instanceof Error && error.message ? error.message : '검색 결과를 불러오지 못했어요.'
        setLive({ ...initialLive(false), error: message })
      })
    return dispose
  }, [draft, keyword, reloadToken, hintsKey, photoOptions])

  // 화면 표시용 중복 제거와 AI 맞춤 조건 적용을 누적된 전체 응답에 한 번에 적용한다(페이지 경계에도 안전).
  const criteriaResult = useMemo(() => applyCriteria([...live.raw, ...live.contextRaw], criteria), [live.raw, live.contextRaw, criteria])
  const hasMore = live.hasMore ?? (live.fetched < live.total)

  // 검색이 확정되면 그 시점의 결과를 기록에 붙여 둔다. 이후 같은 기록을 열어도 재조회하지 않는다.
  useEffect(() => {
    if (!searchRequest.current?.ready || live.loading || live.loadingMore || live.error || !live.apiPage) return
    const baseline = baselineIds.length
      ? baselineIds
      : uniqueGalleryItems(live.raw).map(item => toCandidate(item).id)
    const snapshot: LostResultsSnapshot = {
      version: 1,
      savedAt: Date.now(),
      keyword,
      hintsKey,
      params: params.toString(),
      raw: compactFoundItems(live.raw),
      photoRaw: compactFoundItems(live.photoRaw),
      contextRaw: compactFoundItems(live.contextRaw),
      fetched: live.fetched,
      total: live.total,
      apiPage: live.apiPage,
      hasMore: live.hasMore,
      scanLimitReached: live.scanLimitReached,
      coverage: live.coverage,
      periodCursor: live.periodCursor,
      partial: live.partial,
      ...(contextRank ? { rank: { scope: contextRank.scope, results: contextRank.results } } : {}),
      ...(visualMatch ? { visual: visualMatch } : {}),
      textScores: [...criteriaResult.scores],
      baselineIds: baseline,
      newRaw: compactFoundItems(newItems),
      lastRefreshAt,
    }
    saveLostResultsSnapshot(snapshotKey, snapshot)
  }, [snapshotKey, keyword, hintsKey, params, live, baselineIds, contextRank, visualMatch, criteriaResult.scores, newItems, lastRefreshAt])

  const loadNextPage = useCallback(() => {
    const current = searchRequest.current
    if (!current?.ready || current.loadingMore || live.loading || live.error || !hasMore) return
    const nextPage = live.apiPage + 1
    current.loadingMore = true
    setLive(previous => ({ ...previous, loadingMore: true, moreFailed: false }))
    const showMoreFailure = () => {
      if (searchRequest.current !== current) return
      current.loadingMore = false
      setLive(previous => ({ ...previous, loadingMore: false, moreFailed: true }))
    }
    searchLostFound(keyword, Math.min(nextPage, 100), API_ROWS, hints, { ...photoOptions, periodCursor: live.periodCursor })
      .then(payload => {
        if (searchRequest.current !== current) return
        if (!payload.items.length && !payload.photoItems?.length && !payload.contextItems?.length && payload.errors.length > 0) return showMoreFailure()
        current.loadingMore = false
        setLive(previous => ({
          ...previous,
          raw: uniqueGalleryItems([...previous.raw, ...payload.items]),
          photoRaw: uniqueGalleryItems([...(payload.photoItems ?? []), ...previous.photoRaw]),
          contextRaw: uniqueGalleryItems([...previous.contextRaw, ...(payload.contextItems ?? [])]),
          fetched: previous.fetched + payload.items.length,
          total: previous.total + payload.total,
          apiPage: nextPage,
          hasMore: payload.hasMore ?? (payload.items.length ? undefined : false),
          scanLimitReached: payload.scanLimitReached,
          coverage: payload.coverage ?? undefined,
          periodCursor: payload.periodCursor ?? undefined,
          loadingMore: false,
          partial: payload.errors.length > 0,
        }))
      })
      .catch(showMoreFailure)
  }, [keyword, live.loading, live.error, live.apiPage, live.periodCursor, hasMore, hintsKey, photoOptions])

  // 설명은 이름·원문으로 찾은 후보를 보고, 사진은 별도로 받은 목록까지 비교한다.
  const contextSourceBase = filterCandidateRecords(criteriaResult.items, params)
  const contextPage = Math.max(1, Math.floor(Number(pageParam) || 1))
  const contextPageItems = contextSourceBase.slice((contextPage - 1) * 12, contextPage * 12)
  const contextPageLoaded = !!live.apiPage && (!channel || contextSourceBase.length >= contextPage * 12 || !hasMore)
  const rawByCandidateId = new Map(uniqueGalleryItems([...live.raw, ...live.contextRaw, ...live.photoRaw]).map(item => [toCandidate(item).id, item]))
  const keywordIds = new Set(live.raw.map(item => toCandidate(item).id))
  const contextPageCandidates = contextPageItems.flatMap(item => {
    const raw = rawByCandidateId.get(item.id)
    return raw ? [toAiContextRankCandidate(raw)] : []
  })
  // 이름과 독립적으로 가져온 사진을 먼저 확인하고, 나머지 사진도 이어서 비교한다.
  const photoPool = uniqueGalleryItems([...live.photoRaw, ...rawByCandidateId.values()])
  const photoCandidates = filterCandidateRecords(photoPool.map(item => toCandidate(item))
    .filter(item => item.photoStatus === 'verified_photo' && !!item.image), params)
  const visualCandidates = photoCandidates.map(item => toVisualMatchCandidate(rawByCandidateId.get(item.id)!))
  const visualSearchKey = JSON.stringify([keyword, hintsKey, originalQuery, references.map(localPhotoId)])
  const visualRankScope = JSON.stringify([
    visualSearchKey, reloadToken, visualCandidates.map(candidate => candidate.id),
  ])
  const contextFilters = readLostResultFilters(params)
  const contextRankScope = JSON.stringify([
    keyword, hintsKey, draft.aiPlan?.originalQuery ?? draft.query, draft.aiPlan?.channels.context.query ?? draft.query,
    draft.aiPlan?.imageDescriptions ?? [], contextFilters, contextPage, reloadToken,
    contextPageCandidates.map(candidate => candidate.id),
  ])
  const rankScopeRef = useRef(contextRankScope)
  const rankRequestedScopeRef = useRef('')
  const visualRequestedScopeRef = useRef('')
  // 새 scope 분석을 기다리는 동안에도 이미 찾은 AI 점수는 정렬에 이어 쓴다.
  const lastRankRef = useRef<{ scope: string; results: AiContextRankedCandidate[] } | null>(contextRank)
  if (contextRank) lastRankRef.current = contextRank
  const activeRank = contextRank?.scope === contextRankScope ? contextRank.results : null
  const activeVisual = visualMatch && (!visualMatch.searchKey || visualMatch.searchKey === visualSearchKey)
    ? visualMatch.results : null
  const scoredPhotoIds = new Set(activeVisual?.map(result => result.id))
  const uncheckedPhotos = visualCandidates.filter(candidate => !scoredPhotoIds.has(candidate.id)).length
  const rankScores = new Map((activeRank ?? lastRankRef.current?.results ?? []).map(result => [result.id, result.score]))
  const visualScores = new Map((activeVisual ?? []).filter(result => result.basis === 'photo' && result.imageSimilarity >= VISUAL_MATCH_MIN)
    .map(result => [result.id, result.imageSimilarity]))
  // 부분 문자열 텍스트 점수는 AI 점수와 같은 눈금으로 경쟁하지 않게 상한을 둔다.
  const textScores = new Map([...criteriaResult.scores].map(([itemId, score]) => [itemId, Math.min(score, 39)]))
  const imageSourceBase = photoCandidates.filter(item => visualScores.has(item.id)
    || (!activeVisual?.length && keywordIds.has(item.id)))
  const imageSource = uniqueLostPhotos(sortByRankTier(imageSourceBase, visualScores, NO_RANK_SCORES, textScores), item => item.image, photoFingerprints)
  const contextSource = uniqueLostPhotos(sortByRankTier(contextSourceBase, rankScores, NO_RANK_SCORES, textScores), item => item.image, photoFingerprints)
  const combinedCandidates = uniqueGalleryItems([...contextSourceBase, ...imageSourceBase])
  const combinedScores = new Map<string, number>()
  for (const item of combinedCandidates) {
    const visual = visualScores.get(item.id)
    const context = rankScores.get(item.id)
    // 사진이나 설명 한쪽만 있어도 높은 근거는 그대로 반영한다.
    if (visual !== undefined || context !== undefined) {
      combinedScores.set(item.id, combinedLostScore(visual, context))
    }
  }
  const combinedSource = uniqueLostPhotos(
    sortByRankTier(combinedCandidates, combinedScores, NO_RANK_SCORES, textScores),
    item => item.image, photoFingerprints,
  )
  const matchedCandidates = combinedSource.filter(item => criteriaResult.hits.get(item.id)?.length).length
  const channelLength = channel === 'combined' ? combinedSource.length : channel === 'image' ? imageSource.length : contextSource.length
  const channelPages = Math.max(1, Math.ceil(channelLength / 12))
  useEffect(() => {
    const current = searchRequest.current
    if (!channel || !current?.ready || live.loading || live.loadingMore || live.moreFailed || live.error || contextPage <= channelPages) return
    if (!hasMore) {
      setParams(previous => {
        const next = new URLSearchParams(previous)
        next.set('page', String(channelPages))
        return next
      }, { replace: true })
      return
    }
    const target = channel + ':' + contextPage
    if (current.autoPage === target) return
    // A sparse result may contain no matches. Continue on a click rather than
    // silently scanning every remaining upstream page in the background.
    current.autoPage = target
    loadNextPage()
  }, [channel, channelPages, contextPage, hasMore, live.loading, live.loadingMore, live.moreFailed, live.error, loadNextPage, setParams])
  useEffect(() => {
    consumeAutoRankRef.current = onConsumeAutoRankConsent
  }, [onConsumeAutoRankConsent])
  // 다른 검색으로 바뀌면 이전 검색의 AI 점수를 새 후보에 적용하지 않는다.
  useEffect(() => {
    lastRankRef.current = null
  }, [keyword, reloadToken])
  useEffect(() => {
    if (rankScopeRef.current === contextRankScope) return
    rankScopeRef.current = contextRankScope
    rankRequestSequence.current += 1
    autoRankConsumed.current = false
    setRankError('')
    setRankBusy(false)
  }, [contextRankScope])
  useEffect(() => {
    if (contextRank?.scope === contextRankScope) return
    if (!autoRankContext || autoRankConsumed.current || live.loading || live.loadingMore || live.error || !contextPageLoaded) return
    autoRankConsumed.current = true
    consumeAutoRankRef.current?.()
    if (!contextPageCandidates.length) return
    startContextRanking(contextRankScope, createContextRankInput(contextPageCandidates))
  }, [autoRankContext, contextRankScope, contextPageCandidates, contextPageLoaded, live.error, live.loading, live.loadingMore])
  useEffect(() => {
    if (visualScopeRef.current === visualRankScope) return
    visualScopeRef.current = visualRankScope
    visualRequestSequence.current += 1
    visualAutoConsumed.current = false
    setVisualError('')
    setVisualBusy(false)
  }, [visualRankScope])
  useEffect(() => {
    if (autoRankContext) externalPhotoConsent.current = draft
    if (visualMatch?.scope === visualRankScope || visualAutoConsumed.current || externalPhotoConsent.current !== draft) return
    if (live.loading || live.loadingMore || live.error || !visualCandidates.length) return
    const scored = new Set(activeVisual?.map(result => result.id))
    if (visualCandidates.every(candidate => scored.has(candidate.id))) return
    visualAutoConsumed.current = true
    startVisualRanking(visualRankScope)
  }, [autoRankContext, draft, visualRankScope, live.error, live.loading, live.loadingMore])
  const counts = { image: imageSource.length, context: contextSource.length }
  const statusFor = (which: LostResultChannel) => {
    const explicit = params.get('state') || params.get('combinedState') || params.get(which + 'State')
    if (explicit) return lostResultChannelState(params, which, counts)
    if (live.loading) return 'loading'
    if (live.error) return 'error'
    if (live.partial) return 'partial'
    return lostResultChannelState(params, which, counts)
  }
  // 채널마다 자기 AI 작업이 끝나는 대로 결과를 보여준다. 다른 채널을 기다리지 않는다.
  const rankRunning = rankRequestedScopeRef.current === contextRankScope && rankBusy
  const visualRunning = visualRequestedScopeRef.current === visualRankScope && visualBusy
  const channelBusy: Record<LostResultChannel, boolean> = {
    combined: live.loading || ((rankRunning || visualRunning) && !combinedScores.size),
    context: live.loading || rankRunning,
    image: live.loading || (visualRunning && !visualScores.size),
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
    restoredSnapshotRef.current = null
    setReloadToken(token => token + 1)
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
    restoredSnapshotRef.current = null
    setReloadToken(token => token + 1)
  }
  async function refreshResults() {
    const current = searchRequest.current
    if (!current?.ready || current.refreshing) return
    current.refreshing = true
    setRefreshing(true)
    setRefreshNotice(null)
    try {
      // 같은 조건으로 최신 공개 목록을 다시 읽어 이전에 보지 못한 항목만 가려낸다.
      const payload = await searchLostFound(keyword, 1, API_ROWS, hints, photoOptions)
      if (searchRequest.current !== current) return
      const known = new Set(baselineIds.length
        ? baselineIds
        : live.raw.map(item => toCandidate(item).id))
      const unseen = payload.items.filter(item => !known.has(toCandidate(item).id))
      const checked = unseen.length
        ? await checkLostPhotos([...live.raw, ...newItems, ...unseen].map(item => item.imageUrl))
        : photoFingerprints
      if (searchRequest.current !== current) return
      const fingerprints = new Map([...photoFingerprints, ...checked])
      const additions = newPhotosInResults([...live.raw, ...newItems], unseen, fingerprints)
      setPhotoFingerprints(previous => new Map([...previous, ...checked]))
      setLive(previous => ({
        ...previous,
        photoRaw: uniqueGalleryItems([...previous.photoRaw, ...(payload.photoItems ?? [])]),
        contextRaw: uniqueGalleryItems([...previous.contextRaw, ...(payload.contextItems ?? [])]),
      }))
      setNewItems(additions)
      setBaselineIds([...known, ...unseen.map(item => toCandidate(item).id)])
      setLastRefreshAt(Date.now())
      setRefreshNotice({
        message: additions.length > 0 ? `새 후보 ${additions.length}건을 찾았어요.`
          : payload.errors.length > 0 ? '확인한 공개 목록에 새 후보가 없어요. 일부 목록은 불러오지 못했어요.'
            : '새로 확인된 후보가 없어요.',
      })
    } catch {
      if (searchRequest.current === current) setRefreshNotice({ message: '새 후보를 확인하지 못했어요. 다시 시도해 주세요.', error: true })
    } finally {
      if (searchRequest.current === current) {
        current.refreshing = false
        setRefreshing(false)
      }
    }
  }
  function includeNewItems() {
    if (!visibleNewItems.length) return
    setLive(previous => ({ ...previous, raw: [...visibleNewItems, ...previous.raw], fetched: previous.fetched + visibleNewItems.length }))
    setNewItems([])
    setBaselineIds([...baselineIds, ...newItems.map(item => toCandidate(item).id)])
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
    rankRequestedScopeRef.current = scope
    const requestId = ++rankRequestSequence.current
    const startedAt = Date.now()
    setRankBusy(true)
    setRankError('')
    void withMinimumVisible(startedAt, rankLostContextCandidates(request)).then(results => {
      if (requestId === rankRequestSequence.current) setContextRank({ scope, results })
    }).catch(cause => {
      if (requestId === rankRequestSequence.current) setRankError(cause instanceof Error ? cause.message : '설명·장소 후보를 비교하지 못했어요.')
    }).finally(() => {
      if (requestId === rankRequestSequence.current) setRankBusy(false)
    })
  }
  async function startVisualRanking(scope: string) {
    if (!visualCandidates.length) return
    visualRequestedScopeRef.current = scope
    const requestId = ++visualRequestSequence.current
    const startedAt = Date.now()
    setVisualBusy(true)
    setVisualError('')
    const previous = visualMatch?.searchKey === visualSearchKey ? visualMatch : undefined
    const results = new Map<string, AiVisualMatchResult>(previous?.results.map(result => [result.id, result]))
    const unchecked = visualCandidates.filter(candidate => !results.has(candidate.id))
    const candidatesToCheck = (unchecked.length ? unchecked : visualCandidates).slice(0, VISUAL_ROUND_LIMIT)
    // 새 AI 검색은 공식 사진을 직접 비교한다. 저장한 기록에서 다시 비교할 땐 로컬로 처리한다.
    const localOnly = externalPhotoConsent.current !== draft
    let source = previous?.source ?? 'multimodal'
    try {
      let incomplete = false
      const windowSize = VISUAL_BATCH_ROWS * VISUAL_PARALLEL_BATCHES
      for (let start = 0; start < candidatesToCheck.length; start += windowSize) {
        if (requestId !== visualRequestSequence.current) return
        const chunks = [candidatesToCheck.slice(start, start + VISUAL_BATCH_ROWS)]
        const next = candidatesToCheck.slice(start + VISUAL_BATCH_ROWS, start + windowSize)
        if (next.length) chunks.push(next)
        await Promise.allSettled(chunks.map(async candidates => {
          try {
            const reply = await matchPublicItemImages({
              query: draft.aiPlan?.originalQuery || draft.query || draft.aiPlan?.channels.image.query || '',
              imageFeatures: criteria.imageFeatures,
              references,
              candidates,
              photoOnly: true,
              localOnly,
              preferSemantic: !!originalQuery,
            })
            if (requestId !== visualRequestSequence.current) return
            for (const result of reply.results) results.set(result.id, result)
            source = reply.source
            if (reply.results.length < candidates.length) incomplete = true
            setVisualMatch({ scope, searchKey: visualSearchKey, results: [...results.values()], source })
          } catch {
            incomplete = true
          }
        }))
      }
      if (requestId !== visualRequestSequence.current) return
      setVisualMatch({ scope, searchKey: visualSearchKey, results: [...results.values()], source })
      if (incomplete || !results.size) setVisualError('일부 공개 사진을 비교하지 못했어요.')
    } finally {
      await minimumWait(startedAt)
      if (requestId === visualRequestSequence.current) setVisualBusy(false)
    }
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
    const modelScores = which === 'combined' ? combinedScores : which === 'image' ? visualScores : rankScores
    const modelBasis = which === 'combined' ? 'AI 추천' : which === 'image' ? 'AI 사진' : 'AI 설명'
    const pages = Math.max(1, Math.ceil(items.length / 12))
    // 마지막 페이지에서 '다음'을 누르면 페이지 번호를 먼저 올리고 API 추가 호출을 기다린다.
    const page = Math.max(1, Math.floor(Number(params.get('page')) || 1))
    const shown = full ? items.slice((page - 1) * 12, page * 12) : items.slice(0, GALLERY_PREVIEW_LIMIT)
    const sectionRank = which === 'context' && full ? activeRank : null
    const waitingForMore = full && !shown.length && live.loadingMore
    const failedBeyondLastPage = full && page > pages && live.moreFailed
    const busy = channelBusy[which]
    const available = (status === 'success' || status === 'partial') && !busy
    return <section className="gallery-result-section lost-result-section" key={which} aria-labelledby={id + '-' + which}>
      <div className="gallery-result-section__heading"><div><h2 id={id + '-' + which}>{titles[which]}</h2><p>{descriptions[which]}</p></div>{!full && (available || status === 'empty') && (items.length > GALLERY_PREVIEW_LIMIT || hasMore) && <Link className="gallery-result-section__more" to={linkTo(which)}>{titles[which]} 더보기<ArrowRight aria-hidden="true" /></Link>}</div>
      {full && page <= pages && live.moreFailed && <p className="lost-results__partial" role="alert">추가 후보를 불러오지 못했어요. <button type="button" onClick={loadNextPage}>다시 시도</button></p>}
      {full && which === 'context' && available && contextPageCandidates.length > 0 && <div className="lost-context-ranker">
        <button type="button" className="button button--secondary" disabled={rankBusy} onClick={rankCurrentContext}><Sparkles aria-hidden="true" />{activeRank ? '다시 비교' : '비슷한 물건 찾기'}</button>
        <span>이 페이지 후보 {contextPageCandidates.length}개 · 원할 때만 비교</span>
      </div>}
      {full && which === 'image' && !live.loading && !live.error && visualCandidates.length > 0 && <div className="lost-context-ranker">
        <button type="button" className="button button--secondary" disabled={visualBusy} onClick={() => startVisualRanking(visualRankScope)}><Sparkles aria-hidden="true" />{activeVisual ? uncheckedPhotos ? '남은 사진 비교' : '다시 비교' : '사진 특징으로 비교'}</button>
        <span>공개 사진 {visualCandidates.length - uncheckedPhotos}/{visualCandidates.length}장 비교</span>
      </div>}
      {status === 'loading' || waitingForMore || busy ? <AiSearching compact label={status === 'loading' ? '공개 후보를 살펴보고 있어요' : '후보 순서를 정리하고 있어요'} />
        : failedBeyondLastPage ? <EmptyState title="다음 페이지를 불러오지 못했어요" error>
          <button type="button" className="button button--primary" onClick={loadNextPage}>다시 시도</button>
          <button type="button" className="button button--secondary" onClick={() => changePage(pages)}>이전 결과 보기</button>
        </EmptyState>
        : status === 'error' ? <EmptyState title="이 기준의 후보를 불러오지 못했어요" description="다른 검색 기준도 살펴볼 수 있어요." error><RetryButton onClick={() => retry()} /></EmptyState>
          : status === 'confirmation' ? <EmptyState title="검색 내용을 확인해 주세요" description="입력 확인이 필요한 상태의 화면 예시예요."><button type="button" className="button button--secondary" onClick={() => startEditing()}>검색 수정</button><RetryButton onClick={() => retry()} /></EmptyState>
            : status === 'empty' || !shown.length ? <EmptyState title={hasMore ? '확인한 범위에 맞는 후보가 없어요' : '이 조건에 맞는 후보가 없어요'} description={hasMore ? undefined : '뒤늦게 등록되거나 공개 목록에 없는 물건이 있을 수 있어요.'}>
              {full && hasMore && !live.moreFailed && <button type="button" className="button button--primary" onClick={loadNextPage}>다음 공개 후보 확인</button>}
              <button type="button" className="button button--secondary" onClick={() => startEditing()}>검색 수정</button><a className="button button--secondary" href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">공식 검색 안내</a></EmptyState>
              : <>{full && (pages > 1 || hasMore) && <Pagination page={page} pages={pages} onChange={changePage} inputId={'lost-' + which + '-page-top'} position="top" allowBeyond={hasMore} />}
                <div className="gallery-result-grid lost-result-grid">{shown.map(item => {
                  const score = modelScores.get(item.id)
                  const ranking = import.meta.env.DEV ? {
                    score: score ?? textScores.get(item.id) ?? 0,
                    basis: score === undefined ? '텍스트 대체' : modelBasis,
                  } : undefined
                  return <FoundCard key={item.id} item={item} ranking={ranking} to={'/lost-found/item/' + (item.source ?? 'police') + '/' + encodeURIComponent((item.atcId ?? item.id) + ':' + (item.fdSn ?? '1')) + '?back=' + encodeURIComponent(pageKey)} />
                })}</div>
                {sectionRank && <details className="lost-context-rank-details"><summary>비교 근거와 장소 정보 보기</summary><ol>{sectionRank.map(result => {
                  const item = shown.find(candidate => candidate.id === result.id)
                  return <li key={result.id}><strong>{item?.title ?? '공개 후보'}</strong><ul>{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p><strong>{locationRelationLabels[result.locationRelation]}</strong>{result.locationEvidence ? ` · ${result.locationEvidence}` : ''}</p><p>{result.uncertainty}</p></li>
                })}</ol><p className="lost-context-rank-details__note">이 근거는 같은 물건임을 확인하지 않아요. 장소 정보는 공개 문구에 따른 가능성일 뿐이에요.</p></details>}
                {full && (pages > 1 || hasMore) && <Pagination page={page} pages={pages} onChange={changePage} inputId={'lost-' + which + '-page-bottom'} allowBeyond={hasMore} />}</>}
    </section>
  }
  const assistantToggle = <button type="button" className="button button--secondary lost-results__assistant" ref={toggle} aria-controls={id} aria-expanded={open} disabled={!!editor} onClick={() => showAssistant(!open)}><MessageSquare aria-hidden="true" />{open ? '도우미 접기' : '검색 도우미'}</button>
  const assistantPanel = <GallerySearchAssistant id={id} mode="lost" wide={wide} hideHeading={!wide} state={assistant} baseQuery={draft.query} inputRef={input} onChange={changeAssistant} onClose={() => showAssistant(false)} onApply={onRefine} />
  const renderQuerySummary = (action?: ReactNode, feedback?: ReactNode) =>
    <GalleryQuerySummary mode="lost" key={draft.query + ':' + getReferencePhotos(draft).map(localPhotoId).join('|')} draft={draft}
      editButtonRef={editButton} onEdit={startEditing} secondaryAction={action} feedback={feedback} />
  const hasAppliedCriteria = hasSearchCriteria(criteria) && !live.loading && !live.error
  const hasResultDetails = hasAppliedCriteria || !!lastRefreshAt || !!(activeRank && !rankBusy) || !!(activeVisual && !visualBusy)

  return <div className={'gallery-search-shell lost-search-shell' + (wide && open ? ' gallery-search-shell--open' : '')}><main id="main-content" className="content-workspace gallery-results lost-results" onClickCapture={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0 && event.target instanceof Element && event.target.closest('a')) rememberScroll() }}>
    <PageHeading title={channel ? titles[channel] : '비슷한 물건 후보'} description={copy.publicScope}
      back={channel ? { to: linkTo(), label: '비슷한 물건 후보로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} action={assistantToggle} />
    <div className={'lost-results__search' + (editor ? ' lost-results__search--editing' : '')}>
      {editor ? <div className="gallery-query-editor"><SearchComposer mode="lost" draft={editor.draft} error={editorError} textareaRef={editorInput} initialAttachmentOpen={editor.photoEdit} submitLabel="다시 검색" onDraft={patch => { setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous); setEditorError('') }} onSubmit={commitEditing} onError={setEditorError} secondaryAction={<button type="button" className="button button--secondary gallery-query-editor__cancel" onClick={cancelEditing}>취소</button>} />{editorError && <p id="search-error" className="form-error" role="alert">{editorError}</p>}</div>
        : onRefine ? <AiQueryOptimizer key={recordId ?? 'unrecorded'} mode="lost" baseQuery={draft.query} state={assistant} onChange={changeAssistant} onApply={onRefine} renderInline={renderQuerySummary} />
          : renderQuerySummary()}
      <div className="lost-results__filters">
        <LostResultFilters toolbarActions={<button type="button" className="text-button lost-results__refresh" onClick={() => void refreshResults()}
          disabled={refreshing || !live.apiPage || live.loading}>{refreshing ? '확인 중…' : '새 후보 확인'}</button>} />
      </div>
    </div>
    <p className="gallery-query-status" role="status">{editNotice}</p>
    {refreshNotice && <p className={refreshNotice.error ? 'lost-context-rank-status lost-context-rank-status--error' : 'lost-context-rank-status'} role={refreshNotice.error ? 'alert' : 'status'}>{refreshNotice.message}</p>}
    {live.partial && !live.loading && <p className="lost-results__partial" role="status">일부 공개 목록을 불러오지 못했어요. <button type="button" disabled={live.loadingMore} onClick={live.periodCursor && hasMore ? loadNextPage : retry}>다시 시도</button></p>}
    {live.coverage && <PublicSearchScope coverage={live.coverage} />}
    {live.coverage && hasMore && !channel && <button type="button" className="button button--secondary" disabled={live.loadingMore} onClick={loadNextPage}>{live.loadingMore ? '공개 목록 확인 중…' : '공개 목록 더 확인'}</button>}
    {live.scanLimitReached && (!live.coverage || !hasMore) && <p className="field__help">더 오래된 기록은 <a href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">공식 습득물 검색</a>에서 확인해 주세요.</p>}
    {rankBusy && <p className="lost-context-rank-status" role="status">공개 후보의 설명과 장소 정보를 비교해 순서를 정하고 있어요.</p>}
    {rankError && <p className="lost-context-rank-status lost-context-rank-status--error" role="alert">{rankError}{contextPageCandidates.length > 0 && <> <button type="button" onClick={retryContextRanking}>다시 시도</button></>}</p>}
    {visualBusy && <p className="lost-context-rank-status" role="status">공개 사진을 비교하고 있어요.</p>}
    {visualError && <p className="lost-context-rank-status lost-context-rank-status--error" role="alert">{visualError}{visualCandidates.length > 0 && <> <button type="button" onClick={() => startVisualRanking(visualRankScope)}>다시 시도</button></>}</p>}
    {params.get('state') === 'stale' && <p className="inline-error">공식 기록이 변경된 상태 예시예요.</p>}
    {visibleNewItems.length > 0 && <section className="gallery-result-section lost-result-section" aria-labelledby={id + '-new'}>
      <div className="gallery-result-section__heading"><div><h2 id={id + '-new'}>신규</h2><p>마지막 검색·새로고침 이후 새로 확인된 공개 후보예요.</p></div>
        <button type="button" className="gallery-result-section__more" onClick={includeNewItems}>종합 결과에 포함</button></div>
      <div className="gallery-result-grid lost-result-grid">{visibleNewItems.map(item => {
        const candidate = toCandidate(item)
        return <FoundCard key={candidate.id} item={candidate} to={'/lost-found/item/' + (candidate.source ?? 'police') + '/' + encodeURIComponent((candidate.atcId ?? candidate.id) + ':' + (candidate.fdSn ?? '1')) + '?back=' + encodeURIComponent(pageKey)} />
      })}</div>
    </section>}
    {/* 채널별로 결과가 준비되는 대로 각 섹션에서 로봇을 보여주고 결과를 교체한다. */}
    <div className="gallery-results__sections">{channel ? renderSection(channel, true) : LOST_RESULT_CHANNELS.map(which => renderSection(which))}</div>
    {(draft.aiPlan || hasResultDetails) && <div className="lost-results__details">
      {draft.aiPlan && <AiSearchPlanView plan={draft.aiPlan} originalQuery={draft.aiPlan.originalQuery || draft.query} />}
      {hasResultDetails && <details className="lost-ai-criteria lost-ai-criteria--disclosure">
        <summary>
          <strong>{hasAppliedCriteria ? '후보를 찾는 데 쓴 단서' : '후보 확인 정보'}</strong>
          {hasAppliedCriteria && <span>{matchedCandidates > 0 ? ` · 일치 ${matchedCandidates.toLocaleString('ko-KR')}건` : ' · 넓게 검색한 결과'}</span>}
        </summary>
        <div className="lost-ai-criteria__body">
          {hasAppliedCriteria && <>
            <div className="lost-ai-criteria__chips">{(['apiKeywords', 'include', 'any', 'exclude', 'imageFeatures'] as const).filter(key => criteria[key].length > 0).map(key => <span key={key} className={'lost-ai-criteria__chip lost-ai-criteria__chip--' + key}><strong>{criteriaLabels[key]}</strong>{criteria[key].join(' · ')}</span>)}</div>
            <p className="lost-ai-criteria__note">{matchedCandidates > 0 ? `공개 정보에서 단서가 맞는 ${matchedCandidates}건을 순위에 반영했어요.` : '공개 정보에서 단서가 맞는 후보를 찾지 못했어요.'}</p>
          </>}
          {activeRank && !rankBusy && <p className="lost-ai-criteria__note">이 페이지 후보 {activeRank.length}개의 설명과 장소 정보를 바탕으로 정리했어요.</p>}
          {!!activeVisual?.length && !visualBusy && <p className="lost-ai-criteria__note">공개 사진 {activeVisual.length}장을 비교했어요.</p>}
          {lastRefreshAt && <p className="lost-ai-criteria__note">마지막 확인 <time dateTime={new Date(lastRefreshAt).toISOString()}>{new Date(lastRefreshAt).toLocaleString('ko-KR')}</time></p>}
        </div>
      </details>}
    </div>}
    <p className="field__help result-disclaimer">결과는 참고용이에요. 같은 물건인지와 보관 여부는 보관기관에 확인해 주세요.</p>
  </main>{wide ? open && <div className="gallery-assistant-dock">{assistantPanel}</div> : <Modal open={open} title="검색 도우미" focusKey={id} className="gallery-assistant-modal" initialFocus={input} onClose={() => showAssistant(false)}>{assistantPanel}</Modal>}
  </div>
}

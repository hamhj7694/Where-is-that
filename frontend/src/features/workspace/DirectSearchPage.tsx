import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBrowserScope, type BrowserScope } from '../auth/browser-scope'
import { readLostResultFilters } from '../search/lost-result-model'
import {
  compactFoundItems, dedupeLostFound, getBrowseJob, startBrowseJob, toCandidate,
  type BrowsePayload, type FoundItem, type LostBrowseFilters, type LostSearchHints,
  type PublicPeriodCursor, type PublicSearchCoverage,
} from '../search/lostfound-api'
import { prepareAiSearch } from '../search/ai-search-api'
import { copy } from '../search/copy'
import { criteriaFromPlan, criteriaLabels, criteriaToHints, EMPTY_SEARCH_CRITERIA, hasSearchCriteria, normalizeCriteria, type AiSearchCriteria } from '../search/ai-match-model'
import { AiSearching, EmptyState, FoundCard, PageHeading, Pagination, RetryButton } from './components'
import { minimumWait } from './ai-loading'
import { OFFICIAL_SEARCH_URL } from './data'
import DirectBasicResults from './DirectBasicResults'
import LostResultFilters from './LostResultFilters'
import PublicSearchScope from './PublicSearchScope'
import '../../styles/gallery-search.css'
import '../../styles/lost-results.css'
import '../../styles/direct-search.css'

const API_ROWS = 40
const JOB_STORAGE_KEY = 'geugeo-eodi:direct-browse-job'
const SEARCH_POLICY = 4
// 상세 페이지 갔다가 돌아오면 마지막으로 본 검색 결과를 그대로 되살린다.
const LAST_SEARCH_KEY = 'geugeo-eodi:direct-last-search'

/** 일반 검색은 공개 원문만, AI 검색은 조건 해석과 사진 분석까지 진행한다. */
type SearchMode = 'basic' | 'ai'

interface StoredJob {
  jobId: string
  keyword: string
  reloadToken: number
  /** 더 찾아보기로 건너뛴 사진 수. 새로고침 후에도 이어볼 위치를 기억한다. */
  skipVisual: number
  /** 현재 페이지 밖에서 찾은 사진 점수까지 이어받는다. */
  priorVisualScores?: Record<string, number>
  mode?: SearchMode
  /** AI가 해석한 단서와 사용자가 고른 필터를 포함한 조회 키. */
  searchKey?: string
}

/** AI 해석 전에 시작한 원문 조회를 조건이 생긴 뒤에도 재사용하지 않도록 구분한다. */
export function browseSearchKey(hints: LostSearchHints, filters: LostBrowseFilters): string {
  return JSON.stringify({ hints, filters, policy: SEARCH_POLICY })
}

export function canResumeBrowseJob(
  stored: StoredJob | null,
  searchKey: string,
  keyword: string,
  mode: SearchMode,
  reloadToken: number,
  skipVisual: number,
): boolean {
  return Boolean(stored && stored.keyword === keyword
    && (stored.mode ?? 'ai') === mode
    && stored.reloadToken === reloadToken
    && stored.skipVisual === skipVisual
    && stored.searchKey === searchKey)
}

function readStoredJob(scope: BrowserScope | null): StoredJob | null {
  if (!scope) return null
  try {
    const raw = window.localStorage.getItem(JOB_STORAGE_KEY + ':' + scope)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredJob>
    return typeof value.jobId === 'string' && typeof value.keyword === 'string' ? value as StoredJob : null
  } catch {
    return null
  }
}

function writeStoredJob(scope: BrowserScope | null, job: StoredJob) {
  if (!scope) return
  try { window.localStorage.setItem(JOB_STORAGE_KEY + ':' + scope, JSON.stringify(job)) } catch { /* 저장 불가면 무시 */ }
}

function clearStoredJob(scope: BrowserScope | null) {
  if (!scope) return
  try { window.localStorage.removeItem(JOB_STORAGE_KEY + ':' + scope) } catch { /* 무시 */ }
}

interface LiveState {
  raw: FoundItem[]
  total: number
  scanned: number
  scanLimitReached: boolean
  criteriaApplied: boolean
  visualScanned: number
  visualMore: boolean
  hasMore?: boolean
  coverage?: PublicSearchCoverage
  periodCursor?: PublicPeriodCursor
  visualScores: Record<string, number>
  loading: boolean
  error: string | null
  partial: boolean
  jobId?: string
  visualOffset?: number
  extensionError?: string
}
const initialLive = (loading: boolean): LiveState => ({
  raw: [], total: 0, scanned: 0, scanLimitReached: false,
  criteriaApplied: false, visualScanned: 0, visualMore: false, visualScores: {},
  loading, error: null, partial: false,
})

export function mergeDirectBrowseItems(previous: readonly FoundItem[], ranked: readonly FoundItem[]) {
  // 서버의 새 순위를 쓰고, 만료된 작업이나 조회 실패로 빠진 기존 결과를 뒤에 남긴다.
  return dedupeLostFound([...ranked, ...previous])
}

/**
 * 사진 점수는 같은 검색을 이어볼 때만 되살린다.
 * 검색어를 바꾸면 이전 결과가 아직 화면 상태에 남아 있으므로, 여기서 걸러주지 않으면
 * 전혀 다른 물건에 이전 검색의 "사진 특징 90점"이 붙는다.
 */
export function priorScoresForSearch(
  stored: StoredJob | null,
  live: LiveState,
  continuation: boolean,
): Record<string, number> {
  if (!continuation) return {}
  const scores: Record<string, number> = { ...(stored?.priorVisualScores ?? {}) }
  for (const [id, score] of Object.entries(live.visualScores ?? {})) {
    if (score > 0) scores[id] = score
  }
  for (const item of live.raw) {
    if (item.visualScore && item.visualScore > 0) scores[item.id] = item.visualScore
  }
  return scores
}

interface StoredSearch {
  keyword: string
  input: string
  page: number
  params: string
  mode?: SearchMode
  live: LiveState
  criteria: AiSearchCriteria
  policy?: number
  aiDates: { from: string; to: string }
  aiRegion?: string
  aiCategory?: string
  /** AI가 더 알아보라고 한 장소 질문과 이미 답한 질문. */
  aiQuestions?: string[]
  answeredQuestions?: string[]
  analyzedKeyword: string
  reloadToken?: number
  skipVisual: number
  continuing?: boolean
  visualProgress: { scanned: number; total: number }
}

function readStoredSearch(scope: BrowserScope | null): StoredSearch | null {
  if (!scope) return null
  try {
    const raw = window.sessionStorage.getItem(LAST_SEARCH_KEY + ':' + scope)
    if (!raw) return null
    const value = JSON.parse(raw) as StoredSearch
    if (typeof value.keyword !== 'string' || !value.live || !Array.isArray(value.live.raw)) return null
    if (value.policy === SEARCH_POLICY) return value
    return { ...value, live: initialLive(true), analyzedKeyword: '', skipVisual: 0, continuing: false, visualProgress: { scanned: 0, total: 0 } }
  } catch {
    return null
  }
}

function writeStoredSearch(scope: BrowserScope | null, value: StoredSearch) {
  if (!scope) return
  try { window.sessionStorage.setItem(LAST_SEARCH_KEY + ':' + scope, JSON.stringify(value)) } catch { /* 저장 불가면 무시 */ }
}

function clearStoredSearch(scope: BrowserScope | null) {
  if (!scope) return
  try { window.sessionStorage.removeItem(LAST_SEARCH_KEY + ':' + scope) } catch { /* 무시 */ }
}

export default function DirectSearchPage() {
  const scope = useBrowserScope()
  const [restored] = useState(() => readStoredSearch(scope))
  const [params, setParams] = useSearchParams()
  const [input, setInput] = useState(restored?.input ?? '')
  const [keyword, setKeyword] = useState(restored?.keyword ?? '')
  const [mode, setMode] = useState<SearchMode>(restored?.mode ?? 'ai')
  const [selectedMode, setSelectedMode] = useState<SearchMode>(mode)
  const isAiSearch = mode === 'ai' && Boolean(keyword)
  const [photoMatches, setPhotoMatches] = useState<FoundItem[]>([])
  const [live, setLive] = useState<LiveState>(() =>
    restored && (!restored.live.loading || restored.continuing)
      ? { ...restored.live, visualOffset: restored.live.visualOffset ?? restored.skipVisual }
      : initialLive(true),
  )
  const [reloadToken, setReloadToken] = useState(restored?.reloadToken ?? 0)
  const [elapsed, setElapsed] = useState(0)
  // '더 찾아보기'를 누를 때마다 이미 본 사진 수를 더해 더 오래된 사진부터 다시 조회한다.
  const [skipVisual, setSkipVisual] = useState(restored?.skipVisual ?? 0)
  const [visualProgress, setVisualProgress] = useState(restored?.visualProgress ?? { scanned: 0, total: 0 })
  const [aiDates, setAiDates] = useState<{ from: string; to: string }>(restored?.aiDates ?? { from: '', to: '' })
  const [aiRegion, setAiRegion] = useState(restored?.aiRegion ?? '')
  const [aiCategory, setAiCategory] = useState(restored?.aiCategory ?? '')
  const [aiQuestions, setAiQuestions] = useState<string[]>(restored?.aiQuestions ?? [])
  const [answeredQuestions, setAnsweredQuestions] = useState<string[]>(restored?.answeredQuestions ?? [])
  const answeredRef = useRef<string[]>(restored?.answeredQuestions ?? [])
  const [questionDraft, setQuestionDraft] = useState('')
  const [criteria, setCriteria] = useState<AiSearchCriteria>(normalizeCriteria(restored?.criteria))
  const [aiBusy, setAiBusy] = useState(false)
  // 분석이 끝난 검색어만 조회한다. AI 응답 전 원문 검색이 먼저 실행돼 깜빡이는 것을 막는다.
  const [analyzedKeyword, setAnalyzedKeyword] = useState(restored?.analyzedKeyword ?? '')
  // 복원한 결과가 있으면 분석·조회를 건너뛴다. effect 안에서 플래그를 소비하면
  // StrictMode의 두 번째 실행에서 재검색되므로 사용자 액션에서만 지운다.
  const restoreAiRef = useRef<string | null>(
    restored && restored.keyword && restored.analyzedKeyword === restored.keyword ? restored.keyword : null,
  )
  // 페이지는 표시용이므로 상세에서 돌아와 다른 페이지여도 같은 결과로 본다.
  const restoredSearchSignature = (() => {
    if (!restored?.keyword) return null
    const saved = new URLSearchParams(restored.params)
    saved.delete('page')
    return `${restored.keyword}|${saved.toString()}|${restored.mode ?? 'ai'}`
  })()
  const restoreSearchRef = useRef<string | null>(restored?.live.loading ? null : restoredSearchSignature)
  const resolvedResults = useRef<string | null>(restoreSearchRef.current)
  const continuationRef = useRef<string | null>(restored?.continuing ? restoredSearchSignature : null)
  const pageParam = params.get('page')
  const pages = Math.max(1, Math.ceil(live.total / API_ROWS))
  const requestedPage = pageParam && /^[0-9]+$/.test(pageParam) ? Number(pageParam) : 1
  const page = Math.max(1, Math.min(requestedPage, pages))
  const back = '/direct-search' + (params.size ? '?' + params.toString() : '')

  // AI 분석은 검색어가 바뀔 때만 한다. 필터 변경은 서버 조회만 다시 트리거한다.
  useEffect(() => {
    if (!keyword) {
      clearStoredSearch(scope)
      setCriteria(EMPTY_SEARCH_CRITERIA)
      setAiDates({ from: '', to: '' })
      setAiRegion('')
      setAiCategory('')
      setAiQuestions([])
      setQuestionDraft('')
      setSkipVisual(0)
      setAiBusy(false)
      setAnalyzedKeyword('')
      return
    }
    if (restoreAiRef.current === keyword) {
      setAiBusy(false)
      return
    }
    // 일반 검색은 조건 해석·사진 분석 없이 입력한 말로 공개 목록만 조회한다.
    if (mode === 'basic') {
      setCriteria(EMPTY_SEARCH_CRITERIA)
      setAiDates({ from: '', to: '' })
      setAiRegion('')
      setAiCategory('')
      setAiQuestions([])
      setQuestionDraft('')
      setSkipVisual(0)
      setAnalyzedKeyword(keyword)
      setAiBusy(false)
      return
    }
    let cancelled = false
    setAiBusy(true)
    setSkipVisual(0)
    prepareAiSearch('direct', keyword, [])
      .then(plan => {
        if (cancelled) return
        setCriteria(criteriaFromPlan(plan, keyword))
        // 추정 기간은 기본 기간을 대체할 수 있고, 분류·장소는 검색 단서다.
        setAiDates({ from: plan?.filters?.fromDate || '', to: plan?.filters?.toDate || '' })
        setAiRegion(plan?.filters?.region || '')
        setAiCategory(plan?.filters?.category || '')
        setAiQuestions((plan?.clarificationQuestions ?? []).filter(
          question => question.trim() && !answeredRef.current.includes(question.trim()),
        ).slice(0, 3))
        setQuestionDraft('')
        setAnalyzedKeyword(keyword)
      })
      .catch(() => {
        if (cancelled) return
        // AI가 실패해도 원문으로 검색한다.
        setCriteria(EMPTY_SEARCH_CRITERIA)
        setAiDates({ from: '', to: '' })
        setAiRegion('')
        setAiCategory('')
        setAiQuestions([])
        setAnalyzedKeyword(keyword)
      })
      .finally(() => { if (!cancelled) setAiBusy(false) })
    return () => { cancelled = true }
  }, [keyword, mode, scope])

  const hints = useMemo<LostSearchHints>(() => ({
    ...criteriaToHints(mode === 'basic' ? EMPTY_SEARCH_CRITERIA : criteria),
    ...(mode === 'ai' && (aiDates.from || aiDates.to) ? { fromDate: aiDates.from, toDate: aiDates.to } : {}),
    ...(mode === 'ai' && aiCategory ? { itemCategory: aiCategory } : {}),
  }), [mode, criteria, aiDates, aiCategory])
  // 페이지는 화면 표시용이다. 필터 객체가 페이지 때문에 바뀌면 다시 조회하므로 key에서 뺀다.
  const filterKey = useMemo(() => {
    const next = new URLSearchParams(params)
    next.delete('page')
    return next.toString()
  }, [params])
  const filters = useMemo<LostBrowseFilters>(() => {
    const { category, color, region, from, to } = readLostResultFilters(new URLSearchParams(filterKey))
    return { category, color, region, from, to }
  }, [filterKey])
  const searchKey = useMemo(() => browseSearchKey(hints, filters), [hints, filters])
  const resultSignature = `${keyword}|${filterKey}|${mode}`

  // 검색은 서버 작업으로 넘긴다. 페이지를 옮기거나 탭을 닫아도 서버는 계속 진행하고,
  // 돌아오면 저장해 둔 jobId로 결과를 이어받는다.
  useEffect(() => {
    // 상세 페이지에서 돌아온 경우 이미 받아 둔 결과를 그대로 보여준다.
    if (restoreSearchRef.current === resultSignature) return
    const previous = continuationRef.current === resultSignature ? live : null
    if (!previous) continuationRef.current = null
    const offset = previous ? skipVisual : 0
    const pending = previous ? { ...previous, loading: true, extensionError: undefined } : initialLive(true)
    const remember = (value: LiveState, continuing = false) => {
      writeStoredSearch(scope, {
        keyword, input, page, params: params.toString(), mode,
        live: { ...value, raw: compactFoundItems(value.raw) },
        policy: SEARCH_POLICY, criteria, aiDates, aiRegion, aiCategory, aiQuestions, answeredQuestions,
        analyzedKeyword, reloadToken, skipVisual: offset, continuing, visualProgress,
      })
    }
    // 먼저 도착한 일반 결과의 상세를 열더라도 돌아와서 AI 검색을 이어받는다.
    if (isAiSearch || previous) remember(pending, Boolean(previous))
    if (keyword && analyzedKeyword !== keyword) return
    let cancelled = false
    let timer: number | undefined
    const startedAt = Date.now()
    resolvedResults.current = null
    setLive(pending)
    setPhotoMatches([])
    setElapsed(0)
    setVisualProgress({ scanned: 0, total: 0 })

    const clearIfCurrent = (jobId: string) => {
      if (readStoredJob(scope)?.jobId === jobId) clearStoredJob(scope)
    }
    const finish = (payload: BrowsePayload, jobId: string) => {
      if (cancelled) return
      clearIfCurrent(jobId)
      // 서버가 필터·AI 분석을 마친 전체 후보를 한 번에 준다. 페이지는 화면에서 자른다.
      const ranked = payload.allItems?.length ? payload.allItems : payload.items
      const allRaw = previous ? mergeDirectBrowseItems(previous.raw, ranked) : ranked
      const value: LiveState = {
        raw: allRaw,
        total: previous ? allRaw.length : payload.total,
        scanned: Math.max(previous?.scanned ?? 0, payload.scanned),
        scanLimitReached: payload.scanLimitReached,
        criteriaApplied: payload.criteriaApplied,
        visualScanned: payload.visualScanned ?? 0,
        visualMore: payload.visualMore ?? false,
        hasMore: payload.hasMore ?? undefined,
        coverage: payload.coverage ?? undefined,
        periodCursor: payload.periodCursor ?? undefined,
        visualScores: { ...previous?.visualScores, ...payload.visualScores },
        loading: false,
        error: null,
        partial: payload.errors.length > 0,
        jobId,
        visualOffset: offset,
      }
      resolvedResults.current = resultSignature
      continuationRef.current = null
      setLive(value)
      remember(value)
    }
    const fail = (message: string, jobId?: string) => {
      if (jobId) clearIfCurrent(jobId)
      if (cancelled) return
      const value = previous
        ? { ...previous, loading: false, extensionError: message }
        : { ...initialLive(false), error: message }
      continuationRef.current = null
      if (previous) resolvedResults.current = resultSignature
      setLive(value)
      remember(value)
    }
    const poll = async (jobId: string) => {
      try {
        const status = await getBrowseJob(jobId)
        if (cancelled) return
        if (status.visualTotal) {
          setVisualProgress({ scanned: status.visualScanned ?? 0, total: status.visualTotal })
        }
        if (status.photoMatches) setPhotoMatches(status.photoMatches)
        if (status.status === 'done' && status.result) {
          if (isAiSearch) await minimumWait(startedAt)
          return finish(status.result, jobId)
        }
        if (status.status === 'error') return fail(status.error ?? '검색 중 문제가 생겼어요.', jobId)
        timer = window.setTimeout(() => { void poll(jobId) }, 900)
      } catch (cause) {
        if (!cancelled) fail(cause instanceof Error && cause.message ? cause.message : '검색 결과를 확인하지 못했어요.', jobId)
      }
    }
    const begin = async () => {
      try {
        const stored = readStoredJob(scope)
        // AI 해석 전 원문 조회 작업을 조건이 생긴 뒤에도 이어 쓰면 지갑 대신
        // 검은색 휴대폰·가방이 섞인다. 조회 조건이 같을 때만 작업을 재사용한다.
        const resumable = canResumeBrowseJob(stored, searchKey, keyword, mode, reloadToken, offset)
        // 더 찾아보기·작업 이어받기·새로고침처럼 같은 검색을 계속할 때만 점수를 되살린다.
        // 새 검색어에서는 이전 결과가 화면에 남아 있어도 점수를 절대 넘기지 않는다.
        const prior = priorScoresForSearch(resumable ? stored : null, live, resumable || Boolean(previous))
        const priorVisualScores = Object.fromEntries(Object.entries(prior).sort((a, b) => b[1] - a[1]).slice(0, 200))
        // page는 캐시 키와 무관하다. 처음 한 번만 전체를 조회한다.
        const job = resumable && stored
          ? { jobId: stored.jobId, status: 'pending' }
          : await startBrowseJob(keyword, 1, API_ROWS, hints, filters, 200, offset, priorVisualScores, mode, previous?.jobId,
            keyword || filters.from || filters.to ? { cursor: previous?.periodCursor } : undefined)
        if (cancelled) return
        writeStoredJob(scope, {
          jobId: job.jobId, keyword, reloadToken, skipVisual: offset, mode, searchKey,
          priorVisualScores,
        })
        await poll(job.jobId)
      } catch (cause) {
        if (!cancelled) fail(cause instanceof Error && cause.message ? cause.message : '검색을 시작하지 못했어요.')
      }
    }
    void begin()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [keyword, reloadToken, skipVisual, hints, filters, searchKey, analyzedKeyword, mode, isAiSearch, scope])

  useEffect(() => {
    if (live.loading || live.error || aiBusy || resolvedResults.current !== resultSignature || pageParam === null) return
    const canonicalPage = page > 1 ? String(page) : null
    if (pageParam === canonicalPage && params.getAll('page').length === 1) return
    const updated = new URLSearchParams(params)
    if (canonicalPage) updated.set('page', canonicalPage)
    else updated.delete('page')
    setParams(updated, { replace: true })
  }, [aiBusy, live.loading, live.error, page, pageParam, params, resultSignature, setParams])

  // 로딩이 길어지면 경과 초를 보여준다.
  useEffect(() => {
    if (!live.loading) return
    const started = Date.now()
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [live.loading, keyword, reloadToken])

  // 서버가 필터·정렬·중복 제거를 이미 적용했다. 화면에서는 현재 페이지만 잘라 보여준다.
  const items = useMemo(
    () => dedupeLostFound(live.raw).slice((page - 1) * API_ROWS, page * API_ROWS).map(item => toCandidate(item)),
    [live.raw, page],
  )
  const colorOptions = useMemo(
    () => Array.from(new Set(items.map(item => item.color.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko')),
    [items],
  )
  const appliedFilters = Object.values(filters).filter(Boolean).length
  const preparing = aiBusy || Boolean(keyword && analyzedKeyword !== keyword)
  const searching = preparing || live.loading
  const extending = searching && continuationRef.current === resultSignature
  const progressLabel = isAiSearch && preparing
    ? '검색어를 정리하고 있어요'
    : isAiSearch && visualProgress.total > 0
      ? `공개 사진 ${Math.min(visualProgress.scanned, visualProgress.total)}/${visualProgress.total}장을 살펴보고 있어요`
      : extending ? '추가 후보를 찾아보고 있어요'
        : keyword ? '공개 정보를 찾아보고 있어요' : '공개 목록을 불러오고 있어요'
  const progressDetail = keyword && !preparing && elapsed > 2
    ? <>다른 페이지로 가도 검색은 계속돼요. <span aria-hidden="true">· {elapsed}초</span></>
    : null
  const isAiSelected = selectedMode === 'ai'
  const criteriaGroups = ['apiKeywords', 'include', 'any', 'prefer', 'exclude'] as const

  function goToPage(next: number) {
    const updated = new URLSearchParams(params)
    if (next <= 1) updated.delete('page')
    else updated.set('page', String(next))
    setParams(updated)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function reload() {
    restoreSearchRef.current = null
    setReloadToken(token => token + 1)
  }

  function submitSearch(event: FormEvent, nextMode: SearchMode) {
    event.preventDefault()
    const next = input.trim().replace(/\s+/g, ' ')
    const keywordChanged = next !== keyword
    const modeChanged = nextMode !== mode
    const updated = new URLSearchParams(params)
    updated.delete('page')
    restoreAiRef.current = null
    restoreSearchRef.current = null
    continuationRef.current = null
    if (keywordChanged || modeChanged) {
      clearStoredJob(scope)
      setAnalyzedKeyword('')
      setSkipVisual(0)
    }
    setParams(updated, { replace: true })
    if (keywordChanged) setKeyword(next)
    setMode(nextMode)
    if (!keywordChanged) setReloadToken(token => token + 1)
  }

  /** AI가 물은 장소를 답하면 답을 검색어에 붙여 다시 해석·조회한다. */
  function answerQuestion(event: FormEvent, question: string) {
    event.preventDefault()
    const answer = questionDraft.trim().replace(/\s+/g, ' ')
    if (!answer) return
    const next = `${keyword} · ${answer}`.slice(0, 100)
    const updated = new URLSearchParams(params)
    updated.delete('page')
    restoreAiRef.current = null
    restoreSearchRef.current = null
    continuationRef.current = null
    clearStoredJob(scope)
    answeredRef.current = [...answeredRef.current, question.trim()]
    setAnsweredQuestions(answeredRef.current)
    setAiQuestions(current => current.filter(item => item !== question))
    setQuestionDraft('')
    setParams(updated, { replace: true })
    setInput(next)
    setKeyword(next)
  }

  function lookDeeper() {
    if (searching || resolvedResults.current !== resultSignature || continuationRef.current === resultSignature) return
    continuationRef.current = resultSignature
    restoreSearchRef.current = null
    // 이전 작업 ID가 없는 방문 기록에서도 기존 오프셋과 결과를 이어 쓴다.
    setSkipVisual(Math.min(600, (live.visualOffset ?? 0) + live.visualScanned))
    setReloadToken(token => token + 1)
  }

  function showAll() {
    clearStoredJob(scope)
    clearStoredSearch(scope)
    restoreAiRef.current = null
    restoreSearchRef.current = null
    continuationRef.current = null
    setInput('')
    setKeyword('')
    setParams(new URLSearchParams(), { replace: true })
  }

  function renderResultCard(item: ReturnType<typeof toCandidate>) {
    const detail = encodeURIComponent((item.atcId ?? item.id) + ':' + (item.fdSn ?? '1'))
    const ranking = import.meta.env.DEV && typeof item.rankingScore === 'number' ? {
      score: item.rankingScore, tier: item.matchTier,
      basis: typeof item.visualScore === 'number' ? `사진 ${item.visualScore}점 반영` : '텍스트 신호',
    } : undefined
    return <FoundCard key={item.id} item={item} hideSourceBadge ranking={ranking} to={`/lost-found/item/${item.source ?? 'police'}/${detail}?back=${encodeURIComponent(back)}`} />
  }

  return <main id="main-content" className="content-workspace direct-search">
    <PageHeading title="직접 찾기" />
    <div className="direct-search__controls">
      <form className="direct-search__form" role="search" onSubmit={event => submitSearch(event, selectedMode)}>
        <fieldset className="direct-search__modes">
          <legend className="visually-hidden">검색 방식</legend>
          <label><input type="radio" name="direct-search-mode" value="ai" className="visually-hidden"
            checked={isAiSelected} onChange={() => setSelectedMode('ai')} /><span>AI 검색</span></label>
          <label><input type="radio" name="direct-search-mode" value="basic" className="visually-hidden"
            checked={!isAiSelected} onChange={() => setSelectedMode('basic')} /><span>일반 검색</span></label>
        </fieldset>
        <label className="visually-hidden" htmlFor="direct-keyword">물건 검색</label>
        <input
          id="direct-keyword"
          type="search"
          enterKeyHint="search"
          aria-describedby="direct-search-mode-help"
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}
          placeholder={isAiSelected ? '예: 금색 장식이 달린 검정 지갑' : '예: 가죽 지갑'}
          maxLength={100}
        />
        <div className="direct-search__form-actions">
          <button type="submit" className="button button--primary direct-search__submit" disabled={aiBusy}>
            {aiBusy ? '정리 중…' : isAiSelected ? 'AI로 찾기' : '검색'}
            <kbd aria-hidden="true">Enter</kbd>
          </button>
          {keyword && <button type="button" className="button button--secondary" onClick={showAll}>전체 보기</button>}
        </div>
        <p id="direct-search-mode-help" className="visually-hidden">{isAiSelected
          ? 'Enter를 누르면 공개 사진과 설명에서 단서를 찾아요.'
          : 'Enter를 누르면 검색어가 포함된 공개 정보를 찾아요.'}</p>
      </form>
      <div className="direct-search__filters"><LostResultFilters compact colorOptions={colorOptions} showDirection={false} customDropdowns /></div>
    </div>
    {searching && !extending && (isAiSearch ? <AiSearching compact label={progressLabel} detail={progressDetail} />
      : <div className="direct-search__progress" role="status" aria-live="polite">
        <span className="direct-search__spinner" aria-hidden="true" />
        <span>{progressLabel}<span className="direct-search__dots" aria-hidden="true"><i /><i /><i /></span></span>
        {progressDetail && <small>{progressDetail}</small>}
      </div>)}
    {searching && !extending && isAiSearch && photoMatches.length > 0 && <section aria-labelledby="direct-photo-preview">
      <h2 id="direct-photo-preview" className="search-section-title">먼저 찾은 후보</h2>
      <div className="gallery-result-grid direct-search__grid">
        {dedupeLostFound(photoMatches).map(item => renderResultCard(toCandidate(item)))}
      </div>
    </section>}
    {mode === 'ai' && (hasSearchCriteria(criteria) || aiDates.from || aiDates.to || aiRegion) && (!searching || extending) && !live.error && <div className="lost-ai-criteria" role="status">
      <p className="lost-ai-criteria__title">적어둔 내용에서 찾은 조건</p>
      <div className="lost-ai-criteria__chips">
        {criteriaGroups.filter(key => criteria[key].length > 0).map(key => <span key={key} className={'lost-ai-criteria__chip lost-ai-criteria__chip--' + key}><strong>{criteriaLabels[key]}</strong>{criteria[key].join(' · ')}</span>)}
        {aiRegion && <span className="lost-ai-criteria__chip"><strong>추정 지역</strong>{aiRegion}</span>}
        {(aiDates.from || aiDates.to) && <span className="lost-ai-criteria__chip"><strong>추정 기간</strong>{[aiDates.from, aiDates.to].filter(Boolean).join(' ~ ')}</span>}
      </div>
      <p className="direct-search__ai-note">AI가 읽은 단서는 후보를 찾고 순서를 정하는 데 써요. 목록을 좁히려면 검색 조건에서 필터를 골라 주세요.</p>
    </div>}
    {mode === 'ai' && aiQuestions.length > 0 && (!searching || extending) && <div className="direct-search__question" role="group" aria-label="검색 도우미 추가 질문">
      {aiQuestions.map(question => <form key={question} onSubmit={event => answerQuestion(event, question)}>
        <p>{question}</p>
        <div className="direct-search__question-row">
          <input value={questionDraft} onChange={event => setQuestionDraft(event.target.value)} placeholder="예: 신림역 인근" maxLength={60} aria-label="장소 답변" />
          <button type="submit" className="button button--secondary" disabled={!questionDraft.trim()}>이대로 다시 찾기</button>
        </div>
        <small>대략적인 장소도 검색 단서가 돼요.</small>
      </form>)}
    </div>}
    {live.partial && <p className="lost-results__partial" role="status">일부 공개 정보를 불러오지 못했어요. 확인 가능한 결과를 보여드려요.</p>}
    {live.coverage && <PublicSearchScope coverage={live.coverage} />}
    {searching && !extending ? null : live.error ? <EmptyState title="목록을 불러오지 못했어요" description={live.error + ' 잠시 뒤 다시 시도해 주세요.'} error><RetryButton onClick={reload} /></EmptyState>
      : <>
        <div className="direct-search__pagination-top">
          {(pages > 1 || live.total > API_ROWS) && <Pagination page={page} pages={pages} onChange={goToPage} inputId="direct-page-jump-top" position="top" />}
          <div className="direct-search__summary">
            <p className="direct-search__scope">{copy.publicScope} · {live.scanned.toLocaleString('ko-KR')}건 확인{appliedFilters ? ` · 선택 조건 ${appliedFilters}개 적용` : ''}</p>
            <p className="direct-search__count" role="status">{keyword ? `'${keyword}' ${mode === 'ai' ? 'AI 검색' : '일반 검색'} 결과 ` : live.scanLimitReached ? '확인한 목록 ' : '전체 목록 '}{live.total.toLocaleString('ko-KR')}건 중 {page}페이지 · 이 페이지 {items.length}건</p>
          </div>
        </div>
        {items.length ? <div className="gallery-result-grid direct-search__grid">
          {items.map(renderResultCard)}
        </div> : <EmptyState title={live.hasMore ? '확인한 범위에 맞는 물건이 없어요' : '조건에 맞는 물건이 없어요'} description="다른 키워드나 검색 조건을 사용해 보세요.">
          {(keyword || appliedFilters > 0) && <button type="button" className="button button--secondary" onClick={showAll}>전체 목록 보기</button>}
        </EmptyState>}
        {(live.hasMore || (isAiSearch && live.visualMore) || live.extensionError) && <>
          <div className="direct-search__deeper" role="region" aria-label="추가 검색">
            {live.extensionError
              ? <span role="alert">추가 검색을 완료하지 못했어요. 기존 결과는 유지했어요.</span>
              : <span>{extending ? '기존 결과를 보면서 추가 검색을 기다릴 수 있어요.' : '아직 확인하지 않은 공개 후보가 남아 있어요.'}</span>}
            <button type="button" className="button button--secondary" onClick={lookDeeper} disabled={extending}>
              {extending ? '추가 검색 중…' : '더 찾아보기'}
            </button>
          </div>
          {extending && isAiSearch && <AiSearching compact label={progressLabel} />}
        </>}
        {(pages > 1 || live.total > API_ROWS) && <Pagination page={page} pages={pages} onChange={goToPage} inputId="direct-page-jump-bottom" />}
        {live.scanLimitReached && (!live.coverage || !live.hasMore) && <p className="field__help">더 오래된 기록은 <a href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">공식 습득물 검색</a>에서 확인해 주세요.</p>}
      </>}
    {isAiSearch && <DirectBasicResults key={JSON.stringify([keyword, filterKey])} keyword={keyword} filters={filters} renderCard={renderResultCard} />}
    <p className="field__help result-disclaimer">동일 물건인지와 보관 여부는 보관기관에 확인해 주세요.</p>
  </main>
}

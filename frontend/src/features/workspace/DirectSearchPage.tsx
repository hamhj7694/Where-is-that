import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { readLostResultFilters, resolveAiDateFilters } from '../search/lost-result-model'
import {
  compactFoundItems, dedupeLostFound, getBrowseJob, startBrowseJob, toCandidate,
  type BrowsePayload, type FoundItem, type LostBrowseFilters,
} from '../search/lostfound-api'
import { prepareAiSearch } from '../search/ai-search-api'
import { criteriaFromPlan, criteriaLabels, criteriaToHints, EMPTY_SEARCH_CRITERIA, hasSearchCriteria, type AiSearchCriteria } from '../search/ai-match-model'
import { AiSearching, EmptyState, FoundCard, PageHeading, Pagination, RetryButton } from './components'
import LostResultFilters from './LostResultFilters'
import '../../styles/gallery-search.css'
import '../../styles/lost-results.css'
import '../../styles/direct-search.css'

const API_ROWS = 40
const JOB_STORAGE_KEY = 'geugeo-eodi:direct-browse-job'
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
}

function readStoredJob(): StoredJob | null {
  try {
    const raw = window.localStorage.getItem(JOB_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredJob>
    return typeof value.jobId === 'string' && typeof value.keyword === 'string' ? value as StoredJob : null
  } catch {
    return null
  }
}

function writeStoredJob(job: StoredJob) {
  try { window.localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(job)) } catch { /* 저장 불가면 무시 */ }
}

function clearStoredJob() {
  try { window.localStorage.removeItem(JOB_STORAGE_KEY) } catch { /* 무시 */ }
}

interface LiveState {
  raw: FoundItem[]
  total: number
  scanned: number
  scanLimitReached: boolean
  criteriaApplied: boolean
  visualScanned: number
  visualMore: boolean
  visualScores: Record<string, number>
  loading: boolean
  error: string | null
  partial: boolean
}
const initialLive = (loading: boolean): LiveState => ({
  raw: [], total: 0, scanned: 0, scanLimitReached: false,
  criteriaApplied: false, visualScanned: 0, visualMore: false, visualScores: {},
  loading, error: null, partial: false,
})

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
  aiDates: { from: string; to: string }
  /** 사용자가 AI 추정 기간을 지웠으면 다시 넣지 않는다. */
  aiPeriodOff?: boolean
  analyzedKeyword: string
  skipVisual: number
  visualProgress: { scanned: number; total: number }
}

function readStoredSearch(): StoredSearch | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_SEARCH_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as StoredSearch
    return typeof value.keyword === 'string' && value.live && Array.isArray(value.live.raw) ? value : null
  } catch {
    return null
  }
}

function writeStoredSearch(value: StoredSearch) {
  try { window.sessionStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(value)) } catch { /* 저장 불가면 무시 */ }
}

function clearStoredSearch() {
  try { window.sessionStorage.removeItem(LAST_SEARCH_KEY) } catch { /* 무시 */ }
}

const TIER_LEGEND = [
  { label: 'AI+검색어+필터', className: 'tier0' },
  { label: 'AI 조건', className: 'tier1' },
  { label: '검색어', className: 'tier2' },
  { label: '조건 필터', className: 'tier3' },
  { label: '부분 일치', className: 'tier4' },
  { label: '공개 원문', className: 'tier5' },
]

export default function DirectSearchPage() {
  const restoredRef = useRef<StoredSearch | null>(readStoredSearch())
  const restored = restoredRef.current
  const [params, setParams] = useSearchParams(restored?.params ?? '')
  const [input, setInput] = useState(restored?.input ?? '')
  const [keyword, setKeyword] = useState(restored?.keyword ?? '')
  const [mode, setMode] = useState<SearchMode>(restored?.mode ?? 'ai')
  const [live, setLive] = useState<LiveState>(() =>
    restored && !restored.live.loading ? restored.live : initialLive(Boolean(restored?.keyword)),
  )
  const [reloadToken, setReloadToken] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  // '더 찾아보기'를 누를 때마다 이미 본 사진 수를 더해 더 오래된 사진부터 다시 조회한다.
  const [skipVisual, setSkipVisual] = useState(restored?.skipVisual ?? 0)
  const [visualProgress, setVisualProgress] = useState(restored?.visualProgress ?? { scanned: 0, total: 0 })
  const [aiDates, setAiDates] = useState<{ from: string; to: string }>(restored?.aiDates ?? { from: '', to: '' })
  const [aiPeriodOff, setAiPeriodOff] = useState(restored?.aiPeriodOff ?? false)
  const hadDateKeys = useRef(params.has('from') || params.has('to'))
  const [criteria, setCriteria] = useState<AiSearchCriteria>(restored?.criteria ?? EMPTY_SEARCH_CRITERIA)
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
    if (!restored || restored.live.loading || !restored.keyword) return null
    const saved = new URLSearchParams(restored.params)
    saved.delete('page')
    return `${restored.keyword}|${saved.toString()}|${restored.mode ?? 'ai'}`
  })()
  const restoreSearchRef = useRef<string | null>(restoredSearchSignature)
  const page = Math.max(1, Number(params.get('page')) || 1)
  const back = '/direct-search' + (params.size ? '?' + params.toString() : '')

  // AI 분석은 검색어가 바뀔 때만 한다. 필터 변경은 서버 조회만 다시 트리거한다.
  useEffect(() => {
    if (!keyword) {
      clearStoredSearch()
      setCriteria(EMPTY_SEARCH_CRITERIA)
      setAiDates({ from: '', to: '' })
      setAiPeriodOff(false)
      hadDateKeys.current = false
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
      setAiPeriodOff(false)
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
        // "약 한 달 전", "오래전에" 같은 말을 AI가 날짜로 바꾸면 조회 기간에 적용한다.
        setAiDates({ from: plan?.filters?.fromDate || '', to: plan?.filters?.toDate || '' })
        // 새로 분석한 검색어에서는 이전 검색의 '기간 해제' 상태를 이어가지 않는다.
        setAiPeriodOff(false)
        setAnalyzedKeyword(keyword)
      })
      .catch(() => {
        if (cancelled) return
        // AI가 실패해도 원문 검색으로 공개 목록을 유지한다.
        setCriteria(EMPTY_SEARCH_CRITERIA)
        setAiDates({ from: '', to: '' })
        setAiPeriodOff(false)
        setAnalyzedKeyword(keyword)
      })
      .finally(() => { if (!cancelled) setAiBusy(false) })
    return () => { cancelled = true }
  }, [keyword, mode])

  // 필터 UI에서 기간을 지워 URL 키가 사라졌으면 AI 추정 기간을 다시 넣지 않는다.
  useEffect(() => {
    const hasDate = params.has('from') || params.has('to')
    if (hadDateKeys.current && !hasDate && (aiDates.from || aiDates.to)) setAiPeriodOff(true)
    if (hasDate) setAiPeriodOff(false)
    hadDateKeys.current = hasDate
  }, [params, aiDates])

  const hints = useMemo(() => criteriaToHints(criteria), [criteria])
  // 페이지는 화면 표시용이다. 필터 객체가 페이지 때문에 바뀌면 다시 조회하므로 key에서 뺀다.
  const filterKey = useMemo(() => {
    const next = new URLSearchParams(params)
    next.delete('page')
    return next.toString()
  }, [params])
  const filters = useMemo<LostBrowseFilters>(() => {
    const query = new URLSearchParams(filterKey)
    const raw = readLostResultFilters(query)
    const dates = resolveAiDateFilters(query, aiDates, aiPeriodOff)
    return {
      category: raw.category, color: raw.color, region: raw.region,
      from: dates.from, to: dates.to,
    }
  }, [filterKey, aiDates, aiPeriodOff])

  // 검색은 서버 작업으로 넘긴다. 페이지를 옮기거나 탭을 닫아도 서버는 계속 진행하고,
  // 돌아오면 저장해 둔 jobId로 결과를 이어받는다.
  useEffect(() => {
    // 상세 페이지에서 돌아온 경우 이미 받아 둔 결과를 그대로 보여준다.
    if (restoreSearchRef.current === `${keyword}|${filterKey}|${mode}`) return
    if (keyword && analyzedKeyword !== keyword) return
    let cancelled = false
    let timer: number | undefined
    setLive(initialLive(true))
    setElapsed(0)
    setVisualProgress({ scanned: 0, total: 0 })

    const remember = (value: LiveState) => {
      writeStoredSearch({
        keyword, input, page, params: params.toString(), mode,
        live: { ...value, raw: compactFoundItems(value.raw) },
        criteria, aiDates, aiPeriodOff, analyzedKeyword: keyword, skipVisual, visualProgress,
      })
    }
    const clearIfCurrent = (jobId: string) => {
      if (readStoredJob()?.jobId === jobId) clearStoredJob()
    }
    const finish = (payload: BrowsePayload, jobId: string) => {
      clearIfCurrent(jobId)
      if (cancelled) return
      // 서버가 필터·AI 분석을 마친 전체 후보를 한 번에 준다. 페이지는 화면에서 자른다.
      const allRaw = payload.allItems?.length ? payload.allItems : payload.items
      const value: LiveState = {
        raw: allRaw,
        total: payload.total,
        scanned: payload.scanned,
        scanLimitReached: payload.scanLimitReached,
        criteriaApplied: payload.criteriaApplied,
        visualScanned: payload.visualScanned ?? 0,
        visualMore: payload.visualMore ?? false,
        visualScores: payload.visualScores ?? {},
        loading: false,
        error: null,
        partial: payload.errors.length > 0,
      }
      setLive(value)
      remember(value)
    }
    const fail = (message: string, jobId?: string) => {
      if (jobId) clearIfCurrent(jobId)
      if (cancelled) return
      const value = { ...initialLive(false), error: message }
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
        if (status.status === 'done' && status.result) return finish(status.result, jobId)
        if (status.status === 'error') return fail(status.error ?? '검색 중 문제가 생겼어요.', jobId)
        timer = window.setTimeout(() => { void poll(jobId) }, 900)
      } catch (cause) {
        if (!cancelled) fail(cause instanceof Error && cause.message ? cause.message : '검색 결과를 확인하지 못했어요.', jobId)
      }
    }
    const begin = async () => {
      try {
        const stored = readStoredJob()
        const resumable = stored && stored.keyword === keyword
          && (stored.mode ?? 'ai') === mode
          && stored.reloadToken === reloadToken && stored.skipVisual === skipVisual
        // 더 찾아보기·작업 이어받기·새로고침처럼 같은 검색을 계속할 때만 점수를 되살린다.
        // 새 검색어에서는 이전 결과가 화면에 남아 있어도 점수를 절대 넘기지 않는다.
        const continuation = resumable || skipVisual > 0
        const priorVisualScores = priorScoresForSearch(stored, live, continuation)
        // page는 캐시 키와 무관하다. 처음 한 번만 전체를 조회한다.
        const job = resumable
          ? { jobId: stored.jobId, status: 'pending' }
          : await startBrowseJob(keyword, 1, API_ROWS, hints, filters, 200, skipVisual, priorVisualScores)
        if (cancelled) return
        writeStoredJob({
          jobId: job.jobId, keyword, reloadToken, skipVisual, mode,
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
  }, [keyword, reloadToken, skipVisual, hints, filters, analyzedKeyword, mode])

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
  const pages = Math.max(1, Math.ceil(live.total / API_ROWS))
  const appliedFilters = Object.values(filters).filter(Boolean).length
  const criteriaGroups = ['apiKeywords', 'include', 'any', 'exclude'] as const
  const showTiers = Boolean(keyword) && !live.loading && !live.error && items.length > 0

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
    if (keywordChanged || modeChanged) clearStoredJob()
    setParams(updated, { replace: true })
    if (keywordChanged) setKeyword(next)
    setMode(nextMode)
    if (!keywordChanged) setReloadToken(token => token + 1)
  }

  // 이미 본 사진만큼 건너뛰고 더 오래된 사진을 이어서 분석한다.
  function lookDeeper() {
    if (live.loading) return
    restoreSearchRef.current = null
    // 서버가 실제로 본 사진 수만큼만 건너뛴다. 0장이면 최소 1장만 더 진행해 같은 배치를 다시 본다.
    setSkipVisual(current => current + Math.max(live.visualScanned, 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function showAll() {
    clearStoredJob()
    clearStoredSearch()
    restoreAiRef.current = null
    restoreSearchRef.current = null
    setInput('')
    setKeyword('')
    const updated = new URLSearchParams(params)
    updated.delete('page')
    setParams(updated, { replace: true })
  }

  return <main id="main-content" className="content-workspace direct-search">
    <PageHeading title="직접 찾기" />
    <div className="direct-search__controls">
      <form className="direct-search__form" onSubmit={event => submitSearch(event, 'ai')}>
        <label className="search-section-title" htmlFor="direct-keyword">물건 검색</label>
        <div className="direct-search__form-row">
          <input
            id="direct-keyword"
            type="search"
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="예: 검정 가죽 지갑 (비우면 전체 목록)"
            maxLength={100}
          />
          <div className="direct-search__form-actions">
            <button type="button" className="button button--secondary" disabled={aiBusy} onClick={event => submitSearch(event, 'basic')}>일반 검색</button>
            <button type="submit" className="button button--primary" disabled={aiBusy}><Search aria-hidden="true" />{aiBusy ? '분석 중…' : 'AI 검색'}</button>
            {keyword && <button type="button" className="button button--secondary" onClick={showAll}>전체 보기</button>}
          </div>
        </div>
        <p className="direct-search__ai-hint">{mode === 'ai'
          ? 'AI가 적어둔 내용에서 중요한 말과 사진 특징을 뽑아 공개 사진까지 살펴봐요. 잘 맞는 물건부터 보여드려요.'
          : '적어둔 말로 공개 습득물을 바로 찾아요. 사진 분석 없이 빠르게 결과를 볼 수 있어요.'}</p>
      </form>
      <div className="direct-search__filters"><LostResultFilters compact colorOptions={colorOptions} showDirection={false} customDropdowns /></div>
    </div>
    {(aiBusy || live.loading) && <div className="direct-search__progress" role="status" aria-live="polite">
      <span className="direct-search__spinner" aria-hidden="true" />
      <span>{aiBusy
        ? 'AI가 검색어를 정리하고 있어요'
        : mode === 'basic'
          ? '공개 습득물을 찾고 있어요'
          : visualProgress.total > 0
            ? `AI가 공개 사진 ${Math.min(visualProgress.scanned, visualProgress.total)}/${visualProgress.total}장을 보고 있어요`
            : keyword ? 'AI가 찾아보고 있어요' : '공개 목록을 불러오고 있어요'}<span className="direct-search__dots" aria-hidden="true"><i /><i /><i /></span></span>
      {mode === 'ai' && !aiBusy && elapsed > 2 && <small>사진이 없어도 놓치지 않도록 넓게 살펴보는 중 · {elapsed}초</small>}
      {mode === 'ai' && !aiBusy && <small>다른 페이지로 가도 검색은 계속돼요.</small>}
    </div>}
    {mode === 'ai' && (hasSearchCriteria(criteria) || aiDates.from || aiDates.to) && !aiBusy && !live.loading && !live.error && <div className="lost-ai-criteria" role="status">
      <p className="lost-ai-criteria__title">AI가 적어둔 내용에서 알아챈 조건</p>
      <div className="lost-ai-criteria__chips">
        {criteriaGroups.filter(key => criteria[key].length > 0).map(key => <span key={key} className={'lost-ai-criteria__chip lost-ai-criteria__chip--' + key}><strong>{criteriaLabels[key]}</strong>{criteria[key].join(' · ')}</span>)}
        {(aiDates.from || aiDates.to) && <span className="lost-ai-criteria__chip"><strong>기간</strong>{[aiDates.from, aiDates.to].filter(Boolean).join(' ~ ')}</span>}
      </div>
      <p className="direct-search__ai-note">적어둔 말로 공개 정보를 넓게 찾아보고, 원하는 조건에 맞는 물건을 먼저 보여드렸어요. 사진이 닮은 물건도 앞쪽에 배치했어요.</p>
    </div>}
    {showTiers && mode === 'ai' && <div className="direct-search__tiers" role="note">
      <strong>표시 순서</strong>
      {TIER_LEGEND.map(tier => <span key={tier.label} className={'direct-search__tier direct-search__tier--' + tier.className}>{tier.label}</span>)}
    </div>}
    {live.partial && <p className="lost-results__partial" role="status">일부 공개 정보를 불러오지 못했어요. 확인 가능한 결과를 보여드려요.</p>}
    {live.loading ? <AiSearching label="AI가 공개 습득물 속에서 물건을 뒤지고 있어요" /> : live.error ? <EmptyState title="목록을 불러오지 못했어요" description={live.error + ' 잠시 뒤 다시 시도해 주세요.'} error><RetryButton onClick={reload} /></EmptyState>
      : <>
        <div className="direct-search__pagination-top">
          {(pages > 1 || live.total > API_ROWS) && <Pagination page={page} pages={pages} onChange={goToPage} inputId="direct-page-jump-top" position="top" />}
          <div className="direct-search__summary">
            <p className="direct-search__scope">경찰청 공개 습득물 · 공개 정보 {live.scanned.toLocaleString('ko-KR')}건 확인{appliedFilters ? ` · 선택 조건 ${appliedFilters}개 적용` : ''}</p>
            <p className="direct-search__count" role="status">{keyword ? `'${keyword}' 검색 결과 ` : '전체 목록 '}{live.total.toLocaleString('ko-KR')}건 중 {page}페이지 · 이 페이지 {items.length}건</p>
          </div>
        </div>
        {items.length ? <div className="gallery-result-grid direct-search__grid">
          {items.map(item => <FoundCard key={item.id} item={item} to={'/lost-found/item/' + (item.source ?? 'police') + '/' + encodeURIComponent((item.atcId ?? item.id) + ':' + (item.fdSn ?? '1')) + '?back=' + encodeURIComponent(back)} />)}
        </div> : <EmptyState title="조건에 맞는 물건이 없어요" description="다른 키워드나 검색 조건을 사용해 보세요.">
          {live.visualMore && <button type="button" className="button button--primary" onClick={lookDeeper}>더 찾아보기</button>}
          <button type="button" className="button button--secondary" onClick={showAll}>전체 목록 보기</button>
        </EmptyState>}
        {!live.loading && !live.error && keyword && live.visualMore && <div className="direct-search__deeper" role="region" aria-label="오래된 사진 추가 검색">
          <span>최신 사진 {live.visualScanned}장을 살펴봤어요. 아직 확인하지 않은 오래된 사진이 남아 있어요.</span>
          <button type="button" className="button button--secondary" onClick={lookDeeper}>더 찾아보기</button>
        </div>}
        {(pages > 1 || live.total > API_ROWS) && <Pagination page={page} pages={pages} onChange={goToPage} inputId="direct-page-jump-bottom" />}
      </>}
    <p className="field__help result-disclaimer">동일 물건인지와 보관 여부는 보관기관에 확인해 주세요.</p>
  </main>
}

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { readLostResultFilters } from '../search/lost-result-model'
import {
  dedupeLostFound, getBrowseJob, startBrowseJob, toCandidate,
  type BrowsePayload, type FoundItem, type LostBrowseFilters,
} from '../search/lostfound-api'
import { prepareAiSearch } from '../search/ai-search-api'
import { criteriaFromPlan, criteriaLabels, criteriaToHints, EMPTY_SEARCH_CRITERIA, hasSearchCriteria, type AiSearchCriteria } from '../search/ai-match-model'
import { EmptyState, FoundCard, PageHeading, Pagination, RetryButton } from './components'
import LostResultFilters from './LostResultFilters'
import '../../styles/gallery-search.css'
import '../../styles/lost-results.css'
import '../../styles/direct-search.css'

const API_ROWS = 40
const JOB_STORAGE_KEY = 'geugeo-eodi:direct-browse-job'

interface StoredJob {
  jobId: string
  keyword: string
  page: number
  reloadToken: number
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
  loading: boolean
  error: string | null
  partial: boolean
}
const initialLive = (loading: boolean): LiveState => ({
  raw: [], total: 0, scanned: 0, scanLimitReached: false,
  criteriaApplied: false, loading, error: null, partial: false,
})

const TIER_LEGEND = [
  { label: 'AI+검색어+필터', className: 'tier0' },
  { label: 'AI 조건', className: 'tier1' },
  { label: '검색어', className: 'tier2' },
  { label: '조건 필터', className: 'tier3' },
  { label: '부분 일치', className: 'tier4' },
  { label: '공개 원문', className: 'tier5' },
]

export default function DirectSearchPage() {
  const [params, setParams] = useSearchParams()
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [live, setLive] = useState<LiveState>(() => initialLive(true))
  const [reloadToken, setReloadToken] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [criteria, setCriteria] = useState<AiSearchCriteria>(EMPTY_SEARCH_CRITERIA)
  const [aiBusy, setAiBusy] = useState(false)
  // 분석이 끝난 검색어만 조회한다. AI 응답 전 원문 검색이 먼저 실행돼 깜빡이는 것을 막는다.
  const [analyzedKeyword, setAnalyzedKeyword] = useState('')
  const page = Math.max(1, Number(params.get('page')) || 1)
  const back = '/direct-search' + (params.size ? '?' + params.toString() : '')

  // AI 분석은 검색어가 바뀔 때만 한다. 필터 변경은 서버 조회만 다시 트리거한다.
  useEffect(() => {
    if (!keyword) {
      setCriteria(EMPTY_SEARCH_CRITERIA)
      setAiBusy(false)
      setAnalyzedKeyword('')
      return
    }
    let cancelled = false
    setAiBusy(true)
    prepareAiSearch('direct', keyword, [])
      .then(plan => {
        if (cancelled) return
        setCriteria(criteriaFromPlan(plan, keyword))
        setAnalyzedKeyword(keyword)
      })
      .catch(() => {
        if (cancelled) return
        // AI가 실패해도 원문 검색으로 공개 목록을 유지한다.
        setCriteria(EMPTY_SEARCH_CRITERIA)
        setAnalyzedKeyword(keyword)
      })
      .finally(() => { if (!cancelled) setAiBusy(false) })
    return () => { cancelled = true }
  }, [keyword])

  const hints = useMemo(() => criteriaToHints(criteria), [criteria])
  const filters = useMemo<LostBrowseFilters>(() => {
    const values = readLostResultFilters(params)
    return {
      category: values.category, color: values.color, region: values.region,
      from: values.from, to: values.to,
    }
  }, [params])

  // 검색은 서버 작업으로 넘긴다. 페이지를 옮기거나 탭을 닫아도 서버는 계속 진행하고,
  // 돌아오면 저장해 둔 jobId로 결과를 이어받는다.
  useEffect(() => {
    if (keyword && analyzedKeyword !== keyword) return
    let cancelled = false
    let timer: number | undefined
    setLive(initialLive(true))
    setElapsed(0)

    const finish = (payload: BrowsePayload) => {
      clearStoredJob()
      if (cancelled) return
      setLive({
        raw: payload.items,
        total: payload.total,
        scanned: payload.scanned,
        scanLimitReached: payload.scanLimitReached,
        criteriaApplied: payload.criteriaApplied,
        loading: false,
        error: null,
        partial: payload.errors.length > 0,
      })
    }
    const fail = (message: string) => {
      clearStoredJob()
      if (cancelled) return
      setLive({ ...initialLive(false), error: message })
    }
    const poll = async (jobId: string) => {
      try {
        const status = await getBrowseJob(jobId)
        if (cancelled) return
        if (status.status === 'done' && status.result) return finish(status.result)
        if (status.status === 'error') return fail(status.error ?? '검색 중 문제가 생겼어요.')
        timer = window.setTimeout(() => { void poll(jobId) }, 900)
      } catch (cause) {
        if (!cancelled) fail(cause instanceof Error && cause.message ? cause.message : '검색 결과를 확인하지 못했어요.')
      }
    }
    const begin = async () => {
      try {
        const stored = readStoredJob()
        const resumable = stored && stored.keyword === keyword && stored.page === page && stored.reloadToken === reloadToken
        const job = resumable
          ? { jobId: stored.jobId, status: 'pending' }
          : await startBrowseJob(keyword, page, API_ROWS, hints, filters)
        if (cancelled) return
        writeStoredJob({ jobId: job.jobId, keyword, page, reloadToken })
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
  }, [keyword, page, reloadToken, hints, filters, analyzedKeyword])

  // 로딩이 길어지면 경과 초를 보여준다.
  useEffect(() => {
    if (!live.loading) return
    const started = Date.now()
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [live.loading, keyword, reloadToken])

  // 서버가 필터와 중복 제거를 이미 적용했다. 화면에서는 표시용 후보만 만든다.
  const items = useMemo(() => dedupeLostFound(live.raw).map(item => toCandidate(item)), [live.raw])
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

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    const next = input.trim().replace(/\s+/g, ' ')
    const updated = new URLSearchParams(params)
    updated.delete('page')
    setParams(updated, { replace: true })
    if (next !== keyword) setKeyword(next)
    else setReloadToken(token => token + 1)
  }

  function showAll() {
    clearStoredJob()
    setInput('')
    setKeyword('')
    const updated = new URLSearchParams(params)
    updated.delete('page')
    setParams(updated, { replace: true })
  }

  return <main id="main-content" className="content-workspace direct-search">
    <PageHeading title="직접 찾기" />
    <div className="direct-search__controls">
      <form className="direct-search__form" onSubmit={submitSearch}>
        <label className="search-section-title" htmlFor="direct-keyword">물건 검색</label>
        <div className="direct-search__form-row">
          <input
            id="direct-keyword"
            type="search"
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="물건명 · 자연어 검색 · 비우면 전체 목록"
            maxLength={100}
          />
          <div className="direct-search__form-actions">
            <button type="submit" className="button button--primary" disabled={aiBusy}><Search aria-hidden="true" />{aiBusy ? '분석 중…' : '검색'}</button>
            {keyword && <button type="button" className="button button--secondary" onClick={showAll}>전체 보기</button>}
          </div>
        </div>
        <p className="direct-search__ai-hint">AI가 검색어의 핵심 명사와 AND/OR/NOT를 정리해 공개 정보를 넓게 찾아요. 점수 대신 일치 등급으로만 줄 세웁니다.</p>
      </form>
      <div className="direct-search__filters"><LostResultFilters compact colorOptions={colorOptions} showDirection={false} customDropdowns /></div>
    </div>
    {(aiBusy || live.loading) && <div className="direct-search__progress" role="status" aria-live="polite">
      <span className="direct-search__spinner" aria-hidden="true" />
      <span>{aiBusy ? 'AI가 검색어를 정리하고 있어요' : keyword ? 'AI가 찾아보고 있어요' : '공개 목록을 불러오고 있어요'}<span className="direct-search__dots" aria-hidden="true"><i /><i /><i /></span></span>
      {!aiBusy && elapsed > 2 && <small>공개 정보를 넓게 살펴보는 중 · {elapsed}초</small>}
      {!aiBusy && <small>다른 페이지로 가도 검색은 계속돼요.</small>}
    </div>}
    {hasSearchCriteria(criteria) && !aiBusy && !live.loading && !live.error && <div className="lost-ai-criteria" role="status">
      <p className="lost-ai-criteria__title">AI가 자연어에서 읽은 검색 조건</p>
      <div className="lost-ai-criteria__chips">{criteriaGroups.filter(key => criteria[key].length > 0).map(key => <span key={key} className={'lost-ai-criteria__chip lost-ai-criteria__chip--' + key}><strong>{criteriaLabels[key]}</strong>{criteria[key].join(' · ')}</span>)}</div>
      <p className="direct-search__ai-note">핵심 명사로 공개 정보를 넓게 조회하고 AND/OR/NOT 조건을 적용했어요. 같은 등급 안에서는 공개 API 순서를 유지합니다.</p>
    </div>}
    {showTiers && <div className="direct-search__tiers" role="note">
      <strong>표시 순서</strong>
      {TIER_LEGEND.map(tier => <span key={tier.label} className={'direct-search__tier direct-search__tier--' + tier.className}>{tier.label}</span>)}
    </div>}
    {live.partial && <p className="lost-results__partial" role="status">일부 공개 정보를 불러오지 못했어요. 확인 가능한 결과를 보여드려요.</p>}
    {live.loading ? <div className="gallery-result-grid direct-search__grid" aria-busy="true" aria-label="목록 로딩 상태">
      {Array.from({ length: 8 }, (_, index) => <div className="gallery-result-skeleton" key={index} />)}
    </div> : live.error ? <EmptyState title="목록을 불러오지 못했어요" description={live.error + ' 잠시 뒤 다시 시도해 주세요.'} error><RetryButton onClick={() => setReloadToken(token => token + 1)} /></EmptyState>
      : <>
        <div className="direct-search__pagination-top">
          {(pages > 1 || live.total > API_ROWS) && <Pagination page={page} pages={pages} onChange={goToPage} inputId="direct-page-jump-top" position="top" />}
          <div className="direct-search__summary">
            <p className="direct-search__scope">경찰청 공개 습득물 · 공개 정보 {live.scanned.toLocaleString('ko-KR')}건 스캔{appliedFilters ? ` 후 ${appliedFilters}개 필터 적용` : ''}{live.scanLimitReached ? ' (앞쪽 기준)' : ''}</p>
            <p className="direct-search__count" role="status">{keyword ? `'${keyword}' 검색 결과 ` : '전체 목록 '}{live.total.toLocaleString('ko-KR')}건 중 {page}페이지 · 화면 {items.length}건</p>
          </div>
        </div>
        {items.length ? <div className="gallery-result-grid direct-search__grid">
          {items.map(item => <FoundCard key={item.id} item={item} to={'/lost-found/item/' + (item.source ?? 'police') + '/' + encodeURIComponent((item.atcId ?? item.id) + ':' + (item.fdSn ?? '1')) + '?back=' + encodeURIComponent(back)} />)}
        </div> : <EmptyState title="조건에 맞는 물건이 없어요" description="다른 키워드나 검색 조건을 사용해 보세요."><button type="button" className="button button--secondary" onClick={showAll}>전체 목록 보기</button></EmptyState>}
        {(pages > 1 || live.total > API_ROWS) && <Pagination page={page} pages={pages} onChange={goToPage} inputId="direct-page-jump-bottom" />}
      </>}
    <p className="field__help result-disclaimer">동일 물건인지와 보관 여부는 보관기관에 확인해 주세요.</p>
  </main>
}

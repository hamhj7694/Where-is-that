import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { readLostResultFilters } from '../search/lost-result-model'
import { browseLostFound, dedupeLostFound, toCandidate, type FoundItem, type LostBrowseFilters } from '../search/lostfound-api'
import { prepareAiSearch } from '../search/ai-search-api'
import { criteriaFromPlan, criteriaLabels, criteriaToHints, EMPTY_SEARCH_CRITERIA, hasSearchCriteria, type AiSearchCriteria } from '../search/ai-match-model'
import { EmptyState, FoundCard, PageHeading, Pagination, RetryButton } from './components'
import LostResultFilters from './LostResultFilters'
import '../../styles/gallery-search.css'
import '../../styles/lost-results.css'
import '../../styles/direct-search.css'

const API_ROWS = 40

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

export default function DirectSearchPage() {
  const [params, setParams] = useSearchParams()
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [live, setLive] = useState<LiveState>(() => initialLive(true))
  const [reloadToken, setReloadToken] = useState(0)
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

  useEffect(() => {
    if (keyword && analyzedKeyword !== keyword) return
    let cancelled = false
    setLive(initialLive(true))
    browseLostFound(keyword, page, API_ROWS, hints, filters)
      .then(payload => {
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
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        const message = cause instanceof Error && cause.message ? cause.message : '목록을 불러오지 못했어요.'
        setLive({ ...initialLive(false), error: message })
      })
    return () => { cancelled = true }
  }, [keyword, page, reloadToken, hints, filters, analyzedKeyword])

  // 서버가 필터와 중복 제거를 이미 적용했다. 화면에서는 표시용 후보만 만든다.
  const items = useMemo(() => dedupeLostFound(live.raw).map(item => toCandidate(item)), [live.raw])
  const colorOptions = useMemo(
    () => Array.from(new Set(items.map(item => item.color.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko')),
    [items],
  )
  const pages = Math.max(1, Math.ceil(live.total / API_ROWS))
  const appliedFilters = Object.values(filters).filter(Boolean).length
  const criteriaGroups = ['apiKeywords', 'include', 'any', 'exclude'] as const

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
        <p className="direct-search__ai-hint">AI가 검색어의 핵심 명사와 AND/OR/NOT를 정리해 공개 정보를 넓게 찾은 뒤 조건으로 걸러요. 순위는 바꾸지 않아요.</p>
      </form>
      <div className="direct-search__filters"><LostResultFilters compact colorOptions={colorOptions} showDirection={false} customDropdowns /></div>
    </div>
    {aiBusy && <p className="direct-search__ai-note" role="status">AI가 검색어 조건을 정리하고 있어요…</p>}
    {hasSearchCriteria(criteria) && !aiBusy && !live.loading && !live.error && <div className="lost-ai-criteria" role="status">
      <p className="lost-ai-criteria__title">AI가 자연어에서 읽은 검색 조건</p>
      <div className="lost-ai-criteria__chips">{criteriaGroups.filter(key => criteria[key].length > 0).map(key => <span key={key} className={'lost-ai-criteria__chip lost-ai-criteria__chip--' + key}><strong>{criteriaLabels[key]}</strong>{criteria[key].join(' · ')}</span>)}</div>
      <p className="direct-search__ai-note">핵심 명사로 공개 정보를 넓게 조회하고 AND/OR/NOT 조건을 적용했어요. 공개 API 순서는 유지합니다.</p>
    </div>}
    {live.partial && <p className="lost-results__partial" role="status">일부 공개 정보를 불러오지 못했어요. 확인 가능한 결과를 보여드려요.</p>}
    {live.loading ? <div className="gallery-result-grid direct-search__grid" aria-busy="true" aria-label="목록 로딩 상태">
      {Array.from({ length: 8 }, (_, index) => <div className="gallery-result-skeleton" key={index} />)}
    </div> : live.error ? <EmptyState title="목록을 불러오지 못했어요" description="서버 연결을 확인한 뒤 다시 시도해 주세요." error><RetryButton onClick={() => setReloadToken(token => token + 1)} /></EmptyState>
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

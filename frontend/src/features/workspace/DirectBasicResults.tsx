import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { criteriaToHints, EMPTY_SEARCH_CRITERIA } from '../search/ai-match-model'
import { browseLostFound, dedupeLostFound, toCandidate, type BrowsePayload, type LostBrowseFilters } from '../search/lostfound-api'
import { lostFoundKeywordFallback, rankLostFoundKeywordMatches } from '../search/lostfound-keywords'
import { Pagination, RetryButton } from './components'

const BASIC_RESULTS_PAGE_SIZE = 12
const DESKTOP_PREVIEW_COUNT = 4
const MOBILE_PREVIEW_COUNT = 2

export default function DirectBasicResults({ keyword, filters, renderCard }: {
  keyword: string
  filters: LostBrowseFilters
  renderCard: (item: ReturnType<typeof toCandidate>) => ReactNode
}) {
  const [result, setResult] = useState<BrowsePayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [fallbackKeyword, setFallbackKeyword] = useState('')
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState(1)

  useEffect(() => {
    const controller = new AbortController()
    const find = (term: string) => browseLostFound(term, 1, 40, criteriaToHints(EMPTY_SEARCH_CRITERIA), filters, 200, 0, undefined, {
      searchMode: 'basic', signal: controller.signal,
    })

    async function loadResults() {
      try {
        const exact = await find(keyword)
        if (controller.signal.aborted) return
        const fallback = lostFoundKeywordFallback(keyword)
        if (exact.total > 0 || !fallback.keyword) {
          setResult(exact)
          return
        }
        setFallbackKeyword(fallback.keyword)
        const keywordResult = await find(fallback.keyword)
        if (controller.signal.aborted) return
        const items = rankLostFoundKeywordMatches(keywordResult.allItems?.length ? keywordResult.allItems : keywordResult.items, fallback.features)
        setResult({ ...keywordResult, allItems: items })
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    }
    // StrictMode의 첫 효과가 정리되면 취소된 조회를 서버에 보내지 않는다.
    queueMicrotask(() => {
      if (!controller.signal.aborted) void loadResults()
    })
    return () => controller.abort()
  }, [keyword, filters, retry])

  const items = result ? dedupeLostFound(result.allItems?.length ? result.allItems : result.items) : []
  const pages = Math.ceil(items.length / BASIC_RESULTS_PAGE_SIZE)
  const visible = expanded
    ? items.slice((page - 1) * BASIC_RESULTS_PAGE_SIZE, page * BASIC_RESULTS_PAGE_SIZE)
    : items.slice(0, DESKTOP_PREVIEW_COUNT)
  const partial = Boolean(result?.errors.length)
  const resultCount = `${items.length.toLocaleString('ko-KR')}건${partial ? ' · 일부 출처 조회 실패' : ''}`

  return <section className="direct-basic-results" aria-labelledby="direct-basic-results-title">
    <div className="direct-basic-results__heading">
      <h2 id="direct-basic-results-title">일반 검색 결과</h2>
      <span className="direct-basic-results__status" role="status">
        {result ? (fallbackKeyword ? `‘${fallbackKeyword}’ 키워드 · ${resultCount}` : resultCount)
          : failed ? '불러오지 못했어요.' : fallbackKeyword ? `‘${fallbackKeyword}’ 키워드로 찾는 중…` : '검색 중…'}
      </span>
      {failed && <RetryButton label="다시 시도" onClick={() => { setFailed(false); setFallbackKeyword(''); setRetry(value => value + 1) }} />}
      {items.length > MOBILE_PREVIEW_COUNT && <button type="button"
        className={'button button--secondary direct-basic-results__toggle' + (items.length <= DESKTOP_PREVIEW_COUNT ? ' direct-basic-results__toggle--mobile' : '')}
        aria-expanded={expanded} aria-controls="direct-basic-results-grid" onClick={() => setExpanded(value => !value)}>
        {expanded ? '일반 검색 결과 접기' : '일반 검색 결과 더 보기'}<ChevronDown aria-hidden="true" />
      </button>}
    </div>
    {visible.length > 0 && <div id="direct-basic-results-grid"
      className={'gallery-result-grid direct-search__grid direct-basic-results__grid' + (expanded ? '' : ' direct-basic-results__grid--preview')}>
      {visible.map(item => renderCard(toCandidate(item)))}
    </div>}
    {expanded && pages > 1 && <Pagination page={page} pages={pages} onChange={setPage} inputId="direct-basic-results-page" />}
  </section>
}

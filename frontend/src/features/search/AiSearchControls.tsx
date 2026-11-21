import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { prepareAiSearch, type AiPipelineMode, type AiSearchPlan } from './ai-search-api'
import { criteriaFromPlan, criteriaLabels, hasSearchCriteria } from './ai-match-model'

const channelLabels = { combined: '종합', image: '이미지 특징', context: '문맥·조건' } as const

export function AiSearchPlanView({ plan, originalQuery }: { plan: AiSearchPlan; originalQuery: string }) {
  const filters = [
    plan.filters.category && '분류 ' + plan.filters.category,
    plan.filters.region && '지역 ' + plan.filters.region,
    plan.filters.view && '방향 ' + plan.filters.view,
    plan.filters.fromDate && '시작 ' + plan.filters.fromDate,
    plan.filters.toDate && '종료 ' + plan.filters.toDate,
  ].filter(Boolean)
  return <section className="ai-plan" aria-label="AI 검색 조건 초안">
    <p className="ai-plan__original"><strong>입력한 내용</strong><span>{originalQuery.trim() || '사진으로 검색'}</span></p>
    <div className="ai-plan__channels">{Object.entries(plan.channels).map(([key, channel]) => <div key={key}>
      <strong>{channelLabels[key as keyof typeof channelLabels]}</strong><span>{channel.query || '정리된 조건 없음'}</span>
    </div>)}</div>
    {!!filters.length && <p className="ai-plan__filters"><strong>추천 필터</strong><span>{filters.join(' · ')}</span></p>}
    {(() => {
      const criteria = criteriaFromPlan(plan, originalQuery)
      if (!hasSearchCriteria(criteria)) return null
      return <div className="ai-plan__criteria">{(['apiKeywords', 'include', 'any', 'exclude', 'imageFeatures'] as const).filter(key => criteria[key].length > 0).map(key => <p key={key}><strong>{criteriaLabels[key]}</strong><span>{criteria[key].join(' · ')}</span></p>)}</div>
    })()}
    {!!plan.imageDescriptions.length && <details className="ai-plan__images"><summary>참고 사진에서 읽은 특징</summary><ul>{plan.imageDescriptions.map((description, index) => <li key={index}>{description}</li>)}</ul></details>}
    {!!plan.clarificationQuestions.length && <p className="ai-plan__questions">더 정확히 찾으려면: {plan.clarificationQuestions.join(' · ')}</p>}
    <p className="ai-plan__notice">AI가 정리한 검색 초안이에요. 결과는 공개 정보와 입력된 사진에 따라 달라질 수 있어요.</p>
  </section>
}

interface Props {
  mode: AiPipelineMode
  query: string
  images?: readonly File[]
  filters?: Record<string, string>
  plan?: AiSearchPlan
  onPlan: (plan: AiSearchPlan) => void
  onApply?: (plan: AiSearchPlan) => void
  buttonLabel?: string
  applyLabel?: string
}

export default function AiSearchControls({ mode, query, images = [], filters, plan, onPlan, onApply, buttonLabel = 'AI로 조건 정리', applyLabel = '이 조건으로 검색' }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function analyze() {
    setBusy(true)
    setError('')
    try {
      onPlan(await prepareAiSearch(mode, query, images, filters))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 검색 조건을 정리하지 못했어요.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="ai-search-controls">
    <div className="ai-search-controls__actions">
      <button type="button" className="button button--secondary" onClick={() => void analyze()} disabled={busy}>
        <Sparkles aria-hidden="true" />{buttonLabel}
      </button>
      {plan && onApply && <button type="button" className="button button--primary" onClick={() => onApply(plan)}>{applyLabel}</button>}
    </div>
    {plan && <AiSearchPlanView plan={plan} originalQuery={query} />}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>
}

import type { AiSearchPlan } from './ai-search-api'
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

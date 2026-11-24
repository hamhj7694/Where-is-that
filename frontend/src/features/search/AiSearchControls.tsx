import type { AiSearchPlan } from './ai-search-api'
import { criteriaFromPlan, criteriaLabels, hasSearchCriteria } from './ai-match-model'

const channelLabels = { combined: '핵심 내용', image: '사진 특징', context: '장소·조건' } as const

export function AiSearchPlanView({ plan, originalQuery }: { plan: AiSearchPlan; originalQuery: string }) {
  const filters = [
    plan.filters.category && '분류 ' + plan.filters.category,
    plan.filters.region && '지역 ' + plan.filters.region,
    plan.filters.view && '방향 ' + plan.filters.view,
    plan.filters.fromDate && '시작 ' + plan.filters.fromDate,
    plan.filters.toDate && '종료 ' + plan.filters.toDate,
  ].filter(Boolean)
  const criteria = criteriaFromPlan(plan, originalQuery)
  const hasCriteria = hasSearchCriteria(criteria)
  const summary = '정리한 검색 조건 보기'

  return <details className="ai-plan" aria-label="정리한 검색 조건">
    <summary className="ai-plan__summary">{summary}</summary>
    <div className="ai-plan__body">
      <div className="ai-plan__channels">{Object.entries(plan.channels).map(([key, channel]) => <div key={key}>
        <strong>{channelLabels[key as keyof typeof channelLabels]}</strong><span>{channel.query || '따로 정리할 내용 없음'}</span>
      </div>)}</div>
      {!!filters.length && <p className="ai-plan__filters"><strong>필터 제안</strong><span>{filters.join(' · ')}</span></p>}
      {hasCriteria && <div className="ai-plan__criteria">{(['apiKeywords', 'include', 'any', 'exclude', 'imageFeatures'] as const).filter(key => criteria[key].length > 0).map(key => <p key={key}><strong>{criteriaLabels[key]}</strong><span>{criteria[key].join(' · ')}</span></p>)}</div>}
      {!!plan.imageDescriptions.length && <div className="ai-plan__images"><strong>참고 사진에서 읽은 특징</strong><ul>{plan.imageDescriptions.map((description, index) => <li key={index}>{description}</li>)}</ul></div>}
      {!!plan.clarificationQuestions.length && <p className="ai-plan__questions">더 정확히 찾으려면: {plan.clarificationQuestions.join(' · ')}</p>}
      <p className="ai-plan__notice">입력한 말을 바탕으로 정리했어요. 결과는 공개 정보와 사진에 따라 달라질 수 있어요.</p>
    </div>
  </details>
}

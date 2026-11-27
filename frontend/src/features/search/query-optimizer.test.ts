import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSearchPlan } from './ai-search-api'

vi.mock('./ai-search-api', () => ({ prepareAiSearch: vi.fn() }))

import { prepareAiSearch } from './ai-search-api'
import { addGalleryCondition, createGalleryAssistantState } from './gallery-search-model'
import { assistantConditions, localAssistantUpdate, optimizedQueryFromPlan, prepareEditedAssistant, prepareOptimizedAssistant } from './query-optimizer'

function makePlan(overrides: Partial<AiSearchPlan> = {}): AiSearchPlan {
  return {
    originalQuery: '검정 지갑',
    imageDescriptions: [],
    channels: {
      combined: { query: '검정 지갑', keywords: [] },
      image: { query: '', keywords: [] },
      context: { query: '', keywords: [] },
    },
    filters: { category: '', region: '', view: '', fromDate: '', toDate: '' },
    clarificationQuestions: [],
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('AI 검색어 최적화', () => {
  it('AI가 만든 자연어 문구를 먼저 검색어로 쓴다', () => {
    const plan = makePlan({ refinedQuery: '금색 로고가 있는 검정 가죽 지갑' })
    expect(optimizedQueryFromPlan(plan, '검정 지갑\n금색 로고')).toBe('금색 로고가 있는 검정 가죽 지갑')
  })

  it('이전 응답에는 종합 채널 탐색어를 자연스러운 문장으로 바꿔 적는다', () => {
    const plan = makePlan({ channels: { ...makePlan().channels, combined: { query: '검정 가죽 지갑', keywords: [] } } })
    expect(optimizedQueryFromPlan(plan, '검정 지갑\n금색 로고')).toBe('검정 가죽 지갑에 맞는 물건을 찾아요')
  })

  it('AI 문구가 비어 있으면 원문도 자연스러운 문장으로 적는다', () => {
    expect(optimizedQueryFromPlan(makePlan({ channels: { ...makePlan().channels, combined: { query: '', keywords: [] } } }), '검정 지갑')).toBe('검정 지갑에 맞는 물건을 찾아요')
  })

  it(' 아직 담지 않은 입력 문구도 조건으로 올리되 중복은 넣지 않는다', () => {
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '금색 로고'), draft: '금색 로고' }
    expect(assistantConditions(state)).toEqual(['금색 로고'])
    expect(assistantConditions({ ...state, draft: '분실 장소: 신림역' })).toEqual(['금색 로고', '분실 장소: 신림역'])
  })

  it('원문·조건을 AI로 해석해 한 문장 검색어와 계획을 함께 담는다', async () => {
    const plan = makePlan({ refinedQuery: '신림역에서 잃어버린 금색 로고 검정 지갑' })
    vi.mocked(prepareAiSearch).mockResolvedValue(plan)
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '금색 로고'), draft: '분실 장소: 신림역' }

    const next = await prepareOptimizedAssistant('lost', state, '검정 지갑')

    expect(prepareAiSearch).toHaveBeenCalledWith('lost', '검정 지갑\n금색 로고\n분실 장소: 신림역', [], {})
    expect(next.optimizedQuery).toBe('신림역에서 잃어버린 금색 로고 검정 지갑')
    expect(next.aiPlan).toEqual(plan)
    expect(next.conditions).toEqual(['금색 로고', '분실 장소: 신림역'])
    expect(next.appliedConditions).toEqual(['금색 로고', '분실 장소: 신림역'])
    expect(next.draft).toBe('')
  })

  it('AI 실패 대비 상태는 조건 나열 방식으로 되돌린다', () => {
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '금색 로고'), optimizedQuery: '예전 문구' }
    const next = localAssistantUpdate(state)
    expect(next.optimizedQuery).toBeUndefined()
    expect(next.conditions).toEqual(['금색 로고'])
    expect(next.appliedConditions).toEqual(['금색 로고'])
  })

  it('편집한 문구를 그대로 쓰고 그 문구로 새 AI 조건을 만든다', async () => {
    const state = { ...createGalleryAssistantState(), optimizedQuery: '검정 지갑', aiPlan: makePlan() }
    const nextPlan = makePlan({ originalQuery: '파란 우산', refinedQuery: '접이식 파란 우산' })
    vi.mocked(prepareAiSearch).mockResolvedValue(nextPlan)

    const next = await prepareEditedAssistant('lost', state, ' 파란 우산 ')

    expect(prepareAiSearch).toHaveBeenCalledWith('lost', '파란 우산')
    expect(next.optimizedQuery).toBe('파란 우산')
    expect(next.aiPlan).toBe(nextPlan)
  })

  it('그대로 적용할 때는 기존 계획을 쓰고 편집한 문구의 AI 요청 실패 시에는 비운다', async () => {
    const state = { ...createGalleryAssistantState(), optimizedQuery: '검정 지갑', aiPlan: makePlan() }
    expect(await prepareEditedAssistant('lost', state, '검정 지갑')).toBe(state)
    expect(prepareAiSearch).not.toHaveBeenCalled()
    vi.mocked(prepareAiSearch).mockRejectedValue(new Error('AI unavailable'))
    expect(await prepareEditedAssistant('lost', state, '파란 우산')).toMatchObject({ optimizedQuery: '파란 우산', aiPlan: null })
  })
})

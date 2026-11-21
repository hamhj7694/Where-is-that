import { describe, expect, it } from 'vitest'
import type { AiSearchPlan } from './ai-search-api'
import {
  criteriaFromPlan, hasSearchCriteria, matchPublicItem, resolveApiKeyword,
  type AiSearchCriteria,
} from './ai-match-model'

const basePlan: AiSearchPlan = {
  originalQuery: '신림 근처에서 잃어버린 검은 가죽 지갑',
  imageDescriptions: ['어두운 남색 직사각형 지갑, 박음질과 지폐'],
  channels: {
    combined: { query: '검은 가죽 지갑', keywords: ['가죽', '지갑'] },
    image: { query: '어두운 지갑', keywords: ['어두운'] },
    context: { query: '신림 지갑', keywords: ['신림'] },
  },
  filters: { category: '', region: '', view: '', fromDate: '', toDate: '' },
  clarificationQuestions: [],
}

const item = {
  name: '남성용 반지갑',
  subject: '블랙 가죽 지갑을 습득',
  notes: '지폐가 들어 있음',
  category: '지갑 > 남성용 지갑',
  color: '블랙(검정)',
  foundPlace: '서울 관악구 신림동',
  storagePlace: '관악경찰서',
  orgName: '서울관악경찰서',
  address: '서울특별시 관악구',
  status: '보관중',
}

const criteria: AiSearchCriteria = {
  apiKeywords: ['지갑'],
  include: ['가죽', '지갑'],
  any: ['검정', '은색'],
  exclude: ['파손'],
  imageFeatures: ['박음질', '지폐'],
}

describe('AI 맞춤 검색 조건', () => {
  it('AI 조건을 그대로 사용하고 탐색어가 없으면 채널 계획에서 보완한다', () => {
    const plan = { ...basePlan, criteria: { ...criteria, apiKeywords: [] } }
    const result = criteriaFromPlan(plan, basePlan.originalQuery)
    expect(result.apiKeywords).toEqual(['검은 가죽 지갑', '어두운 지갑', '가죽'])
    expect(result.include).toEqual(['가죽', '지갑'])
    expect(result.exclude).toEqual(['파손'])
    expect(resolveApiKeyword(result, basePlan.originalQuery)).toBe('검은 가죽 지갑')
  })

  it('이전 기록에는 채널 키워드로 조건을 유도한다', () => {
    const result = criteriaFromPlan(basePlan, basePlan.originalQuery)
    expect(result.apiKeywords).toEqual(['검은 가죽 지갑', '어두운 지갑', '가죽'])
    expect(result.include).toEqual(['가죽', '지갑'])
    expect(result.any).toEqual([])
  })

  it('조건이 없으면 빈 조건으로 원문 검색을 유지한다', () => {
    expect(criteriaFromPlan(null, '지갑')).toEqual({ apiKeywords: [], include: [], any: [], exclude: [], imageFeatures: [] })
    expect(hasSearchCriteria(criteriaFromPlan(null, '지갑'))).toBe(false)
    expect(resolveApiKeyword(criteriaFromPlan(null, '지갑'), '지갑')).toBe('지갑')
  })

  it('과도한 표현은 개수와 길이를 제한한다', () => {
    const plan = {
      ...basePlan,
      criteria: {
        apiKeywords: Array.from({ length: 8 }, (_, index) => '키워드' + index),
        include: ['가죽', '가죽', 'x'.repeat(100)],
        any: [], exclude: [], imageFeatures: [],
      },
    }
    const result = criteriaFromPlan(plan, '지갑')
    expect(result.apiKeywords).toHaveLength(3)
    expect(result.include).toEqual(['가죽', 'x'.repeat(40)])
  })

  it('AND 조건을 모두 만족하면 만점 근거를 만든다', () => {
    const match = matchPublicItem(item, criteria)
    expect(match.excludedBy).toBeNull()
    expect(match.allInclude).toBe(true)
    expect(match.hits).toContain('가죽')
    expect(match.hits).toContain('검정')
    expect(match.hits).toContain('지폐')
    expect(match.score).toBeGreaterThan(70)
  })

  it('AND 중 일부만 있으면 일치 표시를 하지 않고 낮은 점수를 준다', () => {
    const match = matchPublicItem({ ...item, subject: '지갑을 습득', notes: '' }, criteria)
    expect(match.allInclude).toBe(false)
    expect(match.score).toBeLessThan(100)
    expect(match.hits).not.toContain('가죽')
  })

  it('OR 조건은 하나만 있어도 근거로 남고, NOT 조건은 제외 사유가 된다', () => {
    const orOnly = matchPublicItem(item, { ...criteria, include: [], any: ['은색', '검정'], imageFeatures: [] })
    expect(orOnly.hits).toEqual(['검정'])
    const excluded = matchPublicItem({ ...item, notes: '파손됨' }, criteria)
    expect(excluded.excludedBy).toBe('파손')
  })

  it('사진 특징만으로도 순위 점수를 만들고 조건이 없으면 원래 순서를 유지한다', () => {
    const imageOnly = matchPublicItem(item, { ...criteria, include: [], any: [], exclude: [], imageFeatures: ['지폐'] })
    expect(imageOnly.hits).toEqual(['지폐'])
    expect(imageOnly.score).toBeGreaterThan(0)
    expect(matchPublicItem(item, { apiKeywords: [], include: [], any: [], exclude: [], imageFeatures: [] })).toEqual({
      excludedBy: null, allInclude: false, hits: [], score: 0,
    })
  })

  it('띄어쓰기가 다른 복합어도 각 어절이 모두 있으면 일치한다', () => {
    const match = matchPublicItem(item, { ...criteria, include: ['가죽 지갑'], any: [], imageFeatures: [], exclude: [] })
    expect(match.allInclude).toBe(true)
    expect(match.hits).toEqual(['가죽 지갑'])
  })
})

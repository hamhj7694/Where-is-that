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

  it('사람 이름은 사진 특징에서 제외하고 공개 원문 탐색어로만 남긴다', () => {
    const plan = {
      ...basePlan,
      originalQuery: '류진',
      criteria: {
        apiKeywords: ['류진'], include: ['류진'], any: [], exclude: [],
        imageFeatures: ['류진', '검정색'],
      },
    }
    const result = criteriaFromPlan(plan, '류진')
    expect(result.apiKeywords).toContain('류진')
    expect(result.include).toContain('류진')
    expect(result.imageFeatures).toEqual(['검정색'])
  })

  it('캐릭터·브랜드 이름은 사진 특징으로 유지한다', () => {
    const plan = {
      ...basePlan,
      criteria: {
        apiKeywords: ['치이카와'], include: [], any: [], exclude: [],
        imageFeatures: ['치이카와', '신한카드'],
      },
    }
    expect(criteriaFromPlan(plan, '치이카와').imageFeatures).toEqual(['치이카와', '신한카드'])
  })

  it('AI가 고유 명사를 탐색어에서 빼먹으면 다시 넣는다', () => {
    const plan = {
      ...basePlan,
      criteria: {
        ...criteria,
        apiKeywords: ['카드'],
        include: ['치이카와', '카드'],
        imageFeatures: ['치이카와', '카드'],
      },
    }
    const result = criteriaFromPlan(plan, '치이카와 카드')
    expect(result.apiKeywords).toEqual(['치이카와', '카드'])
  })

  it('고유 명사를 되살릴 때 원래 탐색어와 색상까지 모두 밀어내지 않는다', () => {
    const plan = {
      ...basePlan,
      criteria: {
        ...criteria,
        apiKeywords: ['카드'],
        include: [],
        any: [],
        exclude: [],
        imageFeatures: ['검은색', '파란색', '치이카와'],
      },
    }
    const result = criteriaFromPlan(plan, '치이카와 카드')
    expect(result.apiKeywords).toContain('치이카와')
    expect(result.apiKeywords).toContain('카드')
  })

  it('탐색어가 꽉 차 있어도 고유 명사가 일반 명사 자리를 대신한다', () => {
    const plan = {
      ...basePlan,
      criteria: {
        ...criteria,
        apiKeywords: ['카드', '검은색', '파란색'],
        include: ['치이카와'],
        any: [], exclude: [], imageFeatures: [],
      },
    }
    const result = criteriaFromPlan(plan, '치이카와 카드')
    expect(result.apiKeywords).toContain('치이카와')
    expect(result.apiKeywords).toContain('카드')
    expect(result.apiKeywords).toHaveLength(3)
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

  it('공개 원문의 가려진 이름은 0글자 마스크여도 짧은 실명과 일치한다', () => {
    const named = { ...item, name: '여성지갑(류*진)', subject: '', notes: '' }
    const match = matchPublicItem(named, { apiKeywords: [], include: ['류진'], any: [], imageFeatures: [], exclude: [] })
    expect(match.allInclude).toBe(true)
    expect(match.hits).toEqual(['류진'])
  })
})

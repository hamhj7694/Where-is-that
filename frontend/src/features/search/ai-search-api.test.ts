import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareCandidates, prepareAiSearch, rankLostContextCandidates, type AiContextRankCandidate, type AiSearchPlan } from './ai-search-api'

const plan: AiSearchPlan = {
  originalQuery: '검은 지갑',
  imageDescriptions: [],
  channels: {
    combined: { query: '검은 지갑', keywords: ['검은색', '지갑'] },
    image: { query: '', keywords: [] },
    context: { query: '검은 지갑', keywords: ['검은색', '지갑'] },
  },
  filters: { category: '지갑', region: '', view: '', fromDate: '', toDate: '' },
  clarificationQuestions: [],
}
const contextCandidate: AiContextRankCandidate = {
  id: 'police:notice-1:1',
  name: '검정 카드지갑',
  subject: '앞면에 작은 금색 로고가 있어요.',
  notes: '내용: 교통카드 포함',
  category: '지갑 > 기타 지갑',
  color: '검정',
  foundDate: '2026-11-19',
  foundTime: '21',
  foundPlace: '서울 관악구 신림동',
  storagePlace: '관악경찰서',
  orgName: '서울관악경찰서',
  address: '서울특별시 관악구',
  status: '보관중',
  keepType: '경찰관서',
  placeName: '관악경찰서',
  placeAddress: '서울특별시 관악구',
  placeRoadAddress: '',
  placeCategory: '경찰서',
}

afterEach(() => vi.unstubAllGlobals())

describe('AI 검색 API', () => {
  it('분석 동의와 입력 조건을 서버에 전송하고 3채널 계획을 반환한다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(plan), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await expect(prepareAiSearch('lost', '검은 지갑', [], { region: '서울' })).resolves.toEqual(plan)

    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(request.method).toBe('POST')
    expect(JSON.parse(String(request.body))).toMatchObject({
      mode: 'lost',
      query: '검은 지갑',
      filters: { region: '서울' },
      externalProcessingConfirmed: true,
    })
  })

  it('키 미설정 등 서버 오류를 그대로 사용자에게 알린다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: 'ai_not_configured',
        message: 'AI API 키가 설정되지 않았어요.',
      },
    }), { status: 503 })))

    await expect(prepareAiSearch('direct', '지갑')).rejects.toThrow('AI API 키가 설정되지 않았어요.')
  })

  it('후보 설명과 습득·보관 장소의 전체 텍스트를 동의 표시와 함께 보낸다', async () => {
    const ranked = {
      id: contextCandidate.id,
      score: 90,
      reasons: ['상세 설명에 금색 로고가 있음'],
      locationRelation: 'possible_nearby',
      locationEvidence: '습득 장소가 서울 관악구 신림동으로 표시됨',
      uncertainty: '보관기관 위치가 실제 습득 위치와 다를 수 있음',
    }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [ranked] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await expect(rankLostContextCandidates({
      originalQuery: '정확하지는 않지만 신림역 인근에서 잃어버린 검은 지갑',
      searchQuery: '신림역 검은 지갑',
      imageDescriptions: [],
      filters: { region: '서울' },
      candidates: [contextCandidate],
    })).resolves.toEqual([ranked])

    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(String(request.body))
    expect(payload.candidateDataProcessingConfirmed).toBe(true)
    expect(payload.candidates[0]).toMatchObject({
      subject: contextCandidate.subject,
      notes: contextCandidate.notes,
      foundPlace: contextCandidate.foundPlace,
      storagePlace: contextCandidate.storagePlace,
      address: contextCandidate.address,
    })
  })

  it('후보 누락이나 중복이 있는 순위 응답은 적용하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 })))

    await expect(rankLostContextCandidates({
      originalQuery: '검은 지갑',
      searchQuery: '검은 지갑',
      imageDescriptions: [],
      filters: {},
      candidates: [contextCandidate],
    })).rejects.toThrow('일부 누락되거나 중복')
  })
})

describe('갤러리 AI 사진 비교', () => {
  beforeEach(() => {
    vi.stubGlobal('FileReader', class {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL() { this.result = 'data:image/png;base64,YQ=='; this.onload?.() }
    })
  })

  function input() {
    return {
      mode: 'gallery' as const,
      query: '바다 사진',
      references: [],
      candidates: [{ id: 'one', file: new File(['image'], 'one.jpg', { type: 'image/jpeg' }) }],
    }
  }

  it('종합·이미지·맥락 3축 점수를 그대로 반환한다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ id: 'one', score: 80, imageSimilarity: 95, contextRelevance: 60, reasons: ['파란 바다'] }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await expect(compareCandidates(input())).resolves.toEqual({
      results: [{ id: 'one', score: 80, imageSimilarity: 95, contextRelevance: 60, reasons: ['파란 바다'] }],
      referenceDescriptions: [],
    })

    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(request.body))).toMatchObject({
      mode: 'gallery', query: '바다 사진', externalProcessingConfirmed: true,
    })
  })

  it('서버가 축 점수를 생략하면 종합 점수로 채운다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ id: 'one', score: 70, reasons: [] }],
    }), { status: 200 })))

    const results = await compareCandidates(input())
    expect(results.results[0]).toMatchObject({ imageSimilarity: 70, contextRelevance: 70 })
  })

  it('참고 사진 분석 설명도 함께 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ id: 'one', score: 80, imageSimilarity: 95, contextRelevance: 60, reasons: [] }],
      referenceDescriptions: ['검정 가죽 지갑', 42, '카드가 보임'],
    }), { status: 200 })))

    const result = await compareCandidates(input())
    expect(result.referenceDescriptions).toEqual(['검정 가죽 지갑', '카드가 보임'])
  })
})

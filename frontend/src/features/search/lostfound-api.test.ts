import { afterEach, describe, expect, it, vi } from 'vitest'
import { browseLostFound, dedupeLostFound, formatDescription, formatFoundDateTime, searchLostFound, startBrowseJob, toCandidate, type FoundItem } from './lostfound-api'

afterEach(() => vi.unstubAllGlobals())

function foundItem(overrides: Partial<FoundItem> = {}): FoundItem {
  return {
    id: 'police:F2026111900004284:1',
    source: 'police',
    atcId: 'F2026111900004284',
    fdSn: '1',
    name: '카드지갑',
    subject: '카드지갑(블랙(검정)색)을 습득하였습니다.',
    category: '지갑 > 여성용 지갑',
    color: '블랙(검정)',
    imageUrl: null,
    foundDate: '2026-11-19',
    foundTime: '21',
    foundPlace: '노상',
    storagePlace: '매산지구대',
    orgName: '매산지구대',
    tel: '031-369-6428',
    status: '보관중',
    address: '경기 수원시 팔달구 북영대대로 944',
    notes: '특이사항',
    mapUrl: null,
    lat: null,
    lng: null,
    ...overrides,
  }
}

describe('공개 API 상세를 화면 후보로 변환', () => {
  it('보관상태·관리번호·조회 식별자와 습득 시간을 유지한다', () => {
    const candidate = toCandidate(foundItem(), true)
    expect(candidate.custodyStatus).toBe('보관중')
    expect(candidate.foundTime).toBe('21')
    expect(candidate.atcId).toBe('F2026111900004284')
    expect(candidate.fdSn).toBe('1')
  })

  it('보관구분·기관번호는 화면 후보에 전달하지 않는다', () => {
    const candidate = toCandidate(foundItem(), true)
    expect('custodyType' in candidate).toBe(false)
    expect('orgId' in candidate).toBe(false)
  })

  it('값이 없는 상세 정보는 null로 둔다', () => {
    const candidate = toCandidate(foundItem({ status: '', foundTime: '' }), true)
    expect(candidate.custodyStatus).toBeNull()
    expect(candidate.foundTime).toBeNull()
  })
})

describe('습득일시 표시', () => {
  it('날짜·요일·시각을 한 줄로 합친다', () => {
    expect(formatFoundDateTime('2026-11-19', '21')).toBe('2026-11-19 (목) 21시')
  })
  it('원본 시각 형식이 달라도 시각만 추출한다', () => {
    expect(formatFoundDateTime('2026-11-19', '2100')).toBe('2026-11-19 (목) 21시')
    expect(formatFoundDateTime('2026-11-19', '21:30')).toBe('2026-11-19 (목) 21시')
    expect(formatFoundDateTime('2026-11-19', '9')).toBe('2026-11-19 (목) 09시')
  })
  it('시각이 없으면 요일까지만 표시하고 날짜가 없으면 null이다', () => {
    expect(formatFoundDateTime('2026-11-19', '')).toBe('2026-11-19 (목)')
    expect(formatFoundDateTime(null, '21')).toBeNull()
  })
})

describe('AI 맞춤 조건 전달', () => {
  it('탐색어와 AND/OR/NOT·사진 특징을 hints로 함께 보낸다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      query: '지갑', sources: [], total: 0, items: [], errors: [], apiKeywords: ['지갑'], matched: 0,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await searchLostFound('지갑', 2, 40, {
      apiKeywords: ['지갑'], include: ['가죽'], any: ['검정'], exclude: ['파손'], imageFeatures: ['지폐'],
    })
    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(request.body))).toEqual({
      keyword: '지갑', page: 2, rows: 40,
      hints: { apiKeywords: ['지갑'], include: ['가죽'], any: ['검정'], exclude: ['파손'], imageFeatures: ['지폐'] },
    })
  })

  it('AI 조건이 없으면 hints를 보내지 않는다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      query: '지갑', sources: [], total: 0, items: [], errors: [],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await searchLostFound('지갑', 1, 40)
    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(request.body))).toEqual({ keyword: '지갑', page: 1, rows: 40 })
  })
})

describe('직접 찾기 서버 필터 조회', () => {
  it('필터·AI 조건·스캔 범위를 함께 전달한다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      query: '', sources: [], total: 0, items: [], errors: [],
      page: 1, rows: 40, scanned: 0, scanLimitReached: false,
      criteriaApplied: true, filtersApplied: {},
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await browseLostFound(
      '검은 가죽 지갑', 2, 40,
      { apiKeywords: ['지갑'], include: ['가죽'], any: [], exclude: ['파손'], imageFeatures: [] },
      { color: '블랙(검정)', region: '서울' },
      200,
    )
    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(request.body))).toEqual({
      keyword: '검은 가죽 지갑', page: 2, rows: 40, maxPages: 200, skipVisual: 0,
      hints: { apiKeywords: ['지갑'], include: ['가죽'], any: [], exclude: ['파손'], imageFeatures: [] },
      filters: { color: '블랙(검정)', region: '서울' },
    })
  })

  it('더 찾아보기는 건너뛸 사진 수를 서버 작업에 전달한다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ jobId: 'job-1', status: 'pending' }), { status: 200 },
    ))
    vi.stubGlobal('fetch', fetch)
    await startBrowseJob('치이카와', 1, 40, undefined, undefined, 200, 60, { 'police:card': 96 })
    const [, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(request.body))).toEqual({
      keyword: '치이카와', page: 1, rows: 40, maxPages: 200, skipVisual: 60,
      priorVisualScores: { 'police:card': 96 },
    })
  })
})

describe('화면 중복 제거', () => {
  it('제목과 사진 경로가 같으면 색상·습득일이 달라도 한 건만 남긴다', () => {
    const first = foundItem({ id: 'police:A:1', atcId: 'A', imageUrl: 'https://www.lost112.go.kr/img/banana.jpg', color: '노랑', foundDate: '2026-11-20' })
    const second = foundItem({ id: 'police:B:1', atcId: 'B', imageUrl: 'https://www.lost112.go.kr/img/banana.jpg?utm_source=test', color: '초록', foundDate: '2026-11-19' })
    expect(dedupeLostFound([first, second]).map(item => item.id)).toEqual(['police:A:1'])
  })

  it('사진이 없으면 기존 내용 키를 유지해 서로 다른 물건을 합치지 않는다', () => {
    const first = foundItem({ id: 'police:A:1', atcId: 'A', imageUrl: null, name: '바나나', color: '노랑' })
    const second = foundItem({ id: 'police:B:1', atcId: 'B', imageUrl: null, name: '바나나', color: '초록' })
    expect(dedupeLostFound([first, second]).map(item => item.id)).toEqual(['police:A:1', 'police:B:1'])
  })
})

describe('상세 설명 표시', () => {
  it('내용 접두어를 빼고 특이사항을 새 줄로 분리한다', () => {
    expect(formatDescription('내용 신당파출소에서는 습득/보관 하였습니다. 특이사항 : 없음'))
      .toBe('신당파출소에서는 습득/보관 하였습니다.\n특이사항 : 없음')
  })
  it('접두어가 없거나 특이사항이 없으면 원문을 유지한다', () => {
    expect(formatDescription('카드 수납 공간이 있는 지갑')).toBe('카드 수납 공간이 있는 지갑')
    expect(formatDescription('내용: 안내문')).toBe('안내문')
    expect(formatDescription(null)).toBe('')
  })
})

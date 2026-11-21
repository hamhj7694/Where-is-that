import { describe, expect, it } from 'vitest'
import type { Candidate } from './catalog-model'
import { inferRegion } from './lostfound-api'
import { filterCandidateRecords, lostResultFilterLabel } from './lost-result-model'

function candidate(patch: Partial<Candidate> = {}): Candidate {
  return {
    id: 'item', title: '지갑', image: null, photoStatus: 'no_photo',
    category: '지갑 > 여성용 지갑', color: '블랙(검정)', description: '',
    foundAt: null, foundPlace: null, custodyName: '종로2가지구대',
    officialUrl: null, matchReasons: [], location: { status: 'missing', address: null },
    ...patch,
  }
}

describe('공개 API 분류 기준 필터', () => {
  it('대분류를 고르면 하위 분류까지 포함하고 소분류는 정확히 일치한다', () => {
    const items = [
      candidate({ id: 'women', category: '지갑 > 여성용 지갑' }),
      candidate({ id: 'men', category: '지갑 > 남성용 지갑' }),
      candidate({ id: 'bag', category: '가방 > 여성용가방' }),
    ]
    expect(filterCandidateRecords(items, new URLSearchParams({ category: '지갑' })).map(i => i.id)).toEqual(['women', 'men'])
    expect(filterCandidateRecords(items, new URLSearchParams({ category: '지갑 > 여성용 지갑' })).map(i => i.id)).toEqual(['women'])
    expect(lostResultFilterLabel('category', '지갑 > 여성용 지갑')).toBe('지갑 > 여성용 지갑')
  })

  it('분실 예상 지역은 보관기관에서 유추한 시도로 찾는다', () => {
    const items = [
      candidate({ id: 'seoul', region: '서울' }),
      candidate({ id: 'gyeonggi', region: '경기' }),
      candidate({ id: 'unknown', region: null, foundPlace: '경기 · 샘플 장소' }),
    ]
    expect(filterCandidateRecords(items, new URLSearchParams({ region: '서울' })).map(i => i.id)).toEqual(['seoul'])
    expect(filterCandidateRecords(items, new URLSearchParams({ region: '경기' })).map(i => i.id)).toEqual(['gyeonggi', 'unknown'])
    expect(lostResultFilterLabel('region', '서울')).toBe('서울')
  })
})

describe('보관기관 위치에서 시도 유추', () => {
  it.each([
    ['서울남대문경찰서', '서울'],
    ['종로2가지구대', '서울'],
    ['회기파출소', '서울'],
    ['고양경찰서', '경기'],
    ['수원시청', '경기'],
    ['부산진경찰서', '부산'],
    ['제주경찰서', '제주'],
  ])('%s → %s', (place, expected) => {
    expect(inferRegion({ storagePlace: place, orgName: '', address: '' })).toBe(expected)
  })

  it('지역을 알 수 없으면 null을 돌려 임의로 걸러내지 않는다', () => {
    expect(inferRegion({ storagePlace: '주식회사 테이트', orgName: '', address: '' })).toBeNull()
  })
})

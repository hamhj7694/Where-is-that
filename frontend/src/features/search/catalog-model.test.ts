import { describe, expect, it } from 'vitest'
import {
  canShowMap, registrationComplete, selectSummary, transferPayload,
  type Candidate, type CandidateLocation, type StorageState,
} from './catalog-model'

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id, title: `후보 ${id}`, image: `/images/${id}.jpg`, photoStatus: 'verified_photo',
    category: '지갑', color: '검정', description: '공개 기록의 설명',
    foundAt: null, foundPlace: null, custodyName: null, officialUrl: null, matchReasons: ['분류'],
    location: { status: 'missing', address: null }, ...overrides,
  }
}

const verified: CandidateLocation = { status: 'verified', address: '검증된 보관기관 주소', latitude: 37.5, longitude: 127 }

describe('독립 검색 경로의 최대 5건 요약', () => {
  it.each([0, 1, 4, 5, 6])('실제 후보가 %i건이면 없는 후보로 채우지 않는다', count => {
    const image = Array.from({ length: count }, (_, index) => candidate(`image-${index}`))
    const context = Array.from({ length: count }, (_, index) => candidate(`context-${index}`))
    const summary = selectSummary(image, context)
    expect(summary.image.map(item => item.id)).toEqual(image.slice(0, 5).map(item => item.id))
    expect(summary.context.map(item => item.id)).toEqual(context.slice(0, 5).map(item => item.id))
  })

  it('실사진 상태와 실제 이미지 참조가 모두 있어야 이미지 요약에 표시한다', () => {
    const input = [
      candidate('no-photo', { photoStatus: 'no_photo', image: null }),
      candidate('invalid', { photoStatus: 'invalid' }),
      candidate('missing-url', { image: null }),
      candidate('empty-url', { image: '' }),
      candidate('blank-url', { image: '   ' }),
      candidate('valid'),
    ]
    expect(selectSummary(input, []).image.map(item => item.id)).toEqual(['valid'])
  })

  it('사진 없음이나 깨진 사진도 맥락 요약의 후보 자격을 잃지 않는다', () => {
    const context = [
      candidate('no-photo', { photoStatus: 'no_photo', image: null }),
      candidate('broken-photo', { photoStatus: 'invalid', image: null }),
      candidate('with-photo'),
    ]
    expect(selectSummary([], context).context).toEqual(context)
  })

  it('맥락 요약에서 실제 이미지 요약 중복만 빼고 뒤의 후보로 보충한다', () => {
    const image = Array.from({ length: 6 }, (_, index) => candidate(`same-${index}`))
    const context = [...image, ...Array.from({ length: 5 }, (_, index) => candidate(`next-${index}`))]
    const summary = selectSummary(image, context)
    expect(summary.image.map(item => item.id)).toEqual(['same-0', 'same-1', 'same-2', 'same-3', 'same-4'])
    expect(summary.context.map(item => item.id)).toEqual(['same-5', 'next-0', 'next-1', 'next-2', 'next-3'])
  })

  it('요약 중복 제거와 보충이 전체 보기의 원본 배열이나 후보를 변경하지 않는다', () => {
    const shared = candidate('shared')
    const image = Object.freeze([shared, candidate('second')])
    const context = Object.freeze([shared, candidate('text-only', { photoStatus: 'no_photo', image: null })])
    const original = structuredClone({ image, context })
    selectSummary(image, context)
    expect({ image, context }).toEqual(original)
    expect(context[0]).toBe(shared)
    expect(context).toHaveLength(2)
  })

  it('반복 레코드를 여러 카드로 채우지 않고 유효한 다음 후보를 사용한다', () => {
    const a = candidate('a')
    const b = candidate('b')
    const c = candidate('c')
    const summary = selectSummary([a, a, b], [a, c, c], 2)
    expect(summary.image.map(item => item.id)).toEqual(['a', 'b'])
    expect(summary.context.map(item => item.id)).toEqual(['c'])
  })

  it('호출자가 큰 limit을 넘겨도 제품의 최대 5건을 초과하지 않는다', () => {
    const items = Array.from({ length: 8 }, (_, index) => candidate(String(index)))
    expect(selectSummary(items, [], 20).image).toHaveLength(5)
    expect(selectSummary(items, items, 0)).toEqual({ image: [], context: [] })
  })
})

describe('상세 하단 지도 표시 게이트', () => {
  it('검증된 주소와 유효한 좌표가 모두 있을 때만 표시한다', () => {
    expect(canShowMap(verified)).toBe(true)
    expect(canShowMap({ ...verified, latitude: 0, longitude: 0 })).toBe(true)
  })

  it.each<CandidateLocation['status']>(['address_only', 'ambiguous', 'missing', 'provider_error'])(
    '%s 상태에서는 좌표가 있어도 지도에 핀을 표시하지 않는다', status => {
      expect(canShowMap({ ...verified, status })).toBe(false)
    },
  )

  it.each<Partial<CandidateLocation>>([
    { address: null }, { address: '  ' }, { latitude: undefined }, { longitude: undefined },
    { latitude: Number.NaN }, { longitude: Number.POSITIVE_INFINITY },
    { latitude: 90.1 }, { latitude: -90.1 }, { longitude: 180.1 }, { longitude: -180.1 },
  ])('verified 라벨만으로 누락·비정상 위치를 표시하지 않는다: %j', invalid => {
    expect(canShowMap({ ...verified, ...invalid })).toBe(false)
  })
})

describe('원본과 벡터의 등록 완료 계약', () => {
  it.each<[StorageState, StorageState, boolean]>([
    ['idle', 'idle', false], ['idle', 'saving', false], ['idle', 'saved', false], ['idle', 'failed', false],
    ['saving', 'idle', false], ['saving', 'saving', false], ['saving', 'saved', false], ['saving', 'failed', false],
    ['saved', 'idle', false], ['saved', 'saving', false], ['saved', 'saved', true], ['saved', 'failed', false],
    ['failed', 'idle', false], ['failed', 'saving', false], ['failed', 'saved', false], ['failed', 'failed', false],
  ])('원본 %s / 벡터 %s이면 완료 여부는 %s다', (originals, vectors, expected) => {
    expect(registrationComplete({ originals, vectors })).toBe(expected)
  })
})

describe('선택한 사진의 명시적 전달 확인', () => {
  it('사진을 선택했더라도 취소하거나 아직 확인하지 않았으면 페이로드가 없다', () => {
    expect(transferPayload('local-photo-1', false)).toBeNull()
  })
  it('확인한 선택 사진 식별자만 반환한다', () => {
    expect(transferPayload('local-photo-1', true)).toBe('local-photo-1')
  })
  it('확인했어도 빈 식별자로 전달을 만들지 않는다', () => {
    expect(transferPayload('', true)).toBeNull()
    expect(transferPayload('  ', true)).toBeNull()
  })
})


import { describe, expect, it } from 'vitest'
import type { Candidate } from './catalog-model'
import { filterCandidateRecords, isValidLostResultDate, LOST_RESULT_CHANNELS, lostResultChannelState, lostResultFilterLabel, readLostResultFilters, validateLostResultDates, type LostResultState } from './lost-result-model'
import { REFERENCE_PHOTO_VIEWS, type ReferencePhotoView } from './model'

function candidate(id: string, patch: Partial<Candidate> = {}): Candidate {
  return { id, title: id, image: '/sample.jpg', photoStatus: 'verified_photo', category: '지갑', color: '검정', description: '', foundAt: '2026-11-18', foundPlace: '서울 · 샘플 장소', custodyName: null, officialUrl: null, matchReasons: [], location: { status: 'missing', address: null }, ...patch }
}

describe('공개 후보 필터의 데이터 경계', () => {
  const front = candidate('front', { photoView: 'front' })
  const side = candidate('side', { photoView: 'side', category: '가방', color: '노랑', foundAt: '2026-11-17', foundPlace: '경기 · 샘플 장소' })
  const unspecified = candidate('unspecified', { photoView: 'unspecified' })
  const missingView = candidate('no-photo', { image: null, photoStatus: 'no_photo', foundAt: null, foundPlace: null })
  const items = Object.freeze([front, side, unspecified, missingView])

  it('기존 source/순서/원참조를 보존하고 조건 없으면 사진 없는 기록도 유지한다', () => {
    const result = filterCandidateRecords(items, new URLSearchParams('record=snapshot&page=2&state=error'))
    expect(result).toEqual(items)
    expect(result).not.toBe(items)
    expect(result[0]).toBe(front)
    expect(result[3]).toBe(missingView)
    expect(items).toHaveLength(4)
  })
  it.each(REFERENCE_PHOTO_VIEWS.map(option => [option.value, option.label]))('방향 %s는 명시된 후보 메타만 적용하고 칩은 %s로 표시한다', (view, label) => {
    const record = candidate('target', { photoView: view as ReferencePhotoView })
    expect(filterCandidateRecords([record], new URLSearchParams({ view }))).toEqual([record])
    expect(lostResultFilterLabel('view', view)).toBe(label)
  })
  it('방향 누락과 미지정을 같은 값으로 취급하고 사진 없는 후보도 임의 제거하지 않는다', () => {
    expect(filterCandidateRecords(items, new URLSearchParams('view=unspecified'))).toEqual([unspecified, missingView])
    expect(filterCandidateRecords(items, new URLSearchParams('view=front'))).toEqual([front])
  })
  it('잘못된 방향 URL은 전체 방향으로 복구하고 명시적으로 다른 방향을 고르지 않는다', () => {
    expect(readLostResultFilters(new URLSearchParams('view=AUTODETECTED')).view).toBe('')
    expect(filterCandidateRecords(items, new URLSearchParams('view=AUTODETECTED'))).toEqual(items)
    expect(filterCandidateRecords(items, new URLSearchParams('view=all'))).toEqual(items)
  })
  it('분류·색상·습득지역·방향을 함께 적용하고 습득지역과 기관을 혼동하지 않는다', () => {
    expect(filterCandidateRecords(items, new URLSearchParams({ category: '가방', color: '노랑', region: '경기', view: 'side' }))).toEqual([side])
    expect(filterCandidateRecords([candidate('institution', { foundPlace: '경기', custodyName: '서울 기관' })], new URLSearchParams({ region: '서울' }))).toEqual([])
    expect(filterCandidateRecords(items, new URLSearchParams({ category: '<script>' }))).toEqual([])
  })
  it('기간은 양 끝 날짜를 포함하며 해당 필드가 없는 기록은 기간 필터에서 제외한다', () => {
    expect(filterCandidateRecords(items, new URLSearchParams('from=2026-11-17&to=2026-11-18'))).toEqual([front, side, unspecified])
    expect(filterCandidateRecords(items, new URLSearchParams('from=2026-11-18&to=2026-11-18'))).toEqual([front, unspecified])
    expect(filterCandidateRecords(items, new URLSearchParams('to=2026-11-17'))).toEqual([side])
  })
  it('불가능한 날짜 URL은 무시하고 역전된 유효 기간은 정상 결과로 표현하지 않는다', () => {
    expect(filterCandidateRecords(items, new URLSearchParams('from=2026-02-30&to=invalid'))).toEqual(items)
    expect(filterCandidateRecords(items, new URLSearchParams('from=2026-11-19&to=2026-11-18'))).toEqual([])
    expect(validateLostResultDates({ from: '2026-11-19', to: '2026-11-18' })).toBe('종료일을 시작일 이후로 선택해 주세요.')
    expect(validateLostResultDates({ from: '2026/11/19', to: '2026/11/18' })).toBe('종료일을 시작일 이후로 선택해 주세요.')
    expect(validateLostResultDates({ from: '2026/11/18', to: '2026/11/19' })).toBeNull()
    expect(validateLostResultDates({ from: 'invalid', to: '' })).toBe('날짜를 올바르게 선택해 주세요.')
    expect(validateLostResultDates({ from: '', to: '' })).toBeNull()
  })
  it.each([['2024-02-29', true], ['2026-02-29', false], ['2026-13-01', false], ['2026-01-00', false], ['2026-1-1', false], ['0000-01-01', false], ['garbage', false]])('날짜 %s의 실제 달력을 검사한다', (value, valid) => {
    expect(isValidLostResultDate(value as string)).toBe(valid)
  })
})

describe('두 검색 원천과 세 결과 채널 상태', () => {
  it('종합/맥락/사진 특징 순서로 결과 채널을 제공한다', () => expect(LOST_RESULT_CHANNELS).toEqual(['combined', 'context', 'image']))
  it.each<[string, LostResultState, LostResultState]>([
    ['success', 'success', 'success'], ['loading', 'loading', 'loading'], ['empty', 'empty', 'empty'],
    ['error', 'error', 'error'], ['timeout', 'error', 'error'], ['api-error', 'error', 'error'],
    ['image-error', 'error', 'success'], ['context-error', 'success', 'error'],
    ['partial-image', 'error', 'success'], ['partial-context', 'success', 'error'],
    ['model-error', 'error', 'success'], ['image-loading', 'loading', 'success'],
    ['context-loading', 'success', 'loading'], ['image-empty', 'empty', 'success'],
    ['context-empty', 'success', 'empty'], ['interpretation-error', 'confirmation', 'confirmation'],
    ['needs-confirmation', 'confirmation', 'confirmation'], ['needs_confirmation', 'confirmation', 'confirmation'],
    ['consent-required', 'confirmation', 'confirmation'], ['stale', 'success', 'success'],
  ])('기존 state=%s의 image/context 동작을 유지한다', (state, image, context) => {
    const params = new URLSearchParams({ state })
    expect(lostResultChannelState(params, 'image')).toBe(image)
    expect(lostResultChannelState(params, 'context')).toBe(context)
  })
  it.each<[string, string, number, number, LostResultState]>([
    ['success', 'success', 3, 4, 'success'], ['success', 'success', 0, 4, 'success'],
    ['success', 'success', 0, 0, 'empty'], ['error', 'success', 7, 4, 'partial'],
    ['success', 'error', 3, 12, 'partial'], ['error', 'success', 7, 0, 'error'],
    ['success', 'error', 0, 7, 'error'], ['error', 'error', 7, 7, 'error'],
    ['loading', 'loading', 3, 3, 'loading'], ['confirmation', 'confirmation', 3, 3, 'confirmation'],
    ['loading', 'success', 3, 0, 'loading'], ['loading', 'success', 3, 4, 'partial'],
    ['confirmation', 'success', 3, 4, 'partial'], ['error', 'loading', 3, 3, 'error'],
    ['empty', 'empty', 3, 3, 'empty'], ['empty', 'error', 3, 3, 'error'],
  ])('image=%s/context=%s 후보 수 %i/%i → %s', (imageState, contextState, image, context, expected) => {
    expect(lostResultChannelState(new URLSearchParams({ imageState, contextState }), 'combined', { image, context })).toBe(expected)
  })
  it('잘못된 override는 기존 state로 복구하고 원천별 정상 재시도는 다른 오류를 감추지 않는다', () => {
    expect(lostResultChannelState(new URLSearchParams('state=image-error&imageState=invalid'), 'image')).toBe('error')
    const retry = new URLSearchParams('state=error&imageState=success')
    expect(lostResultChannelState(retry, 'image', { image: 4, context: 3 })).toBe('success')
    expect(lostResultChannelState(retry, 'context', { image: 4, context: 3 })).toBe('error')
    expect(lostResultChannelState(retry, 'combined', { image: 4, context: 3 })).toBe('partial')
  })
  it('명시 partial도 정상 후보 없이 오류나 0건을 부분 성공으로 위장하지 않는다', () => {
    expect(lostResultChannelState(new URLSearchParams('combinedState=partial&state=error'), 'combined', { image: 5, context: 5 })).toBe('error')
    expect(lostResultChannelState(new URLSearchParams('combinedState=partial'), 'combined', { image: 0, context: 0 })).toBe('empty')
    expect(lostResultChannelState(new URLSearchParams('combinedState=partial'), 'combined', { image: 2, context: 0 })).toBe('partial')
  })
  it.each(['error', 'empty', 'loading', 'confirmation'] as const)('명시 combinedState=%s를 원천 상태와 독립적으로 표시한다', combinedState => {
    expect(lostResultChannelState(new URLSearchParams({ combinedState }), 'combined', { image: 4, context: 4 })).toBe(combinedState)
  })
  it('상태 계산과 필터는 params를 변경하지 않는다', () => {
    const params = new URLSearchParams('record=snapshot&view=side&state=image-error&page=2')
    const before = params.toString()
    lostResultChannelState(params, 'combined', { image: 4, context: 3 })
    filterCandidateRecords([candidate('side', { photoView: 'side' })], params)
    expect(params.toString()).toBe(before)
  })
})

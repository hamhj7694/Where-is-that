import { describe, expect, it } from 'vitest'
import {
  addGalleryCondition, combineGalleryQuery, createGalleryAssistantState,
  editGalleryCondition, galleryConditionsChanged,
  AI_GALLERY_RANK_LIMIT, GALLERY_CHANNELS, GALLERY_PREVIEW_LIMIT, galleryPreviewItems,
  removeGalleryCondition, sortGalleryByRank, toGalleryRankMap, uniqueGalleryItems,
} from './gallery-search-model'

describe('갤러리 세 검색 채널의 미리보기', () => {
  it('종합·이미지·맥락 순서와 최대4개의 계약을 제공한다', () => {
    expect(GALLERY_CHANNELS).toEqual(['combined', 'image', 'context'])
    expect(GALLERY_PREVIEW_LIMIT).toBe(4)
  })

  it.each([0, 1, 2, 3, 4, 5, 7])('실제 %i개에서 채우지 않고 최대4개만 미리 보여준다', count => {
    const items = Array.from({ length: count }, (_, index) => ({ id: String(index), order: index }))
    const preview = galleryPreviewItems(items)
    expect(preview).toEqual(items.slice(0, 4))
    expect(items).toHaveLength(count)
    preview.forEach((item, index) => expect(item).toBe(items[index]))
  })

  it('한 채널의 ID 중복만 제거하고 첫 원참조·독립 순서를 보존한다', () => {
    const first = { id: 'same', name: '원본' }
    const second = { id: 'second', name: '다음' }
    const third = { id: 'third', name: '셋째' }
    const fourth = { id: 'fourth', name: '넷째' }
    const fifth = { id: 'fifth', name: '더보기의 첫 후보' }
    const source = Object.freeze([first, { id: 'same', name: '중복' }, second, third, fourth, fifth])
    expect(uniqueGalleryItems(source)).toEqual([first, second, third, fourth, fifth])
    expect(galleryPreviewItems(source)).toEqual([first, second, third, fourth])
    expect(galleryPreviewItems(source)[0]).toBe(first)
    expect(source).toHaveLength(6)
  })

  it('다른 채널에 이미 나온 ID도 제거하지 않는다', () => {
    const shared = { id: 'shared' }
    const combined = galleryPreviewItems([shared, { id: 'combined-only' }])
    const image = galleryPreviewItems([{ id: 'image-only' }, shared])
    const context = galleryPreviewItems([shared, { id: 'context-only' }])
    expect(combined[0]).toBe(shared)
    expect(image[1]).toBe(shared)
    expect(context[0]).toBe(shared)
  })
})

describe('검색 도우미의 명시적 조건 편집', () => {
  it('새 상태는 별도 배열을 가지며 열림은 화면이 결정한다', () => {
    const first = createGalleryAssistantState()
    const second = createGalleryAssistantState()
    expect(first).toEqual({ draft: '', conditions: [], appliedConditions: [], messages: [] })
    expect(first.conditions).not.toBe(second.conditions)
    expect(first.messages).not.toBe(second.messages)
    expect(first.appliedConditions).not.toBe(second.appliedConditions)
  })

  it('조건을 담기만 하고 기존 입력은 바꾸지 않으며 정적 안내만 추가한다', () => {
    const original = { ...createGalleryAssistantState(), draft: '  노란 가방  ', open: true }
    Object.freeze(original.conditions); Object.freeze(original.messages); Object.freeze(original)
    const next = addGalleryCondition(original, original.draft)
    expect(next.conditions).toEqual(['노란 가방'])
    expect(next.draft).toBe('')
    expect(next.open).toBe(true)
    expect(next.messages.map(message => [message.role, message.text])).toEqual([
      ['user', '노란 가방'], ['guide', '조건에 담았어요. 확인 후 다시 검색해 보세요.'],
    ])
    expect(new Set(next.messages.map(message => message.id)).size).toBe(2)
    expect(original.draft).toBe('  노란 가방  ')
    expect(original.conditions).toEqual([])
    expect(original.messages).toEqual([])
  })

  it('공백·동일 pending 조건은 입력문과 대화를 그대로 유지한다', () => {
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '노란 가방'), draft: '  편집 중\n' }
    expect(addGalleryCondition(state, ' \n ')).toBe(state)
    expect(addGalleryCondition(state, ' 노란 가방 ')).toBe(state)
    expect(state.draft).toBe('  편집 중\n')
    expect(state.messages).toHaveLength(2)
  })

  it('pending 조건 삭제는 대화와 아직 담지 않은 입력을 지우지 않는다', () => {
    const state = { ...addGalleryCondition(addGalleryCondition(createGalleryAssistantState(), '파란색'), '바닷가'), draft: '  취소해도 남길 문장\n', open: false }
    const next = removeGalleryCondition(state, 0)
    expect(next.conditions).toEqual(['바닷가'])
    expect(next.messages).toEqual(state.messages)
    expect(next.draft).toBe(state.draft)
    expect(next.open).toBe(false)
    expect(state.conditions).toEqual(['파란색', '바닷가'])
    expect(removeGalleryCondition(state, -1)).toBe(state)
    expect(removeGalleryCondition(state, 2)).toBe(state)
    expect(removeGalleryCondition(state, 0.5)).toBe(state)
  })

  it('삭제한 조건을 다시 담을 수 있으며 과거 대화는 보존한다', () => {
    const first = addGalleryCondition(createGalleryAssistantState(), '파란색')
    const next = addGalleryCondition(removeGalleryCondition(first, 0), '파란색')
    expect(next.conditions).toEqual(['파란색'])
    expect(next.messages).toHaveLength(4)
    expect(next.messages[0]).toBe(first.messages[0])
  })

  it('검색어 결합은 빈 줄만 제거하고 단어·내부 공백·조건 순서를 보존한다', () => {
    expect(combineGalleryQuery('  여행  사진\r\n\r\n제주  바닷가  ', ['\n', '파란  가방', '2024년\n\n여름'])).toBe('여행  사진\n제주  바닷가  \n파란  가방\n2024년\n여름')
    expect(combineGalleryQuery('', ['손글씨 일정표'])).toBe('손글씨 일정표')
    expect(combineGalleryQuery('\n ', ['\t'])).toBe('')
  })

  it('조건 편집은 마지막 대응 user 메시지만 바꾸고 적용 조건·이전 대화·입력은 보존한다', () => {
    const first = addGalleryCondition(createGalleryAssistantState(), '파란색')
    const readded = addGalleryCondition(removeGalleryCondition(first, 0), '파란색')
    const state = { ...readded, draft: '  작성 중인 글\n', appliedConditions: ['파란색'], open: true }
    const next = editGalleryCondition(state, 0, '  노란색  ')
    expect(next.conditions).toEqual(['노란색'])
    expect(next.messages[0]).toBe(state.messages[0])
    expect(next.messages[0].text).toBe('파란색')
    expect(next.messages[2]).toEqual({ ...state.messages[2], text: '노란색' })
    expect(next.messages[3]).toBe(state.messages[3])
    expect(next.appliedConditions).toEqual(['파란색'])
    expect(next.draft).toBe('  작성 중인 글\n')
    expect(next.open).toBe(true)
    expect(state.conditions).toEqual(['파란색'])
    expect(state.messages[2].text).toBe('파란색')
  })

  it('빈 값·다른 조건 중복·없는 위치 편집은 상태를 그대로 반환한다', () => {
    const state = addGalleryCondition(addGalleryCondition(createGalleryAssistantState(), '파란색'), '바닷가')
    expect(editGalleryCondition(state, 0, ' \n ')).toBe(state)
    expect(editGalleryCondition(state, 0, ' 바닷가 ')).toBe(state)
    expect(editGalleryCondition(state, 0, '파란색')).toBe(state)
    expect(editGalleryCondition(state, -1, '노랑')).toBe(state)
    expect(editGalleryCondition(state, 2, '노랑')).toBe(state)
    expect(editGalleryCondition(state, 0.5, '노랑')).toBe(state)
  })

  it('대응 메시지가 없는 복원 조건도 내용을 잃지 않고 편집한다', () => {
    const state = { ...createGalleryAssistantState(), conditions: ['복원한 조건'] }
    expect(editGalleryCondition(state, 0, '바뀐 조건')).toEqual({ ...state, conditions: ['바뀐 조건'] })
    expect(state.conditions).toEqual(['복원한 조건'])
  })

  it('조건 변경·삭제·순서 차이를 이전 적용 상태와 비교한다', () => {
    expect(galleryConditionsChanged(createGalleryAssistantState())).toBe(false)
    expect(galleryConditionsChanged({ draft: '미확정 글만 있음', conditions: [], messages: [] })).toBe(false)
    const state = { ...createGalleryAssistantState(), conditions: ['파란색', '바닷가'], appliedConditions: ['파란색', '바닷가'] }
    expect(galleryConditionsChanged(state)).toBe(false)
    expect(galleryConditionsChanged(editGalleryCondition(state, 0, '노랑'))).toBe(true)
    expect(galleryConditionsChanged(removeGalleryCondition(state, 0))).toBe(true)
    expect(galleryConditionsChanged({ ...state, conditions: [] })).toBe(true)
    expect(galleryConditionsChanged({ ...state, conditions: ['바닷가', '파란색'] })).toBe(true)
  })

  it('조건 조합 계산은 적용 상태와 원래 질의를 바꾸지 않는다', () => {
    const base = '여행 사진\n제주 바다'
    const initial = createGalleryAssistantState()
    const added = addGalleryCondition(initial, '파란 가방')
    expect(combineGalleryQuery(base, added.conditions)).toBe('여행 사진\n제주 바다\n파란 가방')
    const edited = editGalleryCondition(added, 0, '노란 가방')
    expect(combineGalleryQuery(base, edited.conditions)).toBe('여행 사진\n제주 바다\n노란 가방')
    const removed = removeGalleryCondition(edited, 0)
    expect(combineGalleryQuery(base, removed.conditions)).toBe(base)
    expect(initial.conditions).toEqual([])
    expect(added.conditions).toEqual(['파란 가방'])
    expect(edited.conditions).toEqual(['노란 가방'])
    expect(removed.appliedConditions).toEqual([])
    expect(base).toBe('여행 사진\n제주 바다')
  })
})

describe('AI 사진 분석 3축 정렬', () => {
  const ranking = toGalleryRankMap([
    { id: 'a', score: 90, imageSimilarity: 20, contextRelevance: 70, reasons: [] },
    { id: 'b', score: 50, imageSimilarity: 95, contextRelevance: 40, reasons: [] },
    { id: 'c', score: 70, imageSimilarity: 60, contextRelevance: 85, reasons: [] },
  ])
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'unscored' }]

  it('AI 비교는 한 번에 최대 12후보다', () => {
    expect(AI_GALLERY_RANK_LIMIT).toBe(12)
  })

  it('종합 채널은 종합 관련성 순서다', () => {
    expect(sortGalleryByRank(items, ranking, 'combined').map(item => item.id)).toEqual(['a', 'c', 'b', 'unscored'])
  })

  it('이미지 채널은 이미지 유사도 순서다', () => {
    expect(sortGalleryByRank(items, ranking, 'image').map(item => item.id)).toEqual(['b', 'c', 'a', 'unscored'])
  })

  it('맥락 채널은 맥락 관련성 순서다', () => {
    expect(sortGalleryByRank(items, ranking, 'context').map(item => item.id)).toEqual(['c', 'a', 'b', 'unscored'])
  })

  it('분석 결과가 없으면 원래 연결 순서를 유지한다', () => {
    expect(sortGalleryByRank(items, null, 'combined')).toEqual(items)
  })

  it('점수 맵은 3축만 담고 원본 reasons는 버린다', () => {
    expect(ranking).toEqual({
      a: { score: 90, imageSimilarity: 20, contextRelevance: 70 },
      b: { score: 50, imageSimilarity: 95, contextRelevance: 40 },
      c: { score: 70, imageSimilarity: 60, contextRelevance: 85 },
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createSearchRecord, disconnectGalleryHistory, findSearchRecord, overwriteGallerySearch, recordPath, refineGalleryRecord, removeSearchRecord, resolveGalleryAssistant, updateSearchAssistant, type SearchRecord } from './history'
import { addGalleryCondition, createGalleryAssistantState, editGalleryCondition, galleryConditionsChanged, removeGalleryCondition, type GalleryAssistantState } from './gallery-search-model'

const image = new File(['image'], 'photo.jpg', { type: 'image/jpeg' })

describe('찾은 기록의 세션 스냅샷', () => {
  it('이후 입력과 갤러리 배열이 바뀌어도 검색 당시의 내용과 파일을 유지한다', () => {
    const draft = { query: '  바닷가 사진  ', photo: image }
    const gallery = { name: '여행', files: [image] }
    const record = createSearchRecord('gallery', draft, gallery)
    draft.query = '업무 메모'
    gallery.name = '업무'; gallery.files.length = 0
    expect(record.draft).toEqual({ query: '바닷가 사진', photo: image })
    expect(record.gallery).toEqual({ name: '여행', files: [image] })
    expect(record.gallery?.files[0]).toBe(image)
  })

  it('분실물 기록에 개인 갤러리 모집단을 넣지 않는다', () => {
    const record = createSearchRecord('lost', { query: '', photo: image }, { name: '개인 폴더', files: [image] })
    expect(record.gallery).toBeNull()
    expect(record.draft.photo).toBe(image)
    expect(recordPath(record)).toBe('/lost-found/results?record=' + record.id)
    expect(recordPath(record)).not.toContain(image.name)
  })

  it('다른 모드·만료된 ID를 현재 입력으로 대체하지 않는다', () => {
    const record = createSearchRecord('lost', { query: '검정 지갑', photo: null }, null)
    expect(findSearchRecord([record], record.id, 'lost')).toBe(record)
    expect(findSearchRecord([record], record.id, 'gallery')).toBeUndefined()
    expect(findSearchRecord([record], 'expired', 'lost')).toBeUndefined()
    expect(findSearchRecord([], record.id, 'lost')).toBeUndefined()
  })

  it('갤러리 연결 해제는 갤러리 파일 참조를 가진 기록만 정리한다', () => {
    const gallery = createSearchRecord('gallery', { query: '사진', photo: null }, { name: '갤러리', files: [image] })
    const lost = createSearchRecord('lost', { query: '지갑', photo: null }, null)
    expect(disconnectGalleryHistory([lost, gallery])).toEqual([lost])
    expect(gallery.gallery?.files).toEqual([image])
  })

  it('같은 검색어·사진의 기록도 선택한 ID 한 건만 삭제한다', () => {
    const source = { name: '갤러리', files: [image] }
    const first = createSearchRecord('gallery', { query: '내용', photo: image }, source)
    const second = createSearchRecord('gallery', { query: '내용', photo: image }, source)
    const lost = createSearchRecord('lost', { query: '내용', photo: image }, null)
    const records = [first, second, lost]
    const next = removeSearchRecord(records, first.id)
    expect(next).toEqual([second, lost])
    expect(findSearchRecord(next, first.id, 'gallery')).toBeUndefined()
    expect(records).toEqual([first, second, lost])
    expect(source.files).toEqual([image])
    expect(second.draft.photo).toBe(image)
  })

  it('존재하지 않는 ID를 삭제해도 다른 기록을 지우지 않는다', () => {
    const record = createSearchRecord('lost', { query: '지갑', photo: null }, null)
    expect(removeSearchRecord([record], 'missing-id')).toEqual([record])
  })

  it('마지막 기록을 삭제하면 빈 목록이 된다', () => {
    const record = createSearchRecord('gallery', { query: '사진', photo: image }, { name: '갤러리', files: [image] })
    expect(removeSearchRecord([record], record.id)).toEqual([])
  })
})

describe('찾은 이미지의 검색 도우미와 새 검색 기록', () => {
  it('조건 편집은 해당 갤러리 기록만 바꾸고 새 기록·F2 변경을 만들지 않는다', () => {
    const source = { name: '원래 갤러리', files: [image] }
    const parent = createSearchRecord('gallery', { query: '여행', photo: image }, source)
    const other = createSearchRecord('gallery', { query: '업무', photo: null }, source)
    const lost = createSearchRecord('lost', { query: '지갑', photo: image }, source)
    const records = [parent, other, lost]
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '바닷가'), draft: '  아직 담지 않은 문장 ', open: true }
    const next = updateSearchAssistant(records, parent.id, state)
    expect(next).toHaveLength(3)
    expect(next[0].id).toBe(parent.id)
    expect(next[0].createdAt).toBe(parent.createdAt)
    expect(next[0].draft).toBe(parent.draft)
    expect(next[0].gallery).toBe(parent.gallery)
    expect(next[0].assistant).toEqual(state)
    expect(next[0].assistant?.conditions).not.toBe(state.conditions)
    expect(next[0].assistant?.messages).not.toBe(state.messages)
    expect(next[1]).toBe(other)
    expect(next[2]).toBe(lost)
    expect(parent.assistant).toBeUndefined()
    expect(records).toEqual([parent, other, lost])
  })

  it('도우미를 닫고 다시 열어도 pending 조건·대화·작성 중 문자열은 유지한다', () => {
    const parent = createSearchRecord('gallery', { query: '사진', photo: null }, { name: '갤러리', files: [image] })
    parent.assistant = { ...addGalleryCondition(createGalleryAssistantState(), '파란색'), draft: '  나중에 이어 쓸 문장\n' }
    const closed = updateSearchAssistant([parent], parent.id, { open: false })
    const opened = updateSearchAssistant(closed, parent.id, { open: true })
    expect(opened[0].assistant).toEqual({ ...parent.assistant, open: true })
    expect(parent.assistant.open).toBeUndefined()
  })

  it('다른 모드·없는 ID에는 도우미를 만들지 않는다', () => {
    const lost = createSearchRecord('lost', { query: '지갑', photo: null }, null)
    expect(updateSearchAssistant([lost], lost.id, { draft: '추가 조건' })[0]).toBe(lost)
    expect(updateSearchAssistant([lost], 'missing', { open: true })[0]).toBe(lost)
    expect(lost.assistant).toBeUndefined()
  })

  it('확인 후 다시 검색할 때만 새 ID·시각과 결합된 질의의 자식 기록을 만든다', () => {
    const source = { name: '여행', files: [image] }
    const parent = createSearchRecord('gallery', { query: '제주 사진', photo: image }, source)
    const assistant = { ...addGalleryCondition(addGalleryCondition(createGalleryAssistantState(), '파란 가방'), '2024년'), draft: '미확정 입력은 새 질의에 넣지 않기', open: true }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(parent.createdAt + 100)
    let child
    try { child = refineGalleryRecord(parent, assistant) } finally { clock.mockRestore() }
    expect(child).not.toBeNull()
    expect(child!.id).not.toBe(parent.id)
    expect(child!.createdAt).toBe(parent.createdAt + 100)
    expect(child!.parentRecordId).toBe(parent.id)
    expect(child!.draft).toEqual({ query: '제주 사진\n파란 가방\n2024년', photo: image })
    expect(child!.gallery).toEqual(parent.gallery)
    expect(child!.gallery).not.toBe(parent.gallery)
    expect(child!.gallery!.files).not.toBe(parent.gallery!.files)
    expect(child!.gallery!.files[0]).toBe(image)
    expect(parent.draft.query).toBe('제주 사진')
    expect(parent.assistant).toBeUndefined()
    expect(assistant.conditions).toEqual(['파란 가방', '2024년'])
  })

  it('새 기록은 대화·열림과 적용 조건을 상속하고 미확정 입력만 비우며 독립 복사한다', () => {
    const parent = createSearchRecord('gallery', { query: '여행', photo: image }, { name: '갤러리', files: [image] })
    const assistant = { ...addGalleryCondition(createGalleryAssistantState(), '바닷가'), draft: '  미확정 ', open: false }
    const child = refineGalleryRecord(parent, assistant)!
    expect(child.assistant).toEqual({ ...assistant, draft: '', conditions: ['바닷가'], appliedConditions: ['바닷가'] })
    expect(child.assistant!.messages).not.toBe(assistant.messages)
    expect(child.assistant!.messages[0]).not.toBe(assistant.messages[0])
    expect(child.assistant!.conditions).not.toBe(assistant.conditions)
    child.assistant!.messages[0].text = '새 기록만 바꾸기'
    child.gallery!.files.length = 0
    expect(assistant.messages[0].text).toBe('바닷가')
    expect(parent.gallery!.files).toEqual([image])
    expect(assistant.draft).toBe('  미확정 ')
  })

  it('pending 조건이 없거나 F2·갤러리 소스 없는 기록에서는 새 검색을 만들지 않는다', () => {
    const gallery = createSearchRecord('gallery', { query: '사진', photo: null }, { name: '갤러리', files: [image] })
    const pending = addGalleryCondition(createGalleryAssistantState(), '바닷가')
    expect(refineGalleryRecord(gallery, createGalleryAssistantState())).toBeNull()
    expect(refineGalleryRecord(gallery, { ...pending, conditions: ['\n ', '\t'] })).toBeNull()
    expect(refineGalleryRecord(createSearchRecord('gallery', { query: '사진', photo: image }, null), pending)).toBeNull()
    expect(refineGalleryRecord(createSearchRecord('lost', { query: '지갑', photo: image }, null), pending)).toBeNull()
  })

  it('같은 내용으로 다시 검색해도 기록을 임의 병합하지 않는다', () => {
    const parent = createSearchRecord('gallery', { query: '사진', photo: null }, { name: '갤러리', files: [image] })
    const pending = addGalleryCondition(createGalleryAssistantState(), '바닷가')
    const first = refineGalleryRecord(parent, pending)!
    const second = refineGalleryRecord(parent, pending)!
    expect(first.id).not.toBe(second.id)
    expect(first.draft).toEqual(second.draft)
    expect(first.parentRecordId).toBe(parent.id)
    expect(second.parentRecordId).toBe(parent.id)
  })
})

describe('같은 검색 기록에서 검색어·참고 사진 수정', () => {
  it('ID·시각·갤러리 스냅샷·부모 관계를 유지하고 도우미만 초기화한다', () => {
    const parent = createSearchRecord('gallery', { query: '원래 검색', photo: image }, { name: '원래 갤러리', files: [image] })
    const child = refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '파란색'))!
    const sibling = createSearchRecord('gallery', { query: '다른 검색', photo: null }, parent.gallery)
    const lost = createSearchRecord('lost', { query: '분실물', photo: image }, null)
    const replacement = new File(['replacement'], 'new.png', { type: 'image/png' })
    const records = [child, sibling, parent, lost]
    const input = { query: '  수정한 검색\n줄바꿈 유지  ', photo: replacement }
    const next = overwriteGallerySearch(records, child.id, input)
    expect(next).toHaveLength(records.length)
    expect(next[0].id).toBe(child.id)
    expect(next[0].createdAt).toBe(child.createdAt)
    expect(next[0].parentRecordId).toBe(parent.id)
    expect(next[0].gallery).toBe(child.gallery)
    expect(next[0].draft).toEqual({ query: '수정한 검색\n줄바꿈 유지', photo: replacement })
    expect(next[0].assistantBaseQuery).toBe('수정한 검색\n줄바꿈 유지')
    expect(next[0].assistant).toEqual(createGalleryAssistantState())
    expect(next[1]).toBe(sibling)
    expect(next[2]).toBe(parent)
    expect(next[3]).toBe(lost)
    expect(child.draft).toEqual({ query: '원래 검색\n파란색', photo: image })
    expect(child.assistant!.conditions).toEqual(['파란색'])
    expect(input.query).toBe('  수정한 검색\n줄바꿈 유지  ')
  })

  it('빈 검색으로는 덮어쓰지 않고 사진 단독 수정은 허용한다', () => {
    const record = createSearchRecord('gallery', { query: '검색', photo: image }, { name: '갤러리', files: [image] })
    const records = [record]
    expect(overwriteGallerySearch(records, record.id, { query: ' \n ', photo: null })).toBe(records)
    const next = overwriteGallerySearch(records, record.id, { query: ' \n ', photo: image })
    expect(next[0].id).toBe(record.id)
    expect(next[0].draft).toEqual({ query: '', photo: image })
    expect(next[0].assistantBaseQuery).toBe('')
    expect(record.draft.query).toBe('검색')
  })

  it('F2나 없는 ID를 덮어쓰지 않는다', () => {
    const lost = createSearchRecord('lost', { query: '분실물', photo: image }, null)
    expect(overwriteGallerySearch([lost], lost.id, { query: '바꾸기', photo: null })[0]).toBe(lost)
    expect(overwriteGallerySearch([lost], 'missing', { query: '바꾸기', photo: null })[0]).toBe(lost)
  })
})

describe('도우미 적용 조건 수정·삭제와 재검색', () => {
  it('이미 적용한 조건을 수정해도 이전 문구를 누적하지 않는다', () => {
    const parent = createSearchRecord('gallery', { query: '여행 사진', photo: image }, { name: '여행', files: [image] })
    const first = refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '파란색'))!
    expect(first.assistantBaseQuery).toBe('여행 사진')
    expect(first.assistant!.conditions).toEqual(['파란색'])
    expect(first.assistant!.appliedConditions).toEqual(['파란색'])
    expect(galleryConditionsChanged(first.assistant!)).toBe(false)
    const changed = editGalleryCondition(first.assistant!, 0, '노란색')
    const second = refineGalleryRecord(first, changed)!
    expect(second.draft.query).toBe('여행 사진\n노란색')
    expect(second.parentRecordId).toBe(first.id)
    expect(second.assistantBaseQuery).toBe('여행 사진')
    expect(second.assistant!.conditions).toEqual(['노란색'])
    expect(second.assistant!.appliedConditions).toEqual(['노란색'])
    expect(first.draft.query).toBe('여행 사진\n파란색')
    expect(first.assistant!.messages[0].text).toBe('파란색')
    expect(changed.appliedConditions).toEqual(['파란색'])
  })

  it('적용 조건을 전부 지우면 기본 질의만으로 새 기록을 만든다', () => {
    const parent = createSearchRecord('gallery', { query: '기본 질의', photo: image }, { name: '갤러리', files: [image] })
    const refined = refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '바닷가'))!
    const cleared = removeGalleryCondition(refined.assistant!, 0)
    expect(galleryConditionsChanged(cleared)).toBe(true)
    const child = refineGalleryRecord(refined, cleared)!
    expect(child.draft).toEqual({ query: '기본 질의', photo: image })
    expect(child.assistant!.conditions).toEqual([])
    expect(child.assistant!.appliedConditions).toEqual([])
    expect(child.assistant!.messages).toEqual(refined.assistant!.messages)
    expect(refined.draft.query).toBe('기본 질의\n바닷가')
    expect(refined.assistant!.conditions).toEqual(['바닷가'])
  })

  it('덮어쓴 질의를 새 기본으로 삼고 과거 부모 조건을 되살리지 않는다', () => {
    const parent = createSearchRecord('gallery', { query: '옛 검색', photo: null }, { name: '갤러리', files: [image] })
    const refined = refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '파란색'))!
    const overwritten = overwriteGallerySearch([refined, parent], refined.id, { query: '새 검색', photo: image })[0]
    const resolved = resolveGalleryAssistant([overwritten, parent], overwritten)
    expect(resolved.baseQuery).toBe('새 검색')
    expect(resolved.assistant.conditions).toEqual([])
    const child = refineGalleryRecord(overwritten, addGalleryCondition(resolved.assistant, '노란색'))!
    expect(child.draft.query).toBe('새 검색\n노란색')
  })
})

describe('이전 형식 도우미 상태의 세션 내 복원', () => {
  function legacyState(conditions: string[], texts: string[]): GalleryAssistantState {
    return { draft: '  미확정 작성문\n', conditions, open: false, messages: texts.map(text => ({ id: crypto.randomUUID(), role: 'user', text })) }
  }
  function legacyChild(parent: SearchRecord, query: string, assistant: GalleryAssistantState): SearchRecord {
    return { ...createSearchRecord('gallery', { query, photo: parent.draft.photo }, parent.gallery), parentRecordId: parent.id, assistant }
  }

  it('구 형식 부모 체인의 기본 질의와 여러 줄 조건 그룹·pending을 구별해 복원한다', () => {
    const root = createSearchRecord('gallery', { query: '여행\n사진', photo: image }, { name: '갤러리', files: [image] })
    const first = legacyChild(root, '여행\n사진\n파란색', legacyState([], ['파란색']))
    const state = legacyState(['인물 제외'], ['파란색', '주말\n노을', '인물 제외'])
    const child = legacyChild(first, '여행\n사진\n파란색\n주말\n노을', state)
    const records = [child, first, root]
    const resolved = resolveGalleryAssistant(records, child)
    expect(resolved.baseQuery).toBe('여행\n사진')
    expect(resolved.assistant.appliedConditions).toEqual(['파란색', '주말\n노을'])
    expect(resolved.assistant.conditions).toEqual(['파란색', '주말\n노을', '인물 제외'])
    expect(resolved.assistant.messages).toEqual(state.messages)
    expect(resolved.assistant.messages).not.toBe(state.messages)
    expect(resolved.assistant.draft).toBe(state.draft)
    expect(resolved.assistant.open).toBe(false)
    expect(state.conditions).toEqual(['인물 제외'])
    expect(state.appliedConditions).toBeUndefined()
    const next = refineGalleryRecord({ ...child, assistantBaseQuery: resolved.baseQuery }, resolved.assistant)!
    expect(next.draft.query).toBe('여행\n사진\n파란색\n주말\n노을\n인물 제외')
    expect(child.draft.query).toBe('여행\n사진\n파란색\n주말\n노을')
  })

  it('메시지로 조건 경계를 모두 복원하지 못하면 suffix 전체를 한 조건으로 보존한다', () => {
    const root = createSearchRecord('gallery', { query: '기본', photo: image }, { name: '갤러리', files: [image] })
    const child = legacyChild(root, '기본\n파란색\n긴 조건', legacyState([], ['파란색']))
    const resolved = resolveGalleryAssistant([child, root], child)
    expect(resolved.assistant.appliedConditions).toEqual(['파란색\n긴 조건'])
    expect(resolved.assistant.conditions).toEqual(['파란색\n긴 조건'])
  })

  it('사진 단독 기본 검색의 빈 query도 부모로부터 복원한다', () => {
    const root = createSearchRecord('gallery', { query: '', photo: image }, { name: '갤러리', files: [image] })
    const child = legacyChild(root, '파란색', legacyState([], ['파란색']))
    const resolved = resolveGalleryAssistant([child, root], child)
    expect(resolved.baseQuery).toBe('')
    expect(resolved.assistant.conditions).toEqual(['파란색'])
    const cleared = refineGalleryRecord({ ...child, assistantBaseQuery: resolved.baseQuery }, removeGalleryCondition(resolved.assistant, 0))!
    expect(cleared.draft).toEqual({ query: '', photo: image })
  })

  it('부모가 없거나 일반 초기 기록이면 현재 질의를 기본으로 삼고 pending을 유지한다', () => {
    const initial = createSearchRecord('gallery', { query: '여러\n줄 질의', photo: image }, { name: '갤러리', files: [image] })
    initial.assistant = legacyState(['대기 조건'], ['대기 조건'])
    const missing = { ...initial, parentRecordId: 'not-present' }
    for (const record of [initial, missing]) {
      const resolved = resolveGalleryAssistant([record], record)
      expect(resolved.baseQuery).toBe('여러\n줄 질의')
      expect(resolved.assistant.appliedConditions).toEqual([])
      expect(resolved.assistant.conditions).toEqual(['대기 조건'])
      expect(resolved.assistant.draft).toBe(initial.assistant.draft)
    }
  })

  it('부모 순환이나 기본 질의 불일치는 임의 suffix 추정 없이 안전하게 복구한다', () => {
    const first = createSearchRecord('gallery', { query: '첫 기록', photo: image }, { name: '갤러리', files: [image] })
    const second = createSearchRecord('gallery', { query: '둘째 기록', photo: image }, first.gallery)
    first.parentRecordId = second.id; second.parentRecordId = first.id
    first.assistant = legacyState(['pending'], ['pending'])
    const cycled = resolveGalleryAssistant([first, second], first)
    expect(cycled.baseQuery).toBe('첫 기록')
    expect(cycled.assistant.conditions).toEqual(['pending'])
    expect(cycled.assistant.appliedConditions).toEqual([])
    const root = { ...second, parentRecordId: undefined }
    const mismatched = resolveGalleryAssistant([first, root], first)
    expect(mismatched.baseQuery).toBe('첫 기록')
    expect(mismatched.assistant.appliedConditions).toEqual([])
  })

  it('새 형식 적용 조건은 다시 추론하지 않고 상태·빈 기본 질의를 그대로 보존한다', () => {
    const root = createSearchRecord('gallery', { query: '기존 부모', photo: image }, { name: '갤러리', files: [image] })
    const child = legacyChild(root, '이미 결합된 검색', {
      ...legacyState(['수정한 조건'], ['수정한 조건']), appliedConditions: ['적용했던 조건'],
    })
    child.assistantBaseQuery = ''
    const resolved = resolveGalleryAssistant([child, root], child)
    expect(resolved.baseQuery).toBe('')
    expect(resolved.assistant).toEqual(child.assistant)
    expect(resolved.assistant).not.toBe(child.assistant)
    expect(resolved.assistant.appliedConditions).not.toBe(child.assistant!.appliedConditions)
  })

  it('구 형식 patch는 복원한 조건·기본 질의를 먼저 보존하고 다른 기록·F2는 건드리지 않는다', () => {
    const root = createSearchRecord('gallery', { query: '기본', photo: image }, { name: '갤러리', files: [image] })
    const child = legacyChild(root, '기본\n파란색', legacyState(['바닷가'], ['파란색', '바닷가']))
    const lost = createSearchRecord('lost', { query: '지갑', photo: null }, null)
    const next = updateSearchAssistant([child, root, lost], child.id, { draft: '새 작성문', open: true })
    expect(next[0].assistantBaseQuery).toBe('기본')
    expect(next[0].assistant!.conditions).toEqual(['파란색', '바닷가'])
    expect(next[0].assistant!.appliedConditions).toEqual(['파란색'])
    expect(next[0].assistant!.draft).toBe('새 작성문')
    expect(next[0].assistant!.open).toBe(true)
    expect(next[0].draft).toBe(child.draft)
    expect(next[1]).toBe(root)
    expect(next[2]).toBe(lost)
    expect(child.assistant!.conditions).toEqual(['바닷가'])
    expect(child.assistantBaseQuery).toBeUndefined()
  })
})

describe('F2 다중 참고 사진의 기록 스냅샷', () => {
  const second = new File(['second'], 'back.png', { type: 'image/png' })
  const third = new File(['third'], 'detail.png', { type: 'image/png' })

  it('전체3장의 순서·원참조를 별도 배열로 보존하고 현재 선택 변경과 격리한다', () => {
    const draft = { query: '  검정 지갑  ', photo: third, photos: [image, second, third] }
    const first = createSearchRecord('lost', draft, { name: '개인 폴더', files: [image] })
    const next = createSearchRecord('lost', draft, null)
    expect(first.draft).toEqual({ query: '검정 지갑', photo: image, photos: [image, second, third] })
    expect(first.draft.photos).not.toBe(draft.photos)
    expect(first.draft.photos).not.toBe(next.draft.photos)
    expect(first.draft.photos![2]).toBe(third)
    expect(first.gallery).toBeNull()
    draft.photos.splice(0, 1)
    draft.photo = second
    first.draft.photos!.pop()
    expect(next.draft.photos).toEqual([image, second, third])
    expect(next.draft.photo).toBe(image)
    expect(draft.photos).toEqual([second, third])
  })

  it('빈 명시 목록은 과거 대표사진을 기록에 되살리지 않는다', () => {
    const photos: File[] = []
    const record = createSearchRecord('lost', { query: '설명만 검색', photo: image, photos }, null)
    expect(record.draft).toEqual({ query: '설명만 검색', photo: null, photos: [] })
    expect(record.draft.photos).not.toBe(photos)
  })

  it('기존 photo 전용 F2 기록 생성도 한 장의 목록으로 정규화한다', () => {
    const record = createSearchRecord('lost', { query: '', photo: image }, null)
    expect(record.draft.photos).toEqual([image])
    expect(record.draft.photo).toBe(image)
    expect(recordPath(record)).not.toContain(image.name)
  })

  it('F1 기록·검색수정·도우미 재검색에는 대표사진 한 장만 유지한다', () => {
    const record = createSearchRecord('gallery', { query: '내 사진', photo: image, photos: [second, third] }, { name: '폴더', files: [image] })
    expect(record.draft).toEqual({ query: '내 사진', photo: image })
    const changed = overwriteGallerySearch([record], record.id, { query: '수정', photo: second, photos: [third] })[0]
    expect(changed.draft).toEqual({ query: '수정', photo: second })
    const refined = refineGalleryRecord(changed, addGalleryCondition(createGalleryAssistantState(), '밝은색'))!
    expect(refined.draft).toEqual({ query: '수정\n밝은색', photo: second })
    expect(record.draft.photo).toBe(image)
  })
})

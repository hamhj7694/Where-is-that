import { describe, expect, it, vi } from 'vitest'
import { createSearchRecord, disconnectGalleryHistory, findSearchRecord, overwriteGallerySearch, overwriteLostSearch, recordPath, refineGalleryRecord, refineLostRecord, removeSearchRecord, resolveGalleryAssistant, resolveLostAssistant, updateSearchAssistant, type SearchRecord } from './history'
import { addGalleryCondition, createGalleryAssistantState, editGalleryCondition, galleryConditionsChanged, removeGalleryCondition, type GalleryAssistantState } from './gallery-search-model'
import type { ReferencePhotoView } from './model'

const image = new File(['image'], 'photo.jpg', { type: 'image/jpeg' })

describe('찾은 기록의 세션 스냅샷', () => {
  it('도우미의 여러 조건 추가·수정·삭제는 제출 질의를 유지하고 명시적 재검색에서만 묶어 반영한다', () => {
    const original = createSearchRecord('gallery', { query: '검정 지갑', photo: image }, { name: '갤러리', files: [image] })
    let records = [original]
    let staged = addGalleryCondition(createGalleryAssistantState(), '금색 로고')
    records = updateSearchAssistant(records, original.id, staged)
    staged = addGalleryCondition(staged, '실내 사진')
    records = updateSearchAssistant(records, original.id, staged)
    staged = addGalleryCondition(staged, '주말')
    records = updateSearchAssistant(records, original.id, staged)
    staged = editGalleryCondition(staged, 0, '은색 로고')
    staged = removeGalleryCondition(staged, 2)
    records = updateSearchAssistant(records, original.id, staged)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(original.id)
    expect(records[0].draft).toEqual(original.draft)
    expect(records[0].assistant!.conditions).toEqual(['은색 로고', '실내 사진'])
    const applied = refineGalleryRecord(records[0], records[0].assistant!)!
    expect(applied.draft.query).toBe('검정 지갑\n은색 로고\n실내 사진')
    expect(applied.assistant!.appliedConditions).toEqual(['은색 로고', '실내 사진'])
    const pendingRemoval = updateSearchAssistant([applied], applied.id, removeGalleryCondition(applied.assistant!, 0))[0]
    expect(pendingRemoval.draft.query).toBe(applied.draft.query)
    const reapplied = refineGalleryRecord(pendingRemoval, pendingRemoval.assistant!)!
    expect(reapplied.draft.query).toBe('검정 지갑\n실내 사진')
    expect(original.draft.query).toBe('검정 지갑')
  })

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

describe('찾은 이미지의 검색 도우미와 같은 기록 재검색', () => {
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

  it('없는 ID에는 도우미를 만들지 않는다', () => {
    const lost = createSearchRecord('lost', { query: '지갑', photo: null }, null)
    expect(updateSearchAssistant([lost], 'missing', { open: true })[0]).toBe(lost)
    expect(lost.assistant).toBeUndefined()
  })

  it('확인 후 다시 검색해도 기존 ID·시각을 유지하고 질의만 불변 갱신한다', () => {
    const source = { name: '여행', files: [image] }
    const parent = createSearchRecord('gallery', { query: '제주 사진', photo: image }, source)
    const assistant = { ...addGalleryCondition(addGalleryCondition(createGalleryAssistantState(), '파란 가방'), '2024년'), draft: '미확정 입력은 새 질의에 넣지 않기', open: true }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(parent.createdAt + 100)
    let child
    try { child = refineGalleryRecord(parent, assistant) } finally { clock.mockRestore() }
    expect(child).not.toBeNull()
    expect(child!.id).toBe(parent.id)
    expect(child!.createdAt).toBe(parent.createdAt)
    expect(child!).not.toBe(parent)
    expect(child!).not.toHaveProperty('parentRecordId')
    expect(child!.draft).toEqual({ query: '제주 사진\n파란 가방\n2024년', photo: image })
    expect(child!.gallery).toEqual(parent.gallery)
    expect(child!.gallery).not.toBe(parent.gallery)
    expect(child!.gallery!.files).not.toBe(parent.gallery!.files)
    expect(child!.gallery!.files[0]).toBe(image)
    expect(parent.draft.query).toBe('제주 사진')
    expect(parent.assistant).toBeUndefined()
    expect(assistant.conditions).toEqual(['파란 가방', '2024년'])
  })

  it('같은 기록 갱신은 대화·열림과 적용 조건을 보존하고 미확정 입력만 비우며 독립 복사한다', () => {
    const parent = createSearchRecord('gallery', { query: '여행', photo: image }, { name: '갤러리', files: [image] })
    const assistant = { ...addGalleryCondition(createGalleryAssistantState(), '바닷가'), draft: '  미확정 ', open: false }
    const child = refineGalleryRecord(parent, assistant)!
    expect(child.assistant).toEqual({ ...assistant, draft: '', conditions: ['바닷가'], appliedConditions: ['바닷가'] })
    expect(child.assistant!.messages).not.toBe(assistant.messages)
    expect(child.assistant!.messages[0]).not.toBe(assistant.messages[0])
    expect(child.assistant!.conditions).not.toBe(assistant.conditions)
    child.assistant!.messages[0].text = '갱신본만 바꾸기'
    child.gallery!.files.length = 0
    expect(assistant.messages[0].text).toBe('바닷가')
    expect(parent.gallery!.files).toEqual([image])
    expect(assistant.draft).toBe('  미확정 ')
  })

  it('pending 조건이 없거나 F2·갤러리 소스 없는 기록은 갱신하지 않는다', () => {
    const gallery = createSearchRecord('gallery', { query: '사진', photo: null }, { name: '갤러리', files: [image] })
    const pending = addGalleryCondition(createGalleryAssistantState(), '바닷가')
    expect(refineGalleryRecord(gallery, createGalleryAssistantState())).toBeNull()
    expect(refineGalleryRecord(gallery, { ...pending, conditions: ['\n ', '\t'] })).toBeNull()
    expect(refineGalleryRecord(createSearchRecord('gallery', { query: '사진', photo: image }, null), pending)).toBeNull()
    expect(refineGalleryRecord(createSearchRecord('lost', { query: '지갑', photo: image }, null), pending)).toBeNull()
  })

  it('같은 조건으로 반복 재검색해도 기존 ID·시각과 부모 없음 상태를 유지한다', () => {
    const parent = createSearchRecord('gallery', { query: '사진', photo: null }, { name: '갤러리', files: [image] })
    const pending = addGalleryCondition(createGalleryAssistantState(), '바닷가')
    const first = refineGalleryRecord(parent, pending)!
    const second = refineGalleryRecord(first, first.assistant!)!
    expect(first.id).toBe(parent.id)
    expect(second.id).toBe(parent.id)
    expect(second.createdAt).toBe(parent.createdAt)
    expect(second).not.toBe(first)
    expect(first.draft).toEqual(second.draft)
    expect(first).not.toHaveProperty('parentRecordId')
    expect(second).not.toHaveProperty('parentRecordId')
    expect(second.draft.query).toBe('사진\n바닷가')
    expect(parent.draft.query).toBe('사진')
  })
})

describe('같은 검색 기록에서 검색어·참고 사진 수정', () => {
  it('ID·시각·갤러리 스냅샷·부모 관계를 유지하고 도우미만 초기화한다', () => {
    const parent = createSearchRecord('gallery', { query: '원래 검색', photo: image }, { name: '원래 갤러리', files: [image] })
    const child = { ...refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '파란색'))!, id: crypto.randomUUID(), parentRecordId: parent.id }
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
    expect(second.id).toBe(parent.id)
    expect(second.parentRecordId).toBe(first.parentRecordId)
    expect(second.assistantBaseQuery).toBe('여행 사진')
    expect(second.assistant!.conditions).toEqual(['노란색'])
    expect(second.assistant!.appliedConditions).toEqual(['노란색'])
    expect(first.draft.query).toBe('여행 사진\n파란색')
    expect(first.assistant!.messages[0].text).toBe('파란색')
    expect(changed.appliedConditions).toEqual(['파란색'])
  })

  it('적용 조건을 전부 지우면 같은 기록을 기본 질의로 되돌린다', () => {
    const parent = createSearchRecord('gallery', { query: '기본 질의', photo: image }, { name: '갤러리', files: [image] })
    const refined = refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '바닷가'))!
    const cleared = removeGalleryCondition(refined.assistant!, 0)
    expect(galleryConditionsChanged(cleared)).toBe(true)
    const child = refineGalleryRecord(refined, cleared)!
    expect(child.id).toBe(parent.id)
    expect(child.createdAt).toBe(parent.createdAt)
    expect(child.draft).toEqual({ query: '기본 질의', photo: image })
    expect(child.assistant!.conditions).toEqual([])
    expect(child.assistant!.appliedConditions).toEqual([])
    expect(child.assistant!.messages).toEqual(refined.assistant!.messages)
    expect(refined.draft.query).toBe('기본 질의\n바닷가')
    expect(refined.assistant!.conditions).toEqual(['바닷가'])
  })

  it('덮어쓴 질의를 새 기본으로 삼고 과거 부모 조건을 되살리지 않는다', () => {
    const parent = createSearchRecord('gallery', { query: '옛 검색', photo: null }, { name: '갤러리', files: [image] })
    const refined = { ...refineGalleryRecord(parent, addGalleryCondition(createGalleryAssistantState(), '파란색'))!, id: crypto.randomUUID(), parentRecordId: parent.id }
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
    expect(next.id).toBe(child.id)
    expect(next.parentRecordId).toBe(first.id)
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

  it('전체6장 기록은 원본 순서·File 참조와 별도 목록을 유지한다', () => {
    const photos = [image, second, third, ...Array.from({ length: 3 }, (_, index) => new File([String(index)], `angle-${index}.png`, { type: 'image/png' }))]
    const original = [...photos]
    const draft = { query: '앞뒤와 특징', photo: third, photos }
    const record = createSearchRecord('lost', draft, null)
    expect(record.draft.photos).toHaveLength(6)
    expect(record.draft.photos).toEqual(original)
    expect(record.draft.photos).not.toBe(photos)
    expect(record.draft.photo).toBe(image)
    record.draft.photos!.forEach((file, index) => expect(file).toBe(original[index]))
    photos.splice(0, photos.length)
    draft.photo = second
    expect(record.draft.photos).toEqual(original)
    expect(record.draft.photo).toBe(image)
  })

  it('전체3장의 순서·원참조를 별도 배열로 보존하고 현재 선택 변경과 격리한다', () => {
    const draft = { query: '  검정 지갑  ', photo: third, photos: [image, second, third] }
    const first = createSearchRecord('lost', draft, { name: '개인 폴더', files: [image] })
    const next = createSearchRecord('lost', draft, null)
    expect(first.draft).toEqual({ query: '검정 지갑', photo: image, photos: [image, second, third], photoViews: ['unspecified', 'unspecified', 'unspecified'] })
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
    expect(record.draft).toEqual({ query: '설명만 검색', photo: null, photos: [], photoViews: [] })
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

describe('F2 수동 사진 방향의 기록 스냅샷', () => {
  it('6장과 각 방향은 현재 초안·다른 기록의 배열 변경과 격리된다', () => {
    const photos = Array.from({ length: 6 }, (_, index) => new File([String(index)], `manual-${index}.jpg`, { type: 'image/jpeg' }))
    const views: ReferencePhotoView[] = ['front', 'back', 'side', 'top', 'bottom', 'diagonal']
    const draft = { query: '물건', photo: null, photos: [...photos], photoViews: views }
    const first = createSearchRecord('lost', draft, null)
    const second = createSearchRecord('lost', draft, null)
    expect(first.draft.photoViews).toEqual(views)
    expect(first.draft.photoViews).not.toBe(views)
    expect(first.draft.photoViews).not.toBe(second.draft.photoViews)
    expect(first.draft.photos![0]).toBe(photos[0])
    views[0] = 'bottom'
    draft.photos.reverse()
    first.draft.photoViews![1] = 'unspecified'
    expect(second.draft.photoViews).toEqual(['front', 'back', 'side', 'top', 'bottom', 'diagonal'])
    expect(second.draft.photos).toEqual(photos)
    expect(second.draft.photo).toBe(photos[0])
  })

  it('구버전 기록 입력에는 미지정을 넣고 F1에는 방향 필드를 남기지 않는다', () => {
    expect(createSearchRecord('lost', { query: '', photo: image }, null).draft.photoViews).toEqual(['unspecified'])
    const gallery = createSearchRecord('gallery', { query: '내 사진', photo: image, photoViews: ['front'] }, { name: '폴더', files: [image] })
    expect(gallery.draft.photoViews).toBeUndefined()
    const overwritten = overwriteGallerySearch([gallery], gallery.id, { query: '수정', photo: image, photoViews: ['back'] })[0]
    expect(overwritten.draft.photoViews).toBeUndefined()
    expect(refineGalleryRecord(overwritten, addGalleryCondition(createGalleryAssistantState(), '가방'))!.draft.photoViews).toBeUndefined()
  })
})

describe('분실물 기록별 도우미·조건 재검색·인페이지 검색 수정', () => {
  const photos = Array.from({ length: 6 }, (_, index) => new File([String(index)], `lost-${index}.jpg`, { type: 'image/jpeg' }))
  const photoViews: ReferencePhotoView[] = ['front', 'back', 'side', 'top', 'bottom', 'diagonal']
  function lostRecord(query = '검정 가방') {
    return createSearchRecord('lost', { query, photo: photos[0], photos, photoViews }, null)
  }

  it('조건·초안·열림 patch는 지정한 F2 기록에만 적용하며 제출 입력은 보존한다', () => {
    const parent = lostRecord()
    const other = lostRecord('다른 분실물')
    const gallery = createSearchRecord('gallery', { query: '개인 사진', photo: image }, { name: '갤러리', files: [image] })
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '은색 로고'), draft: '  이어 쓸 문장\n', open: true }
    const records = [parent, other, gallery]
    const patched = updateSearchAssistant(records, parent.id, state)
    const closed = updateSearchAssistant(patched, parent.id, { open: false })
    const opened = updateSearchAssistant(closed, parent.id, { open: true })
    expect(opened).toHaveLength(3)
    expect(opened[0].id).toBe(parent.id)
    expect(opened[0].draft).toBe(parent.draft)
    expect(opened[0].assistant).toEqual(state)
    expect(opened[0].assistantBaseQuery).toBe('검정 가방')
    expect(opened[0].assistant!.conditions).not.toBe(state.conditions)
    expect(opened[0].assistant!.messages[0]).not.toBe(state.messages[0])
    expect(opened[1]).toBe(other)
    expect(opened[2]).toBe(gallery)
    expect(parent.assistant).toBeUndefined()
    expect(records[0]).toBe(parent)
    expect(state.draft).toBe('  이어 쓸 문장\n')
  })

  it('명시적 재검색은 기존 ID·시각과 6장·방향·대화의 독립 스냅샷을 유지한다', () => {
    const parent = lostRecord()
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '은색 로고'), draft: '미제출 문장은 제외', open: false }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(parent.createdAt + 100)
    const child = (() => {
      try { return refineLostRecord(parent, state) } finally { clock.mockRestore() }
    })()
    expect(child).not.toBeNull()
    expect(child!.id).toBe(parent.id)
    expect(child!.createdAt).toBe(parent.createdAt)
    expect(child).not.toBe(parent)
    expect(child).not.toHaveProperty('parentRecordId')
    expect(child!.draft.query).toBe('검정 가방\n은색 로고')
    expect(child!.draft.photos).toEqual(photos)
    expect(child!.draft.photos).not.toBe(parent.draft.photos)
    expect(child!.draft.photoViews).toEqual(photoViews)
    expect(child!.draft.photoViews).not.toBe(parent.draft.photoViews)
    child!.draft.photos!.forEach((file, index) => expect(file).toBe(photos[index]))
    expect(child!.gallery).toBeNull()
    expect(child!.assistant).toEqual({ ...state, draft: '', appliedConditions: ['은색 로고'] })
    expect(child!.assistant!.messages).not.toBe(state.messages)
    child!.draft.photos!.pop()
    child!.draft.photoViews![0] = 'unspecified'
    child!.assistant!.messages[0].text = '갱신본에서만 변경'
    expect(parent.draft.photos).toEqual(photos)
    expect(parent.draft.photoViews).toEqual(photoViews)
    expect(parent.draft.query).toBe('검정 가방')
    expect(state.messages[0].text).toBe('은색 로고')
  })

  it('적용 조건 수정·삭제는 기본 질의를 재사용하고 이전 조건을 누적하지 않는다', () => {
    const parent = lostRecord()
    const first = refineLostRecord(parent, addGalleryCondition(createGalleryAssistantState(), '은색 로고'))!
    const changed = editGalleryCondition(first.assistant!, 0, '금색 로고')
    const second = refineLostRecord(first, changed)!
    expect(second.draft.query).toBe('검정 가방\n금색 로고')
    expect(second.assistantBaseQuery).toBe('검정 가방')
    expect(second.assistant!.conditions).toEqual(['금색 로고'])
    expect(second.assistant!.appliedConditions).toEqual(['금색 로고'])
    const cleared = refineLostRecord(second, removeGalleryCondition(second.assistant!, 0))!
    expect(cleared.draft.query).toBe('검정 가방')
    expect(cleared.draft.photoViews).toEqual(photoViews)
    expect(cleared.assistant!.conditions).toEqual([])
    expect(first.draft.query).toBe('검정 가방\n은색 로고')
    expect(second.draft.query).toBe('검정 가방\n금색 로고')
  })

  it('사진만인 기본 검색도 모든 조건 삭제 후 사진·방향을 유지한다', () => {
    const parent = lostRecord('')
    const first = refineLostRecord(parent, addGalleryCondition(createGalleryAssistantState(), '주말'))!
    const cleared = refineLostRecord(first, removeGalleryCondition(first.assistant!, 0))!
    expect(cleared.draft.query).toBe('')
    expect(cleared.draft.photo).toBe(photos[0])
    expect(cleared.draft.photos).toEqual(photos)
    expect(cleared.draft.photoViews).toEqual(photoViews)
    expect(cleared.assistantBaseQuery).toBe('')
  })

  it('F1·미적용 빈 조건·유효하지 않은 F2 검색은 갱신하지 않는다', () => {
    const state = addGalleryCondition(createGalleryAssistantState(), '로고')
    const gallery = createSearchRecord('gallery', { query: '개인 사진', photo: image }, { name: '갤러리', files: [image] })
    expect(refineLostRecord(gallery, state)).toBeNull()
    expect(refineLostRecord(lostRecord(), createGalleryAssistantState())).toBeNull()
    const textOnly = createSearchRecord('lost', { query: '적용 조건만 있음', photo: null }, null)
    textOnly.assistantBaseQuery = ''
    expect(refineLostRecord(textOnly, { ...createGalleryAssistantState(), appliedConditions: ['적용 조건만 있음'] })).toBeNull()
    const tooMany = createSearchRecord('lost', { query: '가방', photo: null, photos: [...photos, image] }, null)
    expect(refineLostRecord(tooMany, state)).toBeNull()
  })

  it('검색 수정은 같은 ID·시각·부모를 유지하고 사진·방향을 복사하며 도우미를 초기화한다', () => {
    const parent = lostRecord()
    const child = { ...refineLostRecord(parent, addGalleryCondition(createGalleryAssistantState(), '은색 로고'))!, id: crypto.randomUUID(), parentRecordId: parent.id }
    const other = lostRecord('다른 가방')
    const gallery = createSearchRecord('gallery', { query: '개인 사진', photo: image }, { name: '갤러리', files: [image] })
    const input = { query: '  수정한 가방\n새 특징  ', photo: null, photos: [...photos].reverse(), photoViews: [...photoViews].reverse() }
    const records = [child, parent, other, gallery]
    const next = overwriteLostSearch(records, child.id, input)
    expect(next).toHaveLength(4)
    expect(next[0].id).toBe(child.id)
    expect(next[0].createdAt).toBe(child.createdAt)
    expect(next[0].parentRecordId).toBe(parent.id)
    expect(next[0].draft.query).toBe('수정한 가방\n새 특징')
    expect(next[0].draft.photo).toBe(photos[5])
    expect(next[0].draft.photos).toEqual(input.photos)
    expect(next[0].draft.photos).not.toBe(input.photos)
    expect(next[0].draft.photoViews).toEqual(input.photoViews)
    expect(next[0].draft.photoViews).not.toBe(input.photoViews)
    expect(next[0].assistantBaseQuery).toBe('수정한 가방\n새 특징')
    expect(next[0].assistant).toEqual(createGalleryAssistantState())
    expect(next[1]).toBe(parent)
    expect(next[2]).toBe(other)
    expect(next[3]).toBe(gallery)
    const resolved = resolveLostAssistant(next, next[0])
    expect(resolved.baseQuery).toBe('수정한 가방\n새 특징')
    expect(refineLostRecord(next[0], addGalleryCondition(resolved.assistant, '주말'))!.draft.query).toBe('수정한 가방\n새 특징\n주말')
    expect(child.draft.photos).toEqual(photos)
    expect(child.draft.query).toBe('검정 가방\n은색 로고')
    input.photos.pop(); input.photoViews.pop()
    expect(next[0].draft.photos).toHaveLength(6)
    expect(next[0].draft.photoViews).toHaveLength(6)
  })

  it('명시적 빈 사진 목록·구버전 한 장을 처리하고 빈 검색·7장·다른 모드 수정은 거절한다', () => {
    const record = lostRecord()
    const records = [record]
    expect(overwriteLostSearch(records, record.id, { query: ' ', photo: image, photos: [] })).toBe(records)
    expect(overwriteLostSearch(records, record.id, { query: '가방', photo: null, photos: [...photos, image] })).toBe(records)
    const removed = overwriteLostSearch(records, record.id, { query: '설명만', photo: image, photos: [] })[0]
    expect(removed.draft).toEqual({ query: '설명만', photo: null, photos: [], photoViews: [] })
    const legacy = overwriteLostSearch(records, record.id, { query: '', photo: image })[0]
    expect(legacy.draft).toEqual({ query: '', photo: image, photos: [image], photoViews: ['unspecified'] })
    const gallery = createSearchRecord('gallery', { query: '개인 사진', photo: image }, { name: '갤러리', files: [image] })
    expect(overwriteLostSearch([gallery], gallery.id, { query: '수정', photo: null })[0]).toBe(gallery)
    expect(overwriteLostSearch(records, 'missing', { query: '수정', photo: null })[0]).toBe(record)
  })

  it('이전 형식 F2 부모 체인의 기본 질의·다중 줄 적용 조건·pending을 모드별로 복원한다', () => {
    const parent = lostRecord('검정\n가방')
    const first = { ...lostRecord('검정\n가방\n은색 로고'), parentRecordId: parent.id }
    const child = { ...lostRecord('검정\n가방\n은색 로고\n주말\n서울'), parentRecordId: first.id, assistant: {
      draft: '  이어 쓰기\n', open: false, conditions: ['가죽'], messages: ['은색 로고', '주말\n서울', '가죽'].map(text => ({ id: crypto.randomUUID(), role: 'user' as const, text })),
    } }
    const resolved = resolveLostAssistant([child, first, parent], child)
    expect(resolved.baseQuery).toBe('검정\n가방')
    expect(resolved.assistant.conditions).toEqual(['은색 로고', '주말\n서울', '가죽'])
    expect(resolved.assistant.appliedConditions).toEqual(['은색 로고', '주말\n서울'])
    expect(resolved.assistant.draft).toBe('  이어 쓰기\n')
    expect(resolved.assistant.open).toBe(false)
    const patched = updateSearchAssistant([child, first, parent], child.id, { open: true })[0]
    expect(patched.assistantBaseQuery).toBe('검정\n가방')
    expect(patched.assistant!.conditions).toEqual(resolved.assistant.conditions)
    expect(patched.draft).toBe(child.draft)
    const refined = refineLostRecord(patched, patched.assistant!)!
    expect(refined.draft.query).toBe('검정\n가방\n은색 로고\n주말\n서울\n가죽')
    expect(refined.id).toBe(child.id)
    expect(refined.parentRecordId).toBe(first.id)
    expect(child.assistant.conditions).toEqual(['가죽'])
    expect(child.assistant).not.toHaveProperty('appliedConditions')
  })

  it('다른 모드 부모·끊긴 부모·순환 체인은 현재 질의를 유지하며 안전하게 복구한다', () => {
    const gallery = createSearchRecord('gallery', { query: '다른 모드', photo: image }, { name: '갤러리', files: [image] })
    const lost = { ...lostRecord('분실물\n조건'), parentRecordId: gallery.id, assistant: { draft: '미제출', conditions: ['대기 조건'], messages: [] } }
    for (const records of [[lost, gallery], [lost]]) {
      const resolved = resolveLostAssistant(records, lost)
      expect(resolved.baseQuery).toBe('분실물\n조건')
      expect(resolved.assistant.conditions).toEqual(['대기 조건'])
      expect(resolved.assistant.appliedConditions).toEqual([])
    }
    const second = { ...lostRecord('둘째'), parentRecordId: lost.id }
    const cycled = { ...lost, parentRecordId: second.id }
    expect(resolveLostAssistant([cycled, second], cycled).baseQuery).toBe('분실물\n조건')
    expect(resolveLostAssistant([cycled, second], cycled).assistant.conditions).toEqual(['대기 조건'])
  })
})

describe('도우미 재검색의 기록 정체성', () => {
  it.each(['gallery', 'lost'] as const)('%s 재검색은 UUID·시각을 새로 만들지 않고 기존 부모 관계·행 수를 보존한다', mode => {
    const gallery = mode === 'gallery' ? { name: '갤러리', files: [image] } : null
    const legacyParent = createSearchRecord(mode, { query: '과거 기록', photo: image }, gallery)
    const record: SearchRecord = { ...createSearchRecord(mode, { query: '기본 질의', photo: image }, gallery), parentRecordId: legacyParent.id }
    const state = { ...addGalleryCondition(createGalleryAssistantState(), '은색 로고'), draft: '아직 추가하지 않은 문장', open: true }
    const refine = mode === 'gallery' ? refineGalleryRecord : refineLostRecord
    const uuid = vi.spyOn(crypto, 'randomUUID')
    const clock = vi.spyOn(Date, 'now')
    try {
      const first = refine(record, state)!
      const changed = editGalleryCondition(first.assistant!, 0, '금색 로고')
      const second = refine(first, changed)!
      const repeated = refine(second, second.assistant!)!
      const records = [record, legacyParent]
      const updated = records.map(item => item.id === repeated.id ? repeated : item)
      expect(uuid).not.toHaveBeenCalled()
      expect(clock).not.toHaveBeenCalled()
      expect(updated).toHaveLength(records.length)
      expect(updated[0].id).toBe(record.id)
      expect(updated[0].createdAt).toBe(record.createdAt)
      expect(updated[0].parentRecordId).toBe(legacyParent.id)
      expect(updated[0].draft.query).toBe('기본 질의\n금색 로고')
      expect(updated[0].assistant!.draft).toBe('')
      expect(updated[0].assistant!.open).toBe(true)
      expect(updated[0].assistant!.appliedConditions).toEqual(['금색 로고'])
      expect(updated[1]).toBe(legacyParent)
      expect(record.draft.query).toBe('기본 질의')
      expect(record.assistant).toBeUndefined()
      expect(first.draft.query).toBe('기본 질의\n은색 로고')
      expect(state.draft).toBe('아직 추가하지 않은 문장')
      expect(records[0]).toBe(record)
    } finally { uuid.mockRestore(); clock.mockRestore() }
  })
})

import { describe, expect, it } from 'vitest'
import { appendGallery, canSubmitWithEnter, clipboardImageFiles, collectGallery, createSearchPreview, getReferencePhotos, getReferencePhotoViews, MAX_LOST_REFERENCE_PHOTOS, REFERENCE_PHOTO_VIEWS, snapshotSearchDraft, validateSearch, type ReferencePhotoView, type SearchDraft } from './model'

const photo = new File(['fixture'], 'wallet.jpg', { type: 'image/jpeg' })
const screenshot = new File(['fixture'], 'schedule.png', { type: 'image/png' })
const gallery = { name: '내 갤러리', files: [photo, screenshot] }

describe('클립보드 이미지 붙여넣기', () => {
  function transfer(files: File[], items: { kind: string; type: string; getAsFile: () => File | null }[]) {
    return { files, items } as unknown as DataTransfer
  }

  it('클립보드의 이미지 파일만 참고 사진으로 추린다', () => {
    const text = new File(['memo'], 'note.txt', { type: 'text/plain' })
    expect(clipboardImageFiles(transfer([photo, text], []))).toEqual([photo])
  })

  it('files가 비어 있으면 items에서 이미지를 꺼낸다', () => {
    const pasted = clipboardImageFiles(transfer([], [
      { kind: 'file', type: 'image/png', getAsFile: () => screenshot },
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
    ]))
    expect(pasted).toEqual([screenshot])
  })

  it('붙여넣은 데이터가 없으면 빈 배열이다', () => {
    expect(clipboardImageFiles(null)).toEqual([])
  })
})

describe('검색 입력의 제품 계약', () => {
  it('공백만 있는 입력은 검색하지 않는다', () => {
    expect(validateSearch('lost', { query: ' \n ', photo: null }, null)).toBe('empty')
  })
  it.each<SearchDraft>([{ query: '검정 지갑', photo: null }, { query: '', photo }, { query: '작은 로고', photo }])(
    'F2는 글/사진/혼합 모두 두 검색 경로를 요청한다: %j', (draft) => {
      expect(validateSearch('lost', draft, null)).toBeNull()
      const preview = createSearchPreview('lost', draft, gallery)
      expect(preview.channels).toEqual(['image', 'context'])
      expect(preview.gallery).toBeNull()
    },
  )
  it('F1의 참고 사진은 갤러리 연결을 대신하지 않는다', () => {
    expect(validateSearch('gallery', { query: '', photo }, null)).toBe('gallery')
  })
  it('F1 검색 범위는 참고 사진 한 장이 아니라 연결한 갤러리 전체다', () => {
    const reference = new File(['other'], 'reference.jpg', { type: 'image/jpeg' })
    const draft = { query: '', photo: reference }
    expect(validateSearch('gallery', draft, gallery)).toBeNull()
    expect(createSearchPreview('gallery', draft, gallery).gallery).toEqual({ name: '내 갤러리', count: 2 })
    expect(gallery.files).toEqual([photo, screenshot])
  })
  it('AI가 정리한 3채널 검색 초안을 스냅샷에 보존한다', () => {
    const aiPlan = {
      originalQuery: '검은 지갑',
      imageDescriptions: [],
      channels: {
        combined: { query: '검은 가죽 지갑', keywords: ['검은색', '지갑'] },
        image: { query: '검은 가죽', keywords: ['검은색', '가죽'] },
        context: { query: '검은 지갑', keywords: ['검은색', '지갑'] },
      },
      filters: { category: '지갑', region: '', view: '', fromDate: '', toDate: '' },
      clarificationQuestions: [],
    }

    expect(snapshotSearchDraft('lost', { query: '검은 지갑', photo: null, aiPlan }).aiPlan).toEqual(aiPlan)
    expect(snapshotSearchDraft('gallery', { query: '검은 지갑', photo, aiPlan }).aiPlan).toEqual(aiPlan)
  })
  it('폴더에 섞인 문서는 이미지 모집단에 넣지 않는다', () => {
    const document = new File(['text'], 'notes.txt', { type: 'text/plain' })
    expect(collectGallery([photo, document, screenshot])?.files).toEqual([photo, screenshot])
    expect(collectGallery([document])).toBeNull()
  })
  it('선택한 폴더·하위·중첩 하위 폴더의 이미지를 전부 포함하고 상대 경로를 보존한다', () => {
    const paths = ['train/root.jpg', 'train/a/photo.jpg', 'train/b/photo.jpg', 'train/a/deep/one.png', 'train/a/deep/two.png', 'train/b/deeper/three.jpg', 'train/b/deeper/last.JPG']
    const files = paths.map(path => {
      const file = new File(['fixture'], path.split('/').at(-1)!, { type: path.endsWith('.png') ? 'image/png' : '' })
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      return file
    })
    const text = new File(['note'], 'readme.txt', { type: 'text/plain' })
    Object.defineProperty(text, 'webkitRelativePath', { value: 'train/a/readme.txt' })
    const source = collectGallery([text, ...files])
    expect(source?.name).toBe('train')
    expect(source?.files).toHaveLength(7)
    expect(source?.files.map(file => file.webkitRelativePath)).toEqual(paths)
    expect(source?.files[1]).not.toBe(source?.files[2])
    expect(source?.files[6]).toBe(files[6])
  })
  it('루트에 이미지가 없어도 가장 깊은 폴더의 이미지로 연결할 수 있다', () => {
    const file = new File(['fixture'], 'screenshot.png', { type: 'image/png' })
    Object.defineProperty(file, 'webkitRelativePath', { value: '갤러리/업무/2026/화면/screenshot.png' })
    expect(collectGallery([file])).toEqual({ name: '갤러리', files: [file] })
    expect(collectGallery([])).toBeNull()
  })
})

describe('기존 갤러리에 이미지 추가', () => {
  it('기존 File과 순서를 유지하고 새 사진을 뒤에 추가하며 원래 목록을 수정하지 않는다', () => {
    const extra = new File(['extra'], 'reference.jpg', { type: 'image/jpeg' })
    const original = { name: '선택한 이미지', files: [photo, screenshot] }
    const merged = appendGallery(original, [extra])
    expect(merged?.files).toEqual([photo, screenshot, extra])
    expect(merged?.files[0]).toBe(photo)
    expect(merged?.files[1]).toBe(screenshot)
    expect(merged?.name).toBe('선택한 이미지')
    expect(original.files).toEqual([photo, screenshot])
    expect(merged?.files).not.toBe(original.files)
  })
  it('다른 폴더와 중첩 하위 폴더의 동명 사진을 모두 추가하고 상대 경로를 유지한다', () => {
    const additions = ['새폴더/photo.jpg', '새폴더/a/deep/photo.jpg'].map(path => {
      const file = new File(['extra'], 'photo.jpg', { type: 'image/jpeg' })
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      return file
    })
    const document = new File(['note'], 'readme.txt', { type: 'text/plain' })
    const merged = appendGallery(gallery, [...additions, document])
    expect(merged?.files).toEqual([...gallery.files, ...additions])
    expect(merged?.files.slice(2).map(file => file.webkitRelativePath)).toEqual(['새폴더/photo.jpg', '새폴더/a/deep/photo.jpg'])
    expect(merged?.name).toBe('여러 위치의 이미지')
    expect(gallery.files).toEqual([photo, screenshot])
  })
  it('취소나 이미지가 없는 선택은 기존 연결 객체를 그대로 유지한다', () => {
    expect(appendGallery(gallery, [])).toBe(gallery)
    expect(appendGallery(gallery, [new File(['note'], 'notes.txt', { type: 'text/plain' })])).toBe(gallery)
    expect(appendGallery(null, [])).toBeNull()
  })
  it('미리보기 제한과 관계없이 새로 선택한 이미지 전체를 추가한다', () => {
    const additions = Array.from({ length: 12 }, (_, index) => new File(['extra'], index + '.jpg', { type: 'image/jpeg' }))
    const merged = appendGallery(gallery, additions)
    expect(merged?.files).toHaveLength(14)
    expect(merged?.files.at(-1)).toBe(additions.at(-1))
    expect(appendGallery(null, additions)?.files).toEqual(additions)
  })
})

describe('한글 IME와 Enter 동작', () => {
  const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }
  it('일반 Enter만 전송으로 처리한다', () => {
    expect(canSubmitWithEnter(enter)).toBe(true)
    expect(canSubmitWithEnter({ ...enter, shiftKey: true })).toBe(false)
  })
  it('한글 조합 확정 Enter와 브라우저 229 키 이벤트는 전송하지 않는다', () => {
    expect(canSubmitWithEnter({ ...enter, isComposing: true })).toBe(false)
    expect(canSubmitWithEnter({ ...enter, keyCode: 229 })).toBe(false)
  })
})

describe('F2 다중 참고 사진과 F1 한 장 입력의 경계', () => {
  const third = new File(['third'], 'detail.webp', { type: 'image/webp' })

  it('목록이 없는 이전 입력은 대표사진 한 장과 호환된다', () => {
    const draft = { query: '', photo }
    expect(getReferencePhotos(draft)).toEqual([photo])
    expect(snapshotSearchDraft('lost', draft)).toEqual({ query: '', photo, photos: [photo], photoViews: ['unspecified'] })
    expect(getReferencePhotos({ query: '', photo: null })).toEqual([])
    expect(validateSearch('lost', draft, null)).toBeNull()
  })

  it('photos가 정의되면 빈 배열도 대표사진 fallback보다 우선한다', () => {
    const photos: File[] = []
    const draft = { query: '', photo, photos }
    expect(getReferencePhotos(draft)).toBe(photos)
    expect(snapshotSearchDraft('lost', draft)).toEqual({ query: '', photo: null, photos: [], photoViews: [] })
    expect(validateSearch('lost', draft, null)).toBe('empty')
    expect(validateSearch('lost', { ...draft, query: '사진 없이 설명만' }, null)).toBeNull()
  })

  it.each([1, 2, 3])('%i장의 목록만으로도 검색하고 첫 장을 호환 대표사진으로 쓴다', count => {
    const photos = [photo, screenshot, third].slice(0, count)
    const draft = { query: '', photo: null, photos }
    expect(validateSearch('lost', draft, null)).toBeNull()
    expect(getReferencePhotos(draft)).toBe(photos)
    const snapshot = snapshotSearchDraft('lost', draft)
    expect(snapshot.photo).toBe(photo)
    expect(snapshot.photos).toEqual(photos)
    expect(snapshot.photos).not.toBe(photos)
    snapshot.photos!.forEach((item, index) => expect(item).toBe(photos[index]))
  })

  it('F2 6장은 허용하고7장은 거절하며 목록을 조용히 잘라내지 않는다', () => {
    const photos = [photo, screenshot, third, ...Array.from({ length: 4 }, (_, index) => new File([String(index)], `extra-${index}.jpg`, { type: 'image/jpeg' }))]
    expect(MAX_LOST_REFERENCE_PHOTOS).toBe(6)
    expect(validateSearch('lost', { query: '', photo: null, photos: photos.slice(0, 6) }, null)).toBeNull()
    expect(validateSearch('lost', { query: '추가 설명', photo, photos }, null)).toBe('too-many-photos')
    expect(photos).toHaveLength(7)
    expect(getReferencePhotos({ query: '', photo, photos })).toHaveLength(7)
  })

  it('6장 미리보기는 전체 사진을 별도 배열로 보존하고 첫 장 호환을 유지한다', () => {
    const photos = Array.from({ length: 6 }, (_, index) => new File([String(index)], `view-${index}.png`, { type: 'image/png' }))
    const original = [...photos]
    const draft = { query: '  같은 지갑의 여러 방향  ', photo: null, photos }
    const snapshot = snapshotSearchDraft('lost', draft)
    const preview = createSearchPreview('lost', draft, null)
    expect(snapshot.photos).toEqual(original)
    expect(preview.photos).toEqual(original)
    expect(snapshot.photos).not.toBe(photos)
    expect(preview.photos).not.toBe(photos)
    expect(preview.photos).not.toBe(snapshot.photos)
    expect(preview.photo).toBe(original[0])
    photos.splice(0, photos.length)
    expect(snapshot.photos).toEqual(original)
    expect(preview.photos).toEqual(original)
    preview.photos!.forEach((file, index) => expect(file).toBe(original[index]))
  })

  it('스냅샷과 미리보기는 목록 배열을 복사하고 현재 입력·File 정체성을 보존한다', () => {
    const draft = { query: '  작은 지갑  ', photo: third, photos: [photo, screenshot, third] }
    const snapshot = snapshotSearchDraft('lost', draft)
    const preview = createSearchPreview('lost', draft, gallery)
    expect(snapshot.query).toBe('작은 지갑')
    expect(preview.query).toBe('작은 지갑')
    expect(preview.photo).toBe(photo)
    expect(preview.photos).toEqual([photo, screenshot, third])
    expect(preview.photos).not.toBe(draft.photos)
    expect(preview.photos).not.toBe(snapshot.photos)
    expect(preview.gallery).toBeNull()
    draft.photos.splice(0, 2)
    expect(snapshot.photos).toEqual([photo, screenshot, third])
    expect(preview.photos).toEqual([photo, screenshot, third])
    expect(draft.photo).toBe(third)
    expect(draft.query).toBe('  작은 지갑  ')
  })

  it('F1에는 기존 한 장만 유지하고 F2 목록이 섞여도 모집단이나 참고사진으로 쓰지 않는다', () => {
    const draft = { query: '사진', photo, photos: [third, screenshot] }
    const snapshot = snapshotSearchDraft('gallery', draft)
    const preview = createSearchPreview('gallery', draft, gallery)
    expect(snapshot).toEqual({ query: '사진', photo })
    expect(preview.photo).toBe(photo)
    expect(preview.photos).toBeUndefined()
    expect(preview.gallery).toEqual({ name: gallery.name, count: 2 })
    expect(validateSearch('gallery', { query: '', photo: null, photos: [third] }, gallery)).toBe('empty')
    expect(draft.photos).toEqual([third, screenshot])
  })
})

describe('F2 사진별 수동 방향 메타데이터', () => {
  const photos = Array.from({ length: 6 }, (_, index) => new File([String(index)], `view-${index}.jpg`, { type: 'image/jpeg' }))

  it('수동 선택값과 한국어 라벨을 일관되게 제공한다', () => {
    expect(REFERENCE_PHOTO_VIEWS).toEqual([
      { value: 'unspecified', label: '미지정' },
      { value: 'front', label: '정면(앞)' },
      { value: 'back', label: '뒤' },
      { value: 'side', label: '옆' },
      { value: 'top', label: '위' },
      { value: 'bottom', label: '아래' },
      { value: 'diagonal', label: '대각선' },
    ])
  })

  it('이전 한 장 입력과 방향 없는 여섯 장은 자동 추정하지 않고 미지정으로 채운다', () => {
    expect(getReferencePhotoViews({ query: '', photo })).toEqual(['unspecified'])
    expect(getReferencePhotoViews({ query: '', photo: null, photos })).toEqual(Array(6).fill('unspecified'))
  })

  it('부족·잘못된 방향은 해당 인덱스만 미지정으로 정규화하고 원본을 수정하지 않는다', () => {
    const raw = ['front', 'invalid-value', undefined, 'side', 'top']
    const draft = { query: '', photo: null, photos, photoViews: raw as ReferencePhotoView[] }
    const first = getReferencePhotoViews(draft)
    const second = getReferencePhotoViews(draft)
    expect(first).toEqual(['front', 'unspecified', 'unspecified', 'side', 'top', 'unspecified'])
    expect(first).not.toBe(second)
    expect(first).not.toBe(raw)
    expect(raw).toEqual(['front', 'invalid-value', undefined, 'side', 'top'])
  })

  it('사진보다 많은 방향은 무시하고 빈 photos가 이전 photo·방향보다 우선한다', () => {
    expect(getReferencePhotoViews({ query: '', photo, photos: photos.slice(0, 2), photoViews: ['back', 'bottom', 'top'] })).toEqual(['back', 'bottom'])
    expect(getReferencePhotoViews({ query: '', photo, photos: [], photoViews: ['front'] })).toEqual([])
  })

  it('여섯 사진의 수동 방향을 스냅샷·미리보기에 별도 배열로 보존한다', () => {
    const views: ReferencePhotoView[] = ['front', 'back', 'side', 'top', 'bottom', 'diagonal']
    const draft = { query: '같은 지갑', photo: null, photos: [...photos], photoViews: views }
    const snapshot = snapshotSearchDraft('lost', draft)
    const preview = createSearchPreview('lost', draft, gallery)
    expect(snapshot.photoViews).toEqual(views)
    expect(preview.photoViews).toEqual(views)
    expect(snapshot.photoViews).not.toBe(views)
    expect(preview.photoViews).not.toBe(views)
    expect(preview.photoViews).not.toBe(snapshot.photoViews)
    views.splice(0, views.length, 'unspecified')
    draft.photos.splice(0, 1)
    expect(snapshot.photoViews).toEqual(['front', 'back', 'side', 'top', 'bottom', 'diagonal'])
    expect(preview.photoViews).toEqual(snapshot.photoViews)
    expect(snapshot.photos).toEqual(photos)
    expect(preview.photo).toBe(photos[0])
  })

  it('F1 스냅샷과 미리보기에는 F2 목록·방향을 넣지 않는다', () => {
    const draft: SearchDraft = { query: '내 사진', photo, photos, photoViews: ['front', 'back'] }
    expect(snapshotSearchDraft('gallery', draft)).toEqual({ query: '내 사진', photo })
    const preview = createSearchPreview('gallery', draft, gallery)
    expect(preview.photos).toBeUndefined()
    expect(preview.photoViews).toBeUndefined()
    expect(draft.photoViews).toEqual(['front', 'back'])
  })
})

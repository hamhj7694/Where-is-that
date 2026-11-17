import { describe, expect, it } from 'vitest'
import { appendGallery, canSubmitWithEnter, collectGallery, createSearchPreview, getReferencePhotos, MAX_LOST_REFERENCE_PHOTOS, snapshotSearchDraft, validateSearch, type SearchDraft } from './model'

const photo = new File(['fixture'], 'wallet.jpg', { type: 'image/jpeg' })
const screenshot = new File(['fixture'], 'schedule.png', { type: 'image/png' })
const gallery = { name: '내 갤러리', files: [photo, screenshot] }

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
    expect(snapshotSearchDraft('lost', draft)).toEqual({ query: '', photo, photos: [photo] })
    expect(getReferencePhotos({ query: '', photo: null })).toEqual([])
    expect(validateSearch('lost', draft, null)).toBeNull()
  })

  it('photos가 정의되면 빈 배열도 대표사진 fallback보다 우선한다', () => {
    const photos: File[] = []
    const draft = { query: '', photo, photos }
    expect(getReferencePhotos(draft)).toBe(photos)
    expect(snapshotSearchDraft('lost', draft)).toEqual({ query: '', photo: null, photos: [] })
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

  it('F2 3장 상한을 검사하며 목록을 조용히 잘라내지 않는다', () => {
    const photos = [photo, screenshot, third, new File(['fourth'], 'fourth.jpg', { type: 'image/jpeg' })]
    expect(MAX_LOST_REFERENCE_PHOTOS).toBe(3)
    expect(validateSearch('lost', { query: '추가 설명', photo, photos }, null)).toBe('too-many-photos')
    expect(photos).toHaveLength(4)
    expect(getReferencePhotos({ query: '', photo, photos })).toHaveLength(4)
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

import { describe, expect, it } from 'vitest'
import { clearFileLocations, getFileLocation, prepareFileLocations, rememberFileLocations, rememberNativeFileLocations } from './file-location-model'

function photo(name = '사진.jpg', relative = ''): File {
  const file = new File(['same bytes'], name, { type: 'image/jpeg' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relative })
  return file
}

describe('사용자 기준 폴더와 브라우저 상대 경로 조합', () => {
  it('네이티브 선택창의 실제 경로를 수동 입력과 구별하고 수동 정보 삭제에도 유지한다', () => {
    const file = photo('a.jpg', 'images/nested/a.jpg')
    rememberFileLocations(prepareFileLocations([file], 'C:\\Manual\\images'))
    rememberNativeFileLocations([{ file, path: 'D:\\Actual\\images\\nested\\a.jpg' }])
    expect(getFileLocation(file)).toEqual({ path: 'D:\\Actual\\images\\nested\\a.jpg', source: 'local-connector' })
    clearFileLocations([file])
    expect(getFileLocation(file)).toEqual({ path: 'D:\\Actual\\images\\nested\\a.jpg', source: 'local-connector' })
    expect(getFileLocation(photo('a.jpg', 'images/nested/a.jpg'))).toEqual({ path: 'images/nested/a.jpg', source: 'browser-relative' })
  })

  it('네이티브 경로도 전체 검증 실패 시 기존 위치를 바꾸지 않는다', () => {
    const first = photo('a.jpg'), second = photo('b.jpg')
    rememberNativeFileLocations([{ file: first, path: 'C:\\Old\\a.jpg' }])
    expect(() => rememberNativeFileLocations([{ file: first, path: 'C:\\New\\a.jpg' }, { file: second, path: 'C:\\fakepath\\b.jpg' }])).toThrow()
    expect(getFileLocation(first)?.path).toBe('C:\\Old\\a.jpg')
    expect(getFileLocation(second)).toBeNull()
  })

  it('선택 루트만 한 번 제거하고 하위 경로·순서·원 File 정체성을 보존한다', () => {
    const first = photo('a.jpg', 'train/a.jpg')
    const second = photo('b.jpg', 'train/train/한글 폴더/b.jpg')
    const files = [first, second]
    const prepared = prepareFileLocations(files, 'C:\\사진\\train')
    expect(prepared).toEqual([
      { file: first, path: 'C:\\사진\\train\\a.jpg' },
      { file: second, path: 'C:\\사진\\train\\train\\한글 폴더\\b.jpg' },
    ])
    expect(prepared[0].file).toBe(first)
    expect(prepared[1].file).toBe(second)
    expect(files).toEqual([first, second])
    expect(first.webkitRelativePath).toBe('train/a.jpg')
    expect(getFileLocation(first)).toEqual({ path: 'train/a.jpg', source: 'browser-relative' })
  })

  it('대소문자 무시 루트 비교와 슬래시 정규화·바깥 따옴표를 지원한다', () => {
    const file = photo('사진 1.jpg', 'Train/하위 폴더/사진 1.jpg')
    expect(prepareFileLocations([file], '  "c:/내 사진/train/"  ')[0].path).toBe('c:\\내 사진\\train\\하위 폴더\\사진 1.jpg')
    expect(prepareFileLocations([file], " 'D:\\앨범\\TRAIN' ")[0].path).toBe('D:\\앨범\\TRAIN\\하위 폴더\\사진 1.jpg')
  })

  it('사진만 선택하면 입력한 부모 폴더에 파일명을 붙이고 드라이브 루트도 허용한다', () => {
    const file = photo('원본 사진.jpg')
    expect(prepareFileLocations([file], 'D:\\내 사진')[0].path).toBe('D:\\내 사진\\원본 사진.jpg')
    expect(prepareFileLocations([file], 'D:\\')[0].path).toBe('D:\\원본 사진.jpg')
  })

  it('UNC 공유 폴더를 절대 경로로 지원한다', () => {
    const file = photo('사진.jpg', '여행/사진.jpg')
    expect(prepareFileLocations([file], '\\\\NAS\\공유 사진\\여행')[0].path).toBe('\\\\NAS\\공유 사진\\여행\\사진.jpg')
    expect(prepareFileLocations([photo('a.jpg')], '//NAS/share')[0].path).toBe('\\\\NAS\\share\\a.jpg')
  })

  it('선택 폴더명 불일치나 드라이브 루트는 폴더 경로를 추측하지 않고 거절한다', () => {
    const file = photo('사진.jpg', 'train/사진.jpg')
    expect(() => prepareFileLocations([file], 'C:\\사진\\other')).toThrow('마지막 폴더 이름')
    expect(() => prepareFileLocations([file], 'C:\\')).toThrow('마지막 폴더 이름')
  })

  it('빈 파일 목록은 검증된 기준 폴더에서 빈 준비 목록을 반환한다', () => {
    expect(prepareFileLocations([], 'C:\\사진')).toEqual([])
  })

  it.each([
    '', '사진\\train', 'C:사진', '\\사진\\train', 'https://example.com/train', 'file:///C:/train',
    'blob:fake', 'C:\\fakepath\\train', '\\\\server', '\\\\?\\C:\\train',
    'C:\\사진\\..\\train', 'C:\\사진\\.\\train', 'C:\\사진\n\\train', 'C:\\사진\t\\train',
    'C:\\사진\\bad:name', '"C:\\사진\\train. "',
  ])('비정상 기준 경로를 거절한다: %j', base => {
    expect(() => prepareFileLocations([photo()], base)).toThrow()
  })

  it.each([
    ['a.jpg', '../a.jpg'], ['a.jpg', '/train/a.jpg'], ['a.jpg', 'train//a.jpg'],
    ['a.jpg', 'train/../a.jpg'], ['a.jpg', 'train/./a.jpg'], ['a.jpg', 'train/다른이름.jpg'],
    ['a?.jpg', 'train/a?.jpg'], ['NUL.jpg', 'train/NUL.jpg'], ['a.jpg', 'train/bad\u0000/a.jpg'],
  ])('비정상 파일명·상대 경로를 거절한다: %j, %j', (name, relative) => {
    expect(() => prepareFileLocations([photo(name, relative)], 'C:\\사진\\train')).toThrow()
  })
})

describe('File 정체성별 세션 위치', () => {
  it('준비는 저장하지 않고 명시적 remember 이후에만 사용자 경로를 제공한다', () => {
    const file = photo('a.jpg', 'train/a.jpg')
    const prepared = prepareFileLocations([file], 'C:\\사진\\train')
    expect(getFileLocation(file)).toEqual({ path: 'train/a.jpg', source: 'browser-relative' })
    rememberFileLocations(prepared)
    expect(getFileLocation(file)).toEqual({ path: 'C:\\사진\\train\\a.jpg', source: 'user-provided' })
    const value = getFileLocation(file)!
    value.path = '호출자만 수정'
    expect(getFileLocation(file)!.path).toBe('C:\\사진\\train\\a.jpg')
    expect(getFileLocation(photo('a.jpg', 'train/a.jpg'))).toEqual({ path: 'train/a.jpg', source: 'browser-relative' })
  })

  it('경로 없는 사진의 이름·blob·fakepath를 위치로 대신 반환하지 않는다', () => {
    expect(getFileLocation(photo('사진.jpg'))).toBeNull()
    expect(getFileLocation(photo('a.jpg', 'C:\\fakepath\\a.jpg'))).toBeNull()
    expect(getFileLocation(photo('a.jpg', 'train/../a.jpg'))).toBeNull()
    expect(getFileLocation(photo('a.jpg', 'blob:preview/a.jpg'))).toBeNull()
  })

  it('준비 중 어느 파일이 실패해도 기존 기억 위치와 다른 File 위치를 바꾸지 않는다', () => {
    const first = photo('a.jpg', 'train/a.jpg')
    const second = photo('b.jpg', 'other/b.jpg')
    rememberFileLocations(prepareFileLocations([first], 'C:\\기존\\train'))
    expect(() => prepareFileLocations([first, second], 'D:\\새 위치\\train')).toThrow()
    expect(getFileLocation(first)).toEqual({ path: 'C:\\기존\\train\\a.jpg', source: 'user-provided' })
    expect(getFileLocation(second)).toEqual({ path: 'other/b.jpg', source: 'browser-relative' })
  })

  it('remember도 전체 검증 후 저장해 잘못된 후속 항목이 부분 변경을 남기지 않는다', () => {
    const first = photo('a.jpg')
    const second = photo('b.jpg')
    rememberFileLocations(prepareFileLocations([first], 'C:\\기존'))
    expect(() => rememberFileLocations([
      { file: first, path: 'D:\\새 위치\\a.jpg' },
      { file: second, path: 'D:\\새 위치\\wrong.jpg' },
    ])).toThrow()
    expect(getFileLocation(first)!.path).toBe('C:\\기존\\a.jpg')
    expect(getFileLocation(second)).toBeNull()
  })

  it('지정한 File만 지우고 폴더 상대 경로 fallback과 다른 File 기억은 유지한다', () => {
    const folder = photo('a.jpg', 'train/a.jpg')
    const plain = photo('b.jpg')
    const other = photo('c.jpg')
    rememberFileLocations(prepareFileLocations([folder], 'C:\\사진\\train'))
    rememberFileLocations(prepareFileLocations([plain, other], 'D:\\사진'))
    clearFileLocations([folder, plain])
    expect(getFileLocation(folder)).toEqual({ path: 'train/a.jpg', source: 'browser-relative' })
    expect(getFileLocation(plain)).toBeNull()
    expect(getFileLocation(other)).toEqual({ path: 'D:\\사진\\c.jpg', source: 'user-provided' })
  })
})

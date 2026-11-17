import { describe, expect, it, vi } from 'vitest'
import { prepareGallerySelection } from './gallery-deduplication'

function image(content: string, name = 'photo.jpg', path = '', type = 'image/jpeg') {
  const file = new File([content], name, { type, lastModified: 12345 })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

describe('갤러리 연결·추가의 내용 기반 중복 제외', () => {
  it('기존 이미지와 내용이 같으면 이름·폴더·확장자가 달라도 제외한다', async () => {
    const original = image('same image bytes', 'wallet.jpg', '여행/물건/wallet.jpg')
    const renamed = image('same image bytes', 'copy.png', '업무/하위/더깊은/copy.png', 'image/png')
    expect(await prepareGallerySelection([original], [renamed])).toEqual({ files: [], imageCount: 1, duplicateCount: 1 })
  })

  it('이름·경로·크기·수정시각이 같아도 내용이 다르면 새 이미지로 유지한다', async () => {
    const original = image('AAAA', 'same.jpg', '폴더/same.jpg')
    const changed = image('BBBB', 'same.jpg', '폴더/same.jpg')
    const result = await prepareGallerySelection([original], [changed])
    expect(result).toEqual({ files: [changed], imageCount: 1, duplicateCount: 0 })
    expect(result.files[0]).toBe(changed)
  })

  it('이번 선택 안에서도 첫 이미지 한 장만 남기며 기존 File 참조도 중복으로 센다', async () => {
    const first = image('first')
    const copy = image('first', 'renamed.jpg')
    const other = image('other')
    const result = await prepareGallerySelection([], [first, copy, first, other])
    expect(result).toEqual({ files: [first, other], imageCount: 4, duplicateCount: 2 })
    expect(result.files[0]).toBe(first)
    expect(result.files[1]).toBe(other)
    expect(await prepareGallerySelection([first], [first])).toEqual({ files: [], imageCount: 1, duplicateCount: 1 })
  })

  it('하위 폴더의 새 이미지 순서·원참조·경로 및 입력 배열을 보존한다', async () => {
    const old = image('old', 'photo.jpg', '기존/photo.jpg')
    const duplicate = image('old', '복사.jpg', '새폴더/a/복사.jpg')
    const first = image('new', 'photo.jpg', '새폴더/a/deep/photo.jpg')
    const last = image('last', 'photo.jpg', '새폴더/b/deeper/photo.jpg')
    const existing = Object.freeze([old])
    const selected = Object.freeze([duplicate, first, last])
    const result = await prepareGallerySelection(existing, selected)
    expect(result).toEqual({ files: [first, last], imageCount: 3, duplicateCount: 1 })
    expect(result.files[0]).toBe(first)
    expect(result.files[1]).toBe(last)
    expect(result.files.map(file => file.webkitRelativePath)).toEqual(['새폴더/a/deep/photo.jpg', '새폴더/b/deeper/photo.jpg'])
    expect(existing).toEqual([old])
    expect(selected).toEqual([duplicate, first, last])
    expect(await old.text()).toBe('old')
  })

  it('이미지만 세고 MIME 없는 지원 확장자는 포함하며 빈 선택은 빈 결과를 반환한다', async () => {
    const document = new File(['note'], 'notes.txt', { type: 'text/plain' })
    const extensionImage = image('bytes', 'screen.PNG', '', '')
    expect(await prepareGallerySelection([], [document, extensionImage])).toEqual({ files: [extensionImage], imageCount: 1, duplicateCount: 0 })
    expect(await prepareGallerySelection([extensionImage], [])).toEqual({ files: [], imageCount: 0, duplicateCount: 0 })
    expect(await prepareGallerySelection([], [document])).toEqual({ files: [], imageCount: 0, duplicateCount: 0 })
  })

  it('기존 목록의 중복은 선제 삭제하지 않고 새 후보만 제외한다', async () => {
    const old = image('same')
    const alreadyDuplicated = image('same', 'already.jpg')
    const incoming = image('same', 'incoming.jpg')
    const existing = Object.freeze([old, alreadyDuplicated])
    expect(await prepareGallerySelection(existing, [incoming])).toEqual({ files: [], imageCount: 1, duplicateCount: 1 })
    expect(existing).toEqual([old, alreadyDuplicated])
  })

  it('크기가 다른 후보는 읽지 않으며 필요한 비교의 같은 File 해시는 재사용한다', async () => {
    const unique = [image('a'), image('bb'), image('ccc')]
    const reads = unique.map(file => vi.spyOn(file, 'arrayBuffer'))
    expect((await prepareGallerySelection([], unique)).files).toEqual(unique)
    for (const read of reads) expect(read).not.toHaveBeenCalled()

    const original = image('cached bytes')
    const read = vi.spyOn(original, 'arrayBuffer')
    await prepareGallerySelection([original], [image('cached bytes', 'copy1.jpg')])
    await prepareGallerySelection([original], [image('cached bytes', 'copy2.jpg')])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('내용 읽기 실패는 부분 결과 대신 예외를 전달하고 실패 캐시는 다음 시도에서 제거한다', async () => {
    const original = image('old!')
    const incoming = image('new!')
    const acceptedEarlier = image('unique-length')
    const failure = new Error('file cannot be read')
    const originalRead = original.arrayBuffer.bind(original)
    const read = vi.spyOn(original, 'arrayBuffer').mockRejectedValueOnce(failure).mockImplementation(originalRead)
    const existing = Object.freeze([original])
    const selected = Object.freeze([acceptedEarlier, incoming])
    await expect(prepareGallerySelection(existing, selected)).rejects.toBe(failure)
    expect(existing).toEqual([original])
    expect(selected).toEqual([acceptedEarlier, incoming])
    expect(await prepareGallerySelection(existing, selected)).toEqual({ files: [acceptedEarlier, incoming], imageCount: 2, duplicateCount: 0 })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('이미 취소된 신호는 빈 선택이어도 읽거나 성공하지 않는다', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareGallerySelection([], [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('읽는 도중 취소하면 즉시 예외를 전달하며 기존/선택 파일은 그대로 둔다', async () => {
    const original = image('old!')
    const incoming = image('new!')
    const bytes = await incoming.arrayBuffer()
    let release!: (value: ArrayBuffer) => void
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const reading = new Promise<ArrayBuffer>(resolve => { release = resolve })
    vi.spyOn(incoming, 'arrayBuffer').mockImplementation(() => { started(); return reading })
    const existing = Object.freeze([original])
    const selected = Object.freeze([incoming])
    const controller = new AbortController()
    const pending = prepareGallerySelection(existing, selected, controller.signal)
    await began
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(existing[0]).toBe(original)
    expect(selected[0]).toBe(incoming)
    // A native Blob read is not cancellable. Let it finish and verify a later
    // selection can reuse its fingerprint without inheriting the cancellation.
    release(bytes)
    expect((await prepareGallerySelection([], [incoming, image('new!', 'copy.jpg')])).duplicateCount).toBe(1)
  })

  it('동시에 시작한 준비에서도 파일 읽기는 한 번에 하나만 실행한다', async () => {
    let active = 0
    let maximum = 0
    const files = ['aaaa', 'bbbb', 'cccc', 'dddd'].map(value => image(value))
    for (const file of files) {
      const read = file.arrayBuffer.bind(file)
      vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
        active++; maximum = Math.max(maximum, active)
        try { await new Promise(resolve => setTimeout(resolve, 1)); return await read() }
        finally { active-- }
      })
    }
    const results = await Promise.all([
      prepareGallerySelection([files[0]], [files[1]]),
      prepareGallerySelection([files[2]], [files[3]]),
    ])
    expect(maximum).toBe(1)
    expect(results.map(result => result.files[0])).toEqual([files[1], files[3]])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { prepareLostReferenceFiles } from './lost-reference-import'

const photos = ['front.jpg', 'back.jpg', 'detail.jpg'].map((name, index) => new File([String(index)], name, { type: 'image/jpeg' }))
const noRead = async () => undefined

describe('분실물 참고 사진 선택 준비', () => {
  it('최대3장을 순차 확인하고 원본 File·순서·입력 배열을 보존한다', async () => {
    const selected = Object.freeze([...photos])
    const visited: File[] = []
    let active = 0
    let maximum = 0
    const result = await prepareLostReferenceFiles(selected, 0, { read: async file => {
      active++; maximum = Math.max(maximum, active)
      await Promise.resolve()
      visited.push(file)
      active--
    } })
    expect(result).toEqual(photos)
    expect(result).not.toBe(selected)
    expect(visited).toEqual(photos)
    expect(maximum).toBe(1)
    result.forEach((file, index) => expect(file).toBe(selected[index]))
    expect(selected).toEqual(photos)
  })

  it('기존2장 뒤1장은 허용하고3장 초과는 읽기 전에 친절한 오류로 중단한다', async () => {
    const read = vi.fn(noRead)
    expect(await prepareLostReferenceFiles([photos[0]], 2, { read })).toEqual([photos[0]])
    read.mockClear()
    await expect(prepareLostReferenceFiles([photos[0], photos[1]], 2, { read })).rejects.toThrow('참고 사진은 최대 3장까지 추가할 수 있어요.')
    await expect(prepareLostReferenceFiles([...photos, photos[0]], 0, { read })).rejects.toThrow('최대 3장')
    expect(read).not.toHaveBeenCalled()
  })

  it('교체는 기존3장에서도 한 장만 허용하며 여러 장이면 읽기 전에 중단한다', async () => {
    const read = vi.fn(noRead)
    expect(await prepareLostReferenceFiles([photos[1]], 3, { replace: true, read })).toEqual([photos[1]])
    read.mockClear()
    await expect(prepareLostReferenceFiles(photos, 1, { replace: true, read })).rejects.toThrow('사진을 바꿀 때는 한 장만 선택해 주세요.')
    expect(read).not.toHaveBeenCalled()
  })

  it('빈 선택은 아무 파일도 읽지 않고 빈 배열로 유지한다', async () => {
    const read = vi.fn(noRead)
    expect(await prepareLostReferenceFiles([], 3, { read })).toEqual([])
    expect(await prepareLostReferenceFiles([], 3, { replace: true, read })).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('기본 읽기 검증은 비이미지 파일을 성공 처리하지 않는다', async () => {
    const file = new File(['text'], 'note.txt', { type: 'text/plain' })
    await expect(prepareLostReferenceFiles([file], 0)).rejects.toThrow('이 사진 형식은 사용할 수 없어요.')
  })

  it('이미 취소된 선택은 파일을 읽지 않는다', async () => {
    const signal = AbortSignal.abort()
    const read = vi.fn(noRead)
    await expect(prepareLostReferenceFiles(photos, 0, { signal, read })).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })

  it('지연된 첫 읽기가 끝나기 전 다음 파일을 읽거나 부분 배열을 반환하지 않는다', async () => {
    let release!: () => void
    const firstRead = new Promise<void>(resolve => { release = resolve })
    const read = vi.fn((file: File) => file === photos[0] ? firstRead : Promise.resolve())
    let settled = false
    const pending = prepareLostReferenceFiles(photos, 0, { read }).finally(() => { settled = true })
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    release()
    expect(await pending).toEqual(photos)
    expect(read.mock.calls.map(([file]) => file)).toEqual(photos)
  })

  it('준비 도중 호출자가 선택 배열을 바꿔도 처음 선택한 순서·범위를 확인한다', async () => {
    let release!: () => void
    const firstRead = new Promise<void>(resolve => { release = resolve })
    const selected = [...photos]
    const read = vi.fn((file: File) => file === photos[0] ? firstRead : Promise.resolve())
    const pending = prepareLostReferenceFiles(selected, 0, { read })
    selected.splice(0, selected.length)
    release()
    expect(await pending).toEqual(photos)
    expect(read.mock.calls.map(([file]) => file)).toEqual(photos)
    expect(selected).toEqual([])
  })

  it('읽는 중 취소하면 완료 후 예외를 내고 다음 사진을 읽지 않는다', async () => {
    let release!: () => void
    const firstRead = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController()
    const read = vi.fn(() => firstRead)
    const selected = Object.freeze([...photos])
    const pending = prepareLostReferenceFiles(selected, 0, { signal: controller.signal, read })
    controller.abort()
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(selected).toEqual(photos)
  })

  it('중간 읽기 실패는 예외를 전달하고 앞서 성공한 파일도 반환하지 않는다', async () => {
    const failure = new Error('사진을 읽지 못했어요.')
    const read = vi.fn(async (file: File) => { if (file === photos[1]) throw failure })
    const selected = Object.freeze([...photos])
    await expect(prepareLostReferenceFiles(selected, 0, { read })).rejects.toBe(failure)
    expect(read.mock.calls.map(([file]) => file)).toEqual(photos.slice(0, 2))
    expect(selected).toEqual(photos)
    expect(await photos[0].text()).toBe('0')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalGalleryStatus, localGalleryAllowed, LocalGalleryUnavailableError, pickLocalGallery } from './local-gallery-client'

const token = 'test-token-do-not-log'
const descriptor = (id = 'file-1', patch: Record<string, unknown> = {}) => ({ id, name: id + '.jpg', absolutePath: 'C:\\사진\\하위\\' + id + '.jpg', relativePath: '사진/하위/' + id + '.jpg', size: 3, lastModified: 12345, type: 'image/jpeg', ...patch })
const status = (patch: Record<string, unknown> = {}) => new Response(JSON.stringify({ service: 'geugeo-eodi-local-gallery', version: 1, supported: true, token, ...patch }), { headers: { 'Content-Type': 'application/json' } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

function mockBridge(payload: unknown, read?: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init })
    if (url.endsWith('/v1/status')) return status()
    if (url.endsWith('/v1/select')) return json(payload)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return read ? read(url, init) : new Response(new Uint8Array([1, 2, 3]))
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch }
}

beforeEach(() => { vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('개발용 로컬 사진 보조 프로그램 capability', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])('%s 개발 환경만 허용한다', hostname => {
    expect(localGalleryAllowed(true, hostname)).toBe(true)
    expect(localGalleryAllowed(false, hostname)).toBe(false)
  })
  it.each(['example.com', '192.168.0.2', 'localhost.example.com', '127.0.0.1.example.com', ''])('%s에서는 조회 자체를 하지 않는다', async hostname => {
    vi.stubGlobal('window', { location: { hostname } })
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(await getLocalGalleryStatus()).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([{ service: 'different-service' }, { version: 2 }, { supported: 'true' }, { token: '' }, { token: 'bad\r\ntoken' }])('서비스 신원/토큰이 다른 응답을 거절한다: %j', async patch => {
    vi.stubGlobal('fetch', vi.fn(async () => status(patch)))
    expect(await getLocalGalleryStatus()).toBeNull()
  })
  it('미지원·연결 실패는 선택 대신 브라우저 fallback으로 보낸다', async () => {
    const fetch = vi.fn(async () => status({ supported: false })); vi.stubGlobal('fetch', fetch)
    await expect(pickLocalGallery('images', new AbortController().signal)).rejects.toBeInstanceOf(LocalGalleryUnavailableError)
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('unreachable') }))
    expect(await getLocalGalleryStatus()).toBeNull()
  })
  it('이미 취소된 요청은 네트워크를 시작하지 않는다', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const controller = new AbortController(); controller.abort()
    await expect(pickLocalGallery('folder', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('선택 목록의 경로·내용·수명 계약', () => {
  it('전체 File/순서/하위 경로와 서버가 반환한 절대경로만 전달하고 토큰을 URL에 넣지 않는다', async () => {
    const first = descriptor('first')
    const last = descriptor('last', { name: '한글.png', absolutePath: 'D:\\새폴더\\깊은\\한글.png', relativePath: '새폴더/깊은/한글.png', type: 'image/png' })
    const { calls } = mockBridge({ selectionId: 'selection-1', files: [first, last] })
    const progress: number[] = []
    const result = await pickLocalGallery('folder', new AbortController().signal, value => progress.push(value.completed))
    expect(result?.files.map(file => [file.name, file.webkitRelativePath, file.size, file.lastModified, file.type])).toEqual([
      ['first.jpg', first.relativePath, 3, 12345, 'image/jpeg'], ['한글.png', last.relativePath, 3, 12345, 'image/png'],
    ])
    expect(result?.locations.map(item => item.path)).toEqual([first.absolutePath, last.absolutePath])
    expect(result?.locations[0].file).toBe(result?.files[0])
    expect(progress).toEqual([0, 1, 2])
    for (const call of calls.filter(call => !call.url.endsWith('/status'))) {
      expect(new Headers(call.init.headers).get('X-Local-Gallery-Token')).toBe(token)
      expect(call.url).not.toContain(token)
      expect(call.init.credentials).toBe('omit')
      expect(call.init.redirect).toBe('error')
    }
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })
  it('파일 선택의 빈 상대경로와 UNC 전체 경로를 조합하거나 추측하지 않는다', async () => {
    const file = descriptor('file-1', { absolutePath: '\\\\server\\share\\file-1.jpg', relativePath: '' })
    mockBridge({ selectionId: 'selection-1', files: [file] })
    const result = await pickLocalGallery('images', new AbortController().signal)
    expect(result?.files[0].webkitRelativePath).toBe('')
    expect(result?.locations[0].path).toBe(file.absolutePath)
  })
  it('사용자가 파일 대화상자를 취소하면 오류·파일 요청 없이 null이다', async () => {
    const { calls } = mockBridge({ canceled: true })
    expect(await pickLocalGallery('images', new AbortController().signal)).toBeNull()
    expect(calls).toHaveLength(2)
  })
  it('폴더에 이미지가 없으면 결과를 반환하지 않고 selection을 해제한다', async () => {
    const { calls } = mockBridge({ selectionId: 'selection-1', files: [] })
    await expect(pickLocalGallery('folder', new AbortController().signal)).rejects.toThrow('이미지를 찾지 못했어요')
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })
  it.each([
    { name: '../file.jpg' }, { absolutePath: 'relative/file-1.jpg' }, { absolutePath: 'C:\\fakepath\\file-1.jpg' },
    { absolutePath: 'C:\\사진\\other.jpg' }, { relativePath: '../file-1.jpg' }, { relativePath: '다른폴더/file-1.jpg' },
    { relativePath: '/사진/하위/file-1.jpg' }, { relativePath: '사진\\하위\\file-1.jpg' },
    { size: -1 }, { size: 0 }, { size: 3.5 }, { lastModified: 'yesterday' }, { type: 'text/plain' }, { id: '../escape' },
  ])('잘못된 descriptor는 byte 요청 전 전체를 거절하고 해제한다: %j', async patch => {
    const { calls } = mockBridge({ selectionId: 'selection-1', files: [descriptor(), descriptor('second', patch)] })
    await expect(pickLocalGallery('folder', new AbortController().signal)).rejects.toThrow()
    expect(calls.some(call => call.url.includes('/v1/files/'))).toBe(false)
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })
  it('중복 파일 ID와 폴더의 빈 상대경로를 거절한다', async () => {
    let bridge = mockBridge({ selectionId: 'selection-1', files: [descriptor(), descriptor()] })
    await expect(pickLocalGallery('folder', new AbortController().signal)).rejects.toThrow()
    expect(bridge.calls.some(call => call.url.includes('/files/'))).toBe(false)
    bridge = mockBridge({ selectionId: 'selection-2', files: [descriptor('file-1', { relativePath: '' })] })
    await expect(pickLocalGallery('folder', new AbortController().signal)).rejects.toThrow()
    expect(bridge.calls.at(-1)?.init.method).toBe('DELETE')
  })
  it('바이트 크기가 다르거나 하나라도 실패하면 부분 File 목록을 반환하지 않는다', async () => {
    const { calls } = mockBridge({ selectionId: 'selection-1', files: [descriptor('first'), descriptor('bad')] }, async url => new Response(new Uint8Array(url.endsWith('/bad') ? [1] : [1, 2, 3])))
    await expect(pickLocalGallery('folder', new AbortController().signal)).rejects.toThrow('모두 읽지 못했어요')
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })
  it('바이트 읽기는 최대4개이며 늦게 끝나는 첫 파일도 원래 목록 순서를 유지한다', async () => {
    let active = 0; let maximum = 0
    mockBridge({ selectionId: 'selection-1', files: Array.from({ length: 10 }, (_, index) => descriptor('file-' + index)) }, async url => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, url.endsWith('/file-0') ? 8 : 1))
      active--
      return new Response(new Uint8Array([1, 2, 3]))
    })
    const result = await pickLocalGallery('folder', new AbortController().signal)
    expect(maximum).toBe(4)
    expect(result?.files.map(file => file.name)).toEqual(Array.from({ length: 10 }, (_, index) => 'file-' + index + '.jpg'))
  })
  it('읽는 중 취소는 작업을 중단하고 별도 신호로 selection을 해제한다', async () => {
    const controller = new AbortController()
    let began!: () => void
    const reading = new Promise<void>(resolve => { began = resolve })
    const { calls } = mockBridge({ selectionId: 'selection-1', files: Array.from({ length: 8 }, (_, index) => descriptor('file-' + index)) }, async (_url, init) => {
      began()
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
    })
    const result = pickLocalGallery('folder', controller.signal)
    await reading; controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.filter(call => call.url.includes('/v1/files/'))).toHaveLength(4)
    const release = calls.at(-1)!
    expect(release.init.method).toBe('DELETE')
    expect(release.init.signal?.aborted).toBe(false)
  })
  it('해제 대기 중 취소되어도 성공 파일을 반환하지 않는다', async () => {
    const controller = new AbortController()
    const { fetch } = mockBridge({ selectionId: 'selection-1', files: [descriptor()] })
    const implementation = fetch.getMockImplementation()!
    fetch.mockImplementation(async (input, init = {}) => {
      if (init.method === 'DELETE') controller.abort()
      return implementation(input, init)
    })
    await expect(pickLocalGallery('folder', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Buffer } from 'node:buffer'
import { createLocalGalleryServer } from './bridge.mjs'

const { fetch, AbortController, AbortSignal } = globalThis

const ORIGIN = 'http://127.0.0.1:5173'
let directory, root, outside, server, base, token, paths, picker

async function start(options = {}) {
  picker = options.pickPaths ?? vi.fn(async () => paths)
  server = createLocalGalleryServer({ platform: 'win32', ...options, pickPaths: picker })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  token = (await (await fetch(base + '/v1/status')).json()).token
}
function api(route, options = {}) {
  return fetch(base + route, { ...options, headers: { Origin: ORIGIN, 'X-Local-Gallery-Token': token, ...options.headers } })
}
function select(kind = 'folder', options = {}) {
  return api('/v1/select', { method: 'POST', ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify({ kind }) })
}
function fileUrl(selection, file = selection.files[0]) { return `/v1/files/${selection.selectionId}/${file.id}` }

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'geugeo-bridge-'))
  root = path.join(directory, '한글 사진 폴더')
  outside = path.join(directory, '선택하지 않은 폴더')
  await mkdir(path.join(root, '하위 폴더'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(root, 'a.jpg'), 'selected jpeg bytes')
  await writeFile(path.join(root, '하위 폴더', 'b.PNG'), 'selected png bytes')
  await writeFile(path.join(root, 'notes.txt'), 'not an image')
  await writeFile(path.join(root, 'active.svg'), '<svg/>')
  await writeFile(path.join(outside, 'secret.jpg'), 'outside bytes')
  paths = [root]
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    server = undefined
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('로컬 사진 선택 HTTP 계약', () => {
  it('상태는 서비스·버전·Windows 지원 여부와 256bit 세션 토큰을 반환한다', async () => {
    await start()
    const response = await fetch(base + '/v1/status')
    expect(await response.json()).toEqual({ service: 'geugeo-eodi-local-gallery', version: 1, supported: true, token })
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(picker).not.toHaveBeenCalled()
  })

  it('실제 선택한 폴더의 하위 이미지만 메타데이터·절대경로·루트 포함 상대경로로 반환한다', async () => {
    await start()
    const response = await select()
    expect(response.status).toBe(200)
    const selection = await response.json()
    expect(selection.selectionId).toMatch(/^[a-f0-9]{32}$/)
    expect(selection.files).toHaveLength(2)
    const file = selection.files.find(item => item.name === 'b.PNG')
    expect(file).toMatchObject({
      absolutePath: await realpath(path.join(root, '하위 폴더', 'b.PNG')),
      relativePath: '한글 사진 폴더/하위 폴더/b.PNG',
      name: 'b.PNG', type: 'image/png', size: Buffer.byteLength('selected png bytes'),
    })
    expect(Number.isFinite(file.lastModified)).toBe(true)
    expect(file).not.toHaveProperty('root')
    expect(file).not.toHaveProperty('ino')
    expect(file.id).not.toContain(file.name)
    expect(picker).toHaveBeenCalledWith('folder', { signal: expect.any(AbortSignal) })
    const reads = await Promise.all(selection.files.map(item => api(fileUrl(selection, item))))
    expect(reads.every(item => item.status === 200)).toBe(true)
    expect(reads[0].headers.get('x-content-type-options')).toBe('nosniff')
    expect(reads[0].headers.get('cache-control')).toBe('no-store')
    expect(await Promise.all(reads.map(item => item.text()))).toEqual(expect.arrayContaining(['selected jpeg bytes', 'selected png bytes']))
  })

  it('사진 선택은 고른 파일만 제공하며 상대경로는 비운다', async () => {
    paths = [path.join(root, 'a.jpg'), path.join(outside, 'secret.jpg'), path.join(root, 'notes.txt')]
    await start()
    const selection = await (await select('images')).json()
    expect(selection.files.map(file => file.name)).toEqual(['a.jpg', 'secret.jpg'])
    expect(selection.files.every(file => file.relativePath === '')).toBe(true)
    expect(await (await api(fileUrl(selection, selection.files[1]))).text()).toBe('outside bytes')
  })

  it('선택 취소는 권한 ID 없는 canceled 응답이고 빈 이미지 폴더는 빈 목록을 반환한다', async () => {
    await start()
    paths = null
    expect(await (await select()).json()).toEqual({ canceled: true })
    paths = []
    expect(await (await select('images')).json()).toEqual({ canceled: true })
    const empty = path.join(directory, 'empty')
    await mkdir(empty)
    paths = [empty]
    const selection = await (await select()).json()
    expect(selection).toEqual({ selectionId: expect.any(String), files: [] })
  })

  it('Windows 외 플랫폼은 상태만 제공하고 선택기를 실행하지 않는다', async () => {
    await start({ platform: 'linux' })
    expect((await (await api('/v1/status')).json()).supported).toBe(false)
    expect((await select()).status).toBe(501)
    expect(picker).not.toHaveBeenCalled()
  })

  it('동시 선택은409이며 첫 선택 종료 후 다시 선택할 수 있다', async () => {
    let finish
    await start({ pickPaths: vi.fn(() => new Promise(resolve => { finish = resolve })) })
    const first = select()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect((await select('images')).status).toBe(409)
    finish(null)
    expect(await (await first).json()).toEqual({ canceled: true })
    picker.mockResolvedValueOnce([])
    expect((await select()).status).toBe(200)
  })

  it('선택 POST 연결이 끊기면 picker 신호를 취소하고 잠금을 해제한다', async () => {
    let signal
    await start({ pickPaths: vi.fn((kind, options) => new Promise((resolve, reject) => {
      signal = options.signal
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })) })
    const controller = new AbortController()
    const pending = select('folder', { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(signal).toBeDefined())
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    picker.mockResolvedValueOnce([])
    expect((await select()).status).toBe(200)
  })

  it('선택이 해제되면 파일 ID 권한을 즉시 잃고 다른 선택은 유지한다', async () => {
    await start()
    const first = await (await select()).json()
    const second = await (await select()).json()
    expect((await api(`/v1/selections/${first.selectionId}`, { method: 'DELETE' })).status).toBe(204)
    expect((await api(fileUrl(first))).status).toBe(404)
    expect((await api(fileUrl(second))).status).toBe(200)
  })

  it('10분 만료와 최대8개 선택 한도를 적용한다', async () => {
    await start()
    const selections = []
    for (let index = 0; index < 9; index++) selections.push(await (await select()).json())
    expect((await api(fileUrl(selections[0]))).status).toBe(404)
    expect((await api(fileUrl(selections[1]))).status).toBe(200)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000 + 1)
    expect((await api(fileUrl(selections[8]))).status).toBe(404)
  })
})

describe('선택 범위와 브라우저 요청 경계', () => {
  it('허용 Origin만 CORS 및 사설망 preflight를 제공한다', async () => {
    await start()
    const response = await api('/v1/select', { method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-local-gallery-token',
      'Access-Control-Request-Private-Network': 'true',
    } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('access-control-allow-private-network')).toBe('true')
    for (const origin of ['http://localhost:5173', ORIGIN]) expect((await api('/v1/status', { headers: { Origin: origin } })).status).toBe(200)
    for (const origin of ['https://evil.example', 'http://localhost:51730', 'http://127.0.0.1:5174', 'null']) {
      const denied = await api('/v1/status', { headers: { Origin: origin } })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('Origin·토큰이 없거나 잘못되면 파일/선택/해제를 허용하지 않는다', async () => {
    await start()
    const selection = await (await select()).json()
    expect((await fetch(base + fileUrl(selection), { headers: { 'X-Local-Gallery-Token': token } })).status).toBe(403)
    for (const route of ['/v1/select', fileUrl(selection), `/v1/selections/${selection.selectionId}`]) {
      const method = route === '/v1/select' ? 'POST' : route.startsWith('/v1/selections') ? 'DELETE' : 'GET'
      expect((await fetch(base + route, { method, headers: { Origin: ORIGIN } })).status).toBe(401)
      expect((await api(route, { method, headers: { 'X-Local-Gallery-Token': '0'.repeat(64) } })).status).toBe(401)
    }
    expect(picker).toHaveBeenCalledTimes(1)
  })

  it('외부 Host를 사용한 로컬 DNS rebinding 요청을 거절한다', async () => {
    await start()
    const status = await new Promise((resolve, reject) => {
      const request = http.get(base + '/v1/status', { headers: { Host: 'evil.example:' + server.address().port } }, response => { response.resume(); resolve(response.statusCode) })
      request.on('error', reject)
    })
    expect(status).toBe(403)
  })

  it('임의 경로·없는 ID·추가 선택 파라미터를 파일 접근권으로 인정하지 않는다', async () => {
    await start()
    const selection = await (await select()).json()
    expect((await api(`/v1/files/${selection.selectionId}/${'0'.repeat(32)}`)).status).toBe(404)
    expect((await api('/v1/files?path=' + encodeURIComponent(path.join(outside, 'secret.jpg')))).status).toBe(404)
    expect((await api('/v1/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'images', paths: [outside] }) })).status).toBe(400)
    expect((await select('unknown')).status).toBe(400)
    expect(picker).toHaveBeenCalledTimes(1)
  })

  it('folder 탐색에서 심볼릭 링크·junction의 외부 이미지를 건너뛴다', async ({ skip }) => {
    try { await symlink(outside, path.join(root, '외부 연결'), 'junction') } catch (error) { if (error.code === 'EPERM') { skip(); return } throw error }
    await start()
    const selection = await (await select()).json()
    expect(selection.files).toHaveLength(2)
    expect(selection.files.some(file => file.name === 'secret.jpg')).toBe(false)
  })

  it('선택 후 하위 폴더가 외부 junction으로 바뀌면 기존 ID로 읽지 못한다', async ({ skip }) => {
    await writeFile(path.join(outside, 'b.PNG'), 'outside replacement')
    await start()
    const selection = await (await select()).json()
    const file = selection.files.find(item => item.name === 'b.PNG')
    await rm(path.join(root, '하위 폴더'), { recursive: true })
    try { await symlink(outside, path.join(root, '하위 폴더'), 'junction') } catch (error) { if (error.code === 'EPERM') { skip(); return } throw error }
    expect((await api(fileUrl(selection, file))).status).toBe(403)
  })

  it('선택한 경로의 파일이 다른 파일로 교체되면 inode 검증으로 거절한다', async () => {
    await start()
    const selection = await (await select()).json()
    const file = selection.files.find(item => item.name === 'a.jpg')
    await rename(path.join(root, 'a.jpg'), path.join(root, 'original.jpg'))
    await writeFile(path.join(root, 'a.jpg'), 'unselected replacement')
    expect((await api(fileUrl(selection, file))).status).toBe(403)
  })
})

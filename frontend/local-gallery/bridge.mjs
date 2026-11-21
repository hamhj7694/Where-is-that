import http from 'node:http'
import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, realpath, readdir, open } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import console from 'node:console'

const { AbortController } = globalThis

const SERVICE = 'geugeo-eodi-local-gallery'
const ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])
const TTL = 10 * 60 * 1000
const MAX_SELECTIONS = 8
const IMAGE_TYPES = new Map(Object.entries({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
}))

function fail(status, message) { return Object.assign(new Error(message), { status }) }
function aborted(signal) { signal?.throwIfAborted() }
function opaqueId() { return randomBytes(16).toString('hex') }
function samePath(first, second) { return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second }
function within(root, file) {
  const relative = path.relative(root, file)
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

export function createNativePickerScript(kind) {
  const setup = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public static class GeugeoPickerNativeMethods {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'
$ownerHandle = [GeugeoPickerNativeMethods]::GetForegroundWindow()
$owner = $null
if ($ownerHandle -ne [IntPtr]::Zero) {
  $owner = New-Object System.Windows.Forms.NativeWindow
  $owner.AssignHandle($ownerHandle)
}
`
  const dialog = kind === 'folder' ? `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '검색할 사진이 있는 폴더를 선택해 주세요'
$dialog.ShowNewFolderButton = $false
try {
  $result = if ($owner) { $dialog.ShowDialog($owner) } else { $dialog.ShowDialog() }
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -Compress -InputObject @($dialog.SelectedPath) } else { 'null' }
} finally {
  $dialog.Dispose()
  if ($owner) { $owner.ReleaseHandle() }
}
` : `$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '연결할 사진을 선택해 주세요'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.Filter = '이미지 파일|*.jpg;*.jpeg;*.png;*.webp;*.gif;*.avif;*.bmp;*.heic;*.heif;*.tif;*.tiff'
try {
  $result = if ($owner) { $dialog.ShowDialog($owner) } else { $dialog.ShowDialog() }
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -Compress -InputObject @($dialog.FileNames) } else { 'null' }
} finally {
  $dialog.Dispose()
  if ($owner) { $owner.ReleaseHandle() }
}
`
  return setup + dialog
}

function nativePickPaths(kind, { signal }) {
  aborted(signal)
  const encoded = Buffer.from(createNativePickerScript(kind), 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', length = 0, done = false
    function finish(error, result) {
      if (done) return
      done = true
      signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(result)
    }
    function abort() { child.kill(); finish(signal.reason ?? fail(499, '선택을 취소했어요.')) }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      length += Buffer.byteLength(chunk)
      if (length > 8 * 1024 * 1024) { child.kill(); finish(fail(413, '선택한 항목이 너무 많아요. 폴더별로 연결해 주세요.')); return }
      output += chunk
    })
    child.stderr.resume()
    child.once('error', () => finish(fail(500, 'Windows 사진 선택기를 열지 못했어요.')))
    child.once('close', code => {
      if (done) return
      if (code !== 0) { finish(fail(500, 'Windows 사진 선택기를 완료하지 못했어요.')); return }
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim())
        if (result !== null && (!Array.isArray(result) || result.some(value => typeof value !== 'string'))) throw new Error('invalid selection')
        finish(null, result)
      } catch { finish(fail(500, '선택한 파일 정보를 읽지 못했어요.')) }
    })
    if (signal.aborted) abort()
  })
}

async function selectedFiles(kind, paths, signal) {
  const files = new Map()
  const seen = new Set()
  async function add(filePath, root, relativePath) {
    aborted(signal)
    const stat = await lstat(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) return
    const canonical = await realpath(filePath)
    if (!within(root, canonical)) throw fail(403, '선택한 폴더 밖의 파일은 읽을 수 없어요.')
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const type = IMAGE_TYPES.get(path.extname(canonical).toLowerCase())
    if (!type || seen.has(key)) return
    seen.add(key)
    const id = opaqueId()
    files.set(id, {
      id, name: path.basename(canonical), absolutePath: canonical, relativePath,
      size: stat.size, lastModified: Math.floor(stat.mtimeMs), type,
      root, dev: stat.dev, ino: stat.ino,
    })
  }
  if (kind === 'folder') {
    if (paths.length !== 1) throw fail(400, '폴더 한 개를 선택해 주세요.')
    const selected = path.resolve(paths[0])
    const stat = await lstat(selected)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail(400, '실제 사진 폴더를 선택해 주세요. 연결 폴더는 사용할 수 없어요.')
    const root = await realpath(selected)
    const rootName = path.basename(root) || path.parse(root).root.replace(/[\\/:]/g, '') || '선택 폴더'
    async function walk(directory) {
      aborted(signal)
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        aborted(signal)
        const full = path.join(directory, entry.name)
        const current = await lstat(full)
        if (current.isSymbolicLink()) continue
        const canonical = await realpath(full)
        if (!within(root, canonical)) throw fail(403, '선택한 폴더 밖의 항목은 읽을 수 없어요.')
        if (current.isDirectory()) await walk(canonical)
        else if (current.isFile()) await add(full, root, [rootName, path.relative(root, canonical).split(path.sep).join('/')].join('/'))
      }
    }
    await walk(root)
  } else {
    for (const filePath of paths) {
      aborted(signal)
      const selected = path.resolve(filePath)
      await add(selected, path.dirname(await realpath(selected)), '')
    }
  }
  aborted(signal)
  return files
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw fail(415, 'JSON 요청이 필요해요.')
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 1024) throw fail(413, '요청이 너무 커요.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(400, '요청 내용을 확인해 주세요.') }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** Local read-only server. pickPaths is injectable for HTTP boundary tests. */
export function createLocalGalleryServer({ pickPaths = nativePickPaths, platform = process.platform } = {}) {
  const token = randomBytes(32).toString('hex')
  const selections = new Map()
  let selecting = false
  let pickerController = null
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      const localPort = request.socket.localPort
      const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`])
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress) || !allowedHosts.has(request.headers.host)) throw fail(403, '로컬 연결만 허용해요.')
      const url = new URL(request.url, 'http://127.0.0.1')
      const origin = request.headers.origin
      if (origin && !ORIGINS.has(origin)) throw fail(403, '허용되지 않은 웹 주소예요.')
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin)
        response.setHeader('Vary', 'Origin')
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        json(response, 200, { service: SERVICE, version: 1, supported: platform === 'win32', token }); return
      }
      if (!origin) throw fail(403, '웹 앱에서 연결해 주세요.')
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method']
        const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean)
        if (!['GET', 'POST', 'DELETE'].includes(method) || headers.some(value => !['content-type', 'x-local-gallery-token'].includes(value))) throw fail(403, '허용되지 않은 요청이에요.')
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE')
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Local-Gallery-Token')
        if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true')
        response.writeHead(204); response.end(); return
      }
      const supplied = request.headers['x-local-gallery-token']
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw fail(401, '로컬 연결을 다시 확인해 주세요.')
      const now = Date.now()
      for (const [id, selection] of selections) if (now >= selection.expiresAt) selections.delete(id)

      if (request.method === 'POST' && url.pathname === '/v1/select') {
        if (platform !== 'win32') throw fail(501, '이 사진 선택기는 Windows에서 사용할 수 있어요.')
        const body = await readJson(request)
        if (!body || !['folder', 'images'].includes(body.kind) || Object.keys(body).some(key => key !== 'kind')) throw fail(400, '폴더 또는 사진 선택을 요청해 주세요.')
        if (selecting) throw fail(409, '이미 사진을 선택하고 있어요.')
        selecting = true
        const controller = new AbortController()
        pickerController = controller
        const cancel = () => { if (!response.writableEnded) controller.abort() }
        response.once('close', cancel)
        try {
          const paths = await pickPaths(body.kind, { signal: controller.signal })
          aborted(controller.signal)
          if (paths === null || Array.isArray(paths) && !paths.length) { json(response, 200, { canceled: true }); return }
          if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw fail(400, '선택한 항목의 전체 경로를 확인하지 못했어요.')
          const files = await selectedFiles(body.kind, paths, controller.signal)
          aborted(controller.signal)
          const selectionId = opaqueId()
          while (selections.size >= MAX_SELECTIONS) selections.delete(selections.keys().next().value)
          selections.set(selectionId, { files, expiresAt: Date.now() + TTL })
          json(response, 200, { selectionId, files: [...files.values()].map(({ id, name, absolutePath, relativePath, size, lastModified, type }) => ({ id, name, absolutePath, relativePath, size, lastModified, type })) })
        } finally {
          response.removeListener('close', cancel)
          if (pickerController === controller) pickerController = null
          selecting = false
        }
        return
      }
      const release = /^\/v1\/selections\/([a-f0-9]{32})$/.exec(url.pathname)
      if (request.method === 'DELETE' && release) {
        selections.delete(release[1]); response.writeHead(204); response.end(); return
      }
      const read = /^\/v1\/files\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(url.pathname)
      if (request.method === 'GET' && read) {
        const file = selections.get(read[1])?.files.get(read[2])
        if (!file) throw fail(404, '선택 정보가 만료됐어요. 사진을 다시 선택해 주세요.')
        const canonical = await realpath(file.absolutePath)
        if (!samePath(canonical, file.absolutePath) || !within(file.root, canonical)) throw fail(403, '선택 후 파일 위치가 변경되어 읽을 수 없어요.')
        const handle = await open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let transferred = false
        try {
          const stat = await handle.stat()
          const checked = await realpath(file.absolutePath)
          if (!stat.isFile() || stat.dev !== file.dev || stat.ino !== file.ino || !samePath(checked, file.absolutePath) || !within(file.root, checked)) throw fail(403, '선택 후 파일이 변경되어 읽을 수 없어요.')
          response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': stat.size })
          const stream = handle.createReadStream()
          transferred = true
          await pipeline(stream, response)
        } finally { if (!transferred) await handle.close() }
        return
      }
      throw fail(404, '요청한 항목이 없어요.')
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      if (response.headersSent) { response.destroy(); return }
      const status = error.status ?? (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP' ? 403 : 500)
      json(response, status, { error: error.status ? error.message : '사진을 읽지 못했어요. 다시 선택해 주세요.' })
    }
  })
  server.on('close', () => { pickerController?.abort(); selections.clear() })
  return server
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const port = Number(process.env.LOCAL_GALLERY_PORT ?? 5178)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LOCAL_GALLERY_PORT must be between 1 and 65535')
  const server = createLocalGalleryServer()
  server.on('error', error => { console.error('Local gallery bridge:', error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => console.log(`${SERVICE} listening on http://127.0.0.1:${port}`))
}

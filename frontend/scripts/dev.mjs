import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const port = '5178'
const apiPort = '8000'
const backendDir = fileURLToPath(new URL('../../backend', import.meta.url))
const venvPython = process.platform === 'win32'
  ? fileURLToPath(new URL('../../backend/.venv/Scripts/python.exe', import.meta.url))
  : fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url))
const apiCommand = existsSync(venvPython) ? venvPython : 'python'

async function galleryRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Origin: 'http://127.0.0.1:5179' }, signal: AbortSignal.timeout(800) })
    const status = await response.json()
    return status.service === 'geugeo-eodi-local-gallery' && status.version === 1
  } catch { return false }
}

async function authApiRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(800) })
    const status = await response.json()
    return status.service === 'geugeo-eodi-auth' && status.version === 1
  } catch { return false }
}

let bridge
let api
if (process.platform === 'win32' && !(await galleryRunning())) {
  bridge = spawn(process.execPath, [fileURLToPath(new URL('../local-gallery/bridge.mjs', import.meta.url))], { stdio: 'inherit', windowsHide: true, env: { ...process.env, LOCAL_GALLERY_PORT: port } })
}
if (!(await authApiRunning())) {
  api = spawn(apiCommand, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', apiPort], { cwd: backendDir, stdio: 'inherit', windowsHide: true })
}
let server
async function close() { await server?.close(); bridge?.kill(); api?.kill(); process.exit(0) }
process.once('SIGINT', close); process.once('SIGTERM', close)
try { server = await createServer({ server: { host: '127.0.0.1' } }); await server.listen(); server.printUrls() }
catch (error) { bridge?.kill(); api?.kill(); throw error }

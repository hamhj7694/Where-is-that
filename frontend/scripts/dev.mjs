import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const port = '5178'
let bridge
if (process.platform === 'win32') {
  let running = false
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Origin: 'http://127.0.0.1:5173' }, signal: AbortSignal.timeout(800) })
    const status = await response.json()
    running = status.service === 'geugeo-eodi-local-gallery' && status.version === 1
  } catch { /* Start the device-local bridge when absent. */ }
  if (!running) bridge = spawn(process.execPath, [fileURLToPath(new URL('../local-gallery/bridge.mjs', import.meta.url))], { stdio: 'inherit', windowsHide: true, env: { ...process.env, LOCAL_GALLERY_PORT: port } })
}
let server
async function close() { await server?.close(); bridge?.kill(); process.exit(0) }
process.once('SIGINT', close); process.once('SIGTERM', close)
try { server = await createServer({ server: { host: '127.0.0.1' } }); await server.listen(); server.printUrls() }
catch (error) { bridge?.kill(); throw error }

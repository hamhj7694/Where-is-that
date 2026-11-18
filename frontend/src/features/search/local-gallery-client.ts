import type { FileLocationAssignment } from './file-location-model'
import { isImageFile } from './model'

const BRIDGE = 'http://127.0.0.1:5178'
const SERVICE = 'geugeo-eodi-local-gallery'
const TOKEN_HEADER = 'X-Local-Gallery-Token'
const safeId = /^[A-Za-z0-9_-]{1,128}$/
export type LocalGalleryKind = 'folder' | 'images'
export interface LocalGalleryCapability { service: typeof SERVICE; version: 1; supported: boolean; token: string }
export interface LocalGalleryProgress { completed: number; total: number }
export interface LocalGallerySelection { files: File[]; locations: FileLocationAssignment[] }
interface FileDescriptor { id: string; name: string; absolutePath: string; relativePath: string; size: number; lastModified: number; type: string }

export class LocalGalleryUnavailableError extends Error {
  constructor() { super('로컬 사진 연결을 사용할 수 없어요. 브라우저의 사진·폴더 선택을 이용해 주세요.'); this.name = 'LocalGalleryUnavailableError' }
}
const invalidSelection = () => new Error('로컬 사진 정보를 확인하지 못했어요. 사진이나 폴더를 다시 선택해 주세요.')
const readFailure = () => new Error('로컬 사진을 모두 읽지 못했어요. 기존 연결은 유지돼요. 다시 선택해 주세요.')

export function localGalleryAllowed(development = import.meta.env.DEV, hostname = typeof window === 'undefined' ? '' : window.location.hostname): boolean {
  return development && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hasControls(value: string) { return Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159 }) }
function validSegment(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && !hasControls(value) && !/[<>:"|?*\\/]/.test(value) && !/[. ]$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) && value.toLowerCase() !== 'fakepath'
}

function validateDescriptor(value: unknown): FileDescriptor {
  if (!object(value) || typeof value.id !== 'string' || !safeId.test(value.id)
    || typeof value.name !== 'string' || !validSegment(value.name)
    || typeof value.absolutePath !== 'string' || typeof value.relativePath !== 'string'
    || !Number.isSafeInteger(value.size) || (value.size as number) <= 0
    || !Number.isSafeInteger(value.lastModified) || (value.lastModified as number) < 0
    || typeof value.type !== 'string' || hasControls(value.type)) throw invalidSelection()
  const descriptor = value as unknown as FileDescriptor
  const absolute = descriptor.absolutePath.replaceAll('\\', '/')
  let segments: string[]
  if (/^[A-Za-z]:\//.test(absolute)) segments = absolute.slice(3).split('/')
  else if (absolute.startsWith('//')) {
    segments = absolute.slice(2).split('/')
    if (segments.length < 3) throw invalidSelection()
  } else throw invalidSelection()
  if (segments.some(segment => !validSegment(segment)) || segments.at(-1)!.toLowerCase() !== descriptor.name.toLowerCase()) throw invalidSelection()
  if (descriptor.relativePath) {
    if (descriptor.relativePath.startsWith('/') || descriptor.relativePath.includes('\\')) throw invalidSelection()
    const relative = descriptor.relativePath.split('/')
    if (relative.some(segment => !validSegment(segment)) || relative.at(-1)!.toLowerCase() !== descriptor.name.toLowerCase()
      || !absolute.toLowerCase().endsWith('/' + descriptor.relativePath.toLowerCase())) throw invalidSelection()
  }
  if (!isImageFile({ name: descriptor.name, type: descriptor.type } as File)) throw invalidSelection()
  return descriptor
}

async function bridgeFetch(path: string, init: RequestInit = {}) {
  return fetch(BRIDGE + path, { cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'error', ...init })
}

/** Capability probing is confined to the local development app; failures enable fallback. */
export async function getLocalGalleryStatus(signal?: AbortSignal): Promise<LocalGalleryCapability | null> {
  if (!localGalleryAllowed()) return null
  signal?.throwIfAborted()
  try {
    const response = await bridgeFetch('/v1/status', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1200)]) : AbortSignal.timeout(1200) })
    if (!response.ok) return null
    const value: unknown = await response.json()
    signal?.throwIfAborted()
    if (!object(value) || value.service !== SERVICE || value.version !== 1 || typeof value.supported !== 'boolean'
      || typeof value.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.token)) return null
    return value as unknown as LocalGalleryCapability
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function releaseSelection(id: string, token: string) {
  try {
    // A canceled read must still release the bridge session. Do not reuse its signal.
    await bridgeFetch('/v1/selections/' + encodeURIComponent(id), { method: 'DELETE', headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(2000) })
  } catch { /* The helper also expires sessions; cleanup must not hide the original error. */ }
}

/** Read a whole explicit selection before exposing any File or absolute location. */
export async function pickLocalGallery(kind: LocalGalleryKind, signal: AbortSignal, onProgress?: (progress: LocalGalleryProgress) => void): Promise<LocalGallerySelection | null> {
  signal.throwIfAborted()
  const capability = await getLocalGalleryStatus(signal)
  if (!capability?.supported) throw new LocalGalleryUnavailableError()
  let selectionId: string | null = null
  let result: LocalGallerySelection
  try {
    const response = await bridgeFetch('/v1/select', { method: 'POST', headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: capability.token }, body: JSON.stringify({ kind }), signal })
    if (!response.ok) throw invalidSelection()
    const payload: unknown = await response.json()
    if (object(payload) && typeof payload.selectionId === 'string' && safeId.test(payload.selectionId)) selectionId = payload.selectionId
    signal.throwIfAborted()
    if (object(payload) && payload.canceled === true) return null
    if (!object(payload) || !selectionId || !Array.isArray(payload.files)) throw invalidSelection()
    if (!payload.files.length) throw new Error('선택한 항목에서 이미지를 찾지 못했어요. 다른 사진이나 폴더를 골라 주세요.')
    const descriptors = payload.files.map(validateDescriptor)
    if (new Set(descriptors.map(file => file.id)).size !== descriptors.length) throw invalidSelection()
    if (kind === 'folder' && descriptors.some(file => file.relativePath.split('/').length < 2)) throw invalidSelection()
    const files = new Array<File>(descriptors.length)
    const failed = new AbortController()
    const readSignal = AbortSignal.any([signal, failed.signal])
    let next = 0
    let completed = 0
    onProgress?.({ completed, total: descriptors.length })
    const read = async () => {
      while (next < descriptors.length) {
        readSignal.throwIfAborted()
        const index = next++
        const descriptor = descriptors[index]
        const bytes = await bridgeFetch('/v1/files/' + encodeURIComponent(selectionId!) + '/' + encodeURIComponent(descriptor.id), { headers: { [TOKEN_HEADER]: capability.token }, signal: readSignal })
        if (!bytes.ok) throw readFailure()
        const buffer = await bytes.arrayBuffer()
        readSignal.throwIfAborted()
        if (buffer.byteLength !== descriptor.size) throw readFailure()
        const file = new File([buffer], descriptor.name, { type: descriptor.type, lastModified: descriptor.lastModified })
        Object.defineProperty(file, 'webkitRelativePath', { value: descriptor.relativePath })
        files[index] = file
        completed++
        onProgress?.({ completed, total: descriptors.length })
      }
    }
    const workers = Array.from({ length: Math.min(4, descriptors.length) }, read)
    try { await Promise.all(workers) }
    catch (error) {
      failed.abort()
      await Promise.allSettled(workers)
      signal.throwIfAborted()
      if (error instanceof Error && error.message === readFailure().message) throw error
      throw readFailure()
    }
    signal.throwIfAborted()
    result = { files, locations: files.map((file, index) => ({ file, path: descriptors[index].absolutePath })) }
  } finally { if (selectionId) await releaseSelection(selectionId, capability.token) }
  signal.throwIfAborted()
  return result
}

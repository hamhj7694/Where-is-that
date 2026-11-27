import { useSyncExternalStore } from 'react'

export type BookmarkKind = 'gallery' | 'lost'

export interface BookmarkEntry {
  id: string
  kind: BookmarkKind
  title: string
  subtitle: string
  image: string | null
  path: string
  createdAt: number
}

export interface BookmarkView extends BookmarkEntry {
  pendingRemoval: boolean
}

export type NewBookmark = Omit<BookmarkEntry, 'createdAt'>

const STORAGE_KEY = 'geugeo-eodi:bookmarks'
const MAX_BOOKMARKS = 200
const EMPTY: BookmarkView[] = []

let cache: BookmarkEntry[] | null = null
let viewCache: BookmarkView[] | null = null
/** 해제를 누른 북마크는 저장소에서 빼되, 페이지를 떠나기 전까지 화면에 남겨 둔다. */
let pendingRemoved: BookmarkEntry[] = []
const listeners = new Set<() => void>()

function isEntry(value: unknown): value is BookmarkEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && (entry.kind === 'gallery' || entry.kind === 'lost')
    && typeof entry.title === 'string'
    && typeof entry.subtitle === 'string'
    && (entry.image === null || typeof entry.image === 'string')
    && typeof entry.path === 'string'
    && typeof entry.createdAt === 'number'
}

function read(): BookmarkEntry[] {
  if (cache) return cache
  if (typeof window === 'undefined') return EMPTY
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    cache = Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_BOOKMARKS) : []
  } catch {
    cache = []
  }
  return cache
}

function getView(): BookmarkView[] {
  if (viewCache) return viewCache
  const pendingIds = new Set(pendingRemoved.map(entry => entry.id))
  viewCache = [...pendingRemoved, ...read()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(entry => ({ ...entry, pendingRemoval: pendingIds.has(entry.id) }))
  return viewCache
}

function emit() { listeners.forEach(listener => listener()) }

function write(next: BookmarkEntry[]) {
  cache = next
  viewCache = null
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* Storage is optional. */ }
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return
    cache = null
    viewCache = null
    pendingRemoved = []
    emit()
  })
}

export function useBookmarks(): BookmarkView[] {
  return useSyncExternalStore(subscribe, getView, () => EMPTY)
}

export function useBookmark(id: string): boolean {
  const bookmarks = useBookmarks()
  return bookmarks.some(bookmark => bookmark.id === id && !bookmark.pendingRemoval)
}

/** 상세 페이지 경로만 북마크에 남긴다. */
export function bookmarkPath(path: string): string {
  const clean = path.replace(/\/transfer(?=$|\?)/, '')
  if (clean.startsWith('/gallery/photo/') || clean.startsWith('/lost-found/item/')) return clean
  return '/history'
}

export function currentDetailPath(): string {
  if (typeof window === 'undefined') return '/history'
  return bookmarkPath(window.location.pathname + window.location.search)
}

/** 사진 ID가 바뀌어도 이름으로 원본을 찾을 수 있게 링크에 파일명을 담는다. */
export function bookmarkLink(path: string, kind: BookmarkKind, title: string): string {
  if (kind !== 'gallery') return path
  const [pathname, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  if (!params.has('photo')) params.set('photo', title)
  const next = params.toString()
  return pathname + (next ? '?' + next : '')
}

export function toggleBookmark(entry: NewBookmark) {
  const path = bookmarkPath(entry.path)
  const restored = pendingRemoved.find(bookmark => bookmark.id === entry.id)
  if (restored) {
    pendingRemoved = pendingRemoved.filter(bookmark => bookmark.id !== entry.id)
    write([restored, ...read()].slice(0, MAX_BOOKMARKS))
    return
  }
  const current = read()
  if (current.some(bookmark => bookmark.id === entry.id)) {
    write(current.filter(bookmark => bookmark.id !== entry.id))
    return
  }
  write([{ ...entry, path, createdAt: Date.now() }, ...current].slice(0, MAX_BOOKMARKS))
}

/** 확인을 누른 뒤 호출한다. 저장소에서는 즉시 빼지만 화면에는 되돌릴 수 있게 남긴다. */
export function requestBookmarkRemoval(id: string) {
  const current = read()
  const entry = current.find(bookmark => bookmark.id === id)
  if (!entry) return
  pendingRemoved = [...pendingRemoved.filter(bookmark => bookmark.id !== id), entry]
  write(current.filter(bookmark => bookmark.id !== id))
}

export function restoreBookmark(id: string) {
  const entry = pendingRemoved.find(bookmark => bookmark.id === id)
  if (!entry) return
  pendingRemoved = pendingRemoved.filter(bookmark => bookmark.id !== id)
  write([entry, ...read()].slice(0, MAX_BOOKMARKS))
}

/** 페이지를 이동할 때 남아 있던 해제 예정 북마크를 정리한다. */
export function flushPendingBookmarks() {
  if (!pendingRemoved.length) return
  pendingRemoved = []
  viewCache = null
  emit()
}

/** 새로고침 후에도 미리보기가 유지되도록 blob 사진은 작은 썸네일로 바꾼다. */
export function createThumbnail(source: string | null | undefined): Promise<string | null> {
  if (!source) return Promise.resolve(null)
  if (!source.startsWith('blob:')) return Promise.resolve(source)
  return new Promise(resolve => {
    const image = new Image()
    image.onload = () => {
      try {
        const scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.72))
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = source
  })
}

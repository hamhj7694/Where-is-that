import { localPhotoId, rememberLocalPhotoId } from '../workspace/data'
import type { SearchRecord } from './history'
import type { SearchDraft } from './model'

const DB_NAME = 'geugeo-eodi-guest-history'
const RECORDS = 'records'
const PHOTOS = 'photos'

interface StoredPhoto { id: string; file: File; path: string }
interface StoredRecord extends Omit<SearchRecord, 'draft' | 'gallery'> {
  draft: Omit<SearchDraft, 'photo' | 'photos'> & { photoId: string | null; photoIds?: string[] }
  gallery: { name: string; photoIds: string[] } | null
}

function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECORDS, { keyPath: 'id' })
      request.result.createObjectStore(PHOTOS, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function pack(record: SearchRecord, collect: (photo: File) => string): StoredRecord {
  const { photo, photos, ...draft } = record.draft
  return {
    ...record,
    draft: { ...draft, photoId: photo ? collect(photo) : null, photoIds: photos?.map(collect) },
    gallery: record.gallery ? { name: record.gallery.name, photoIds: record.gallery.files.map(collect) } : null,
  }
}

function unpack(record: StoredRecord, photos: ReadonlyMap<string, File>): SearchRecord {
  const { photoId, photoIds, ...draft } = record.draft
  const files = (ids: string[]) => ids.flatMap(id => photos.get(id) ?? [])
  return {
    ...record,
    draft: { ...draft, photo: photoId ? photos.get(photoId) ?? null : null, photos: photoIds && files(photoIds) },
    gallery: record.gallery ? { name: record.gallery.name, files: files(record.gallery.photoIds) } : null,
  }
}

export async function loadGuestHistory(): Promise<SearchRecord[]> {
  const database = await openHistory()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([RECORDS, PHOTOS], 'readonly')
      const entries = transaction.objectStore(RECORDS).getAll()
      const assets = transaction.objectStore(PHOTOS).getAll()
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => {
        try {
          const photos = new Map<string, File>()
          for (const { file, id, path } of assets.result as StoredPhoto[]) {
            if (path) Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
            rememberLocalPhotoId(file, id)
            photos.set(id, file)
          }
          resolve((entries.result as StoredRecord[]).map(entry => unpack(entry, photos))
            .sort((a, b) => b.createdAt - a.createdAt))
        } catch (error) { reject(error) }
      }
    })
  } finally {
    database.close()
  }
}

export async function saveGuestHistory(previous: readonly SearchRecord[], next: readonly SearchRecord[]) {
  const originals = new Map(previous.map(record => [record.id, record]))
  const present = new Set(next.map(record => record.id))
  const removed = previous.filter(record => !present.has(record.id))
  const assets = new Map<string, StoredPhoto>()
  const collect = (file: File) => {
    const id = localPhotoId(file)
    assets.set(id, { id, file, path: file.webkitRelativePath || '' })
    return id
  }
  const changed = next.filter(record => originals.get(record.id) !== record).map(record => pack(record, collect))
  if (!removed.length && !changed.length) return

  const database = await openHistory()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([RECORDS, PHOTOS], 'readwrite')
      const records = transaction.objectStore(RECORDS)
      const photos = transaction.objectStore(PHOTOS)
      const keys = photos.getAllKeys()
      keys.onsuccess = () => {
        const existing = new Set(keys.result)
        for (const [id, asset] of assets) if (!existing.has(id)) photos.put(asset)
      }
      for (const record of changed) records.put(record)
      for (const { id } of removed) records.delete(id)
      if (removed.length || changed.some(record => originals.has(record.id))) {
        const remaining = records.getAll()
        remaining.onsuccess = () => {
          const retained = new Set<string>()
          for (const record of remaining.result as StoredRecord[]) {
            if (record.draft.photoId) retained.add(record.draft.photoId)
            for (const id of record.draft.photoIds ?? []) retained.add(id)
            for (const id of record.gallery?.photoIds ?? []) retained.add(id)
          }
          const allAssets = photos.getAllKeys()
          allAssets.onsuccess = () => {
            for (const id of allAssets.result) if (typeof id === 'string' && !retained.has(id)) photos.delete(id)
          }
        }
      }
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve()
    })
  } finally {
    database.close()
  }
}

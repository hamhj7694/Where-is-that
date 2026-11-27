import { localPhotoId, rememberLocalPhotoId } from '../workspace/data'
import type { GallerySource } from './model'

const DB_NAME = 'geugeo-eodi'
const STORE = 'gallery'
const KEY = 'current'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode)
      const request = action(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => database.close()
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    })
  } catch (error) {
    database.close()
    throw error
  }
}

/** File 복제 시 사라지는 브라우저 상대경로와 북마크가 가리키는 사진 ID를 따로 보관한다. */
interface StoredGallery extends GallerySource { paths?: string[]; ids?: string[] }

/** 연결한 갤러리의 File 목록을 브라우저에 보관해 새로고침 후에도 복원한다. */
export async function loadGallery(): Promise<GallerySource | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const value = await run<StoredGallery | undefined>('readonly', store => store.get(KEY))
    if (!value?.files?.length) return null
    value.files.forEach((file, index) => {
      const path = value.paths?.[index]
      if (path) Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
      const id = value.ids?.[index]
      if (id) rememberLocalPhotoId(file, id)
    })
    return { name: value.name, files: value.files }
  } catch { return null }
}

export async function saveGallery(gallery: GallerySource | null): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    if (!gallery) { await run('readwrite', store => store.delete(KEY)); return }
    const paths = gallery.files.map(file => file.webkitRelativePath || '')
    const ids = gallery.files.map(file => localPhotoId(file))
    await run('readwrite', store => store.put({ name: gallery.name, files: gallery.files, paths, ids }, KEY))
  } catch { /* Storage is optional; in-memory gallery still works. */ }
}

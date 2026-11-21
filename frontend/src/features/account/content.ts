import type { GalleryAssistantState } from '../search/gallery-search-model'
import { getReferencePhotos, getReferencePhotoViews, type ReferencePhotoView } from '../search/model'
import type { SearchRecord } from '../search/history'
import { initialValuables, type AppPhoto, type Valuable } from '../workspace/data'

export const ACCOUNT_DELETE_CONFIRMATION = '계정을 탈퇴합니다'

export interface WireImage {
  name: string
  dataUrl: string
}

export interface WirePhoto {
  id: string
  name: string
  dataUrl: string | null
  sampleUrl: string | null
  kind: 'photo' | 'screenshot'
  photoView?: ReferencePhotoView
  path?: string
  updatedAt?: number
}

export interface WireValuable {
  id: string
  name: string
  notes: string
  category: string
  status: Valuable['status']
  photos: WirePhoto[]
  createdAt?: number
  viewedAt?: number
  updatedAt: number
}

export interface WireDraft {
  query: string
  photoDataUrl: string | null
  photoName: string
  photos: WireImage[]
  photoViews: ReferencePhotoView[]
}

export interface WireRecord {
  id: string
  mode: SearchRecord['mode']
  createdAt: number
  draft: WireDraft
  gallery: { name: string; files: WireImage[] } | null
  assistant?: GalleryAssistantState
  parentRecordId?: string
  assistantBaseQuery?: string
}

export interface AccountContent {
  valuables: WireValuable[]
  records: WireRecord[]
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('파일을 읽지 못했어요.'))
    reader.readAsDataURL(file)
  })
}

export function dataUrlToFile(dataUrl: string, name: string): File {
  const separator = dataUrl.indexOf(',')
  if (separator < 0 || !dataUrl.startsWith('data:')) throw new Error('이미지 정보가 올바르지 않아요.')
  const mime = /^data:([^;]+);base64$/.exec(dataUrl.slice(0, separator))?.[1] ?? 'application/octet-stream'
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const binary = atob(dataUrl.slice(separator + 1))
    bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  } catch {
    throw new Error('이미지 정보가 올바르지 않아요.')
  }
  return new File([bytes], name || 'photo.jpg', { type: mime })
}

export function isInitialValuable(item: Valuable): boolean {
  return initialValuables.some(sample =>
    sample.id === item.id && sample.updatedAt === item.updatedAt && sample.name === item.name,
  )
}

export function mergeContent(account: AccountContent, local: AccountContent): AccountContent {
  const merge = <T extends { id: string }>(saved: T[], pending: T[]): T[] => {
    const ids = new Set(saved.map(value => value.id))
    return [...pending.filter(value => !ids.has(value.id)), ...saved]
  }
  return {
    valuables: merge(account.valuables, local.valuables),
    records: merge(account.records, local.records),
  }
}

async function imageToWire(file: File): Promise<WireImage> {
  return { name: file.name || 'photo.jpg', dataUrl: await fileToDataUrl(file) }
}

async function photoToWire(photo: AppPhoto): Promise<WirePhoto> {
  const { file, ...rest } = photo
  return { ...rest, dataUrl: file ? await fileToDataUrl(file) : null }
}

function photoFromWire(wire: WirePhoto): AppPhoto {
  const { dataUrl, ...rest } = wire
  return { ...rest, file: dataUrl ? dataUrlToFile(dataUrl, wire.name) : null }
}

async function draftToWire(draft: SearchRecord['draft']): Promise<WireDraft> {
  const photos = await Promise.all(getReferencePhotos(draft).map(imageToWire))
  return {
    query: draft.query,
    photoDataUrl: photos[0]?.dataUrl ?? null,
    photoName: photos[0]?.name ?? '',
    photos,
    photoViews: getReferencePhotoViews(draft),
  }
}

function draftFromWire(wire: WireDraft): SearchRecord['draft'] {
  const files = wire.photos?.length
    ? wire.photos
    : wire.photoDataUrl ? [{ name: wire.photoName, dataUrl: wire.photoDataUrl }] : []
  const photos = files.map(image => dataUrlToFile(image.dataUrl, image.name))
  if (!photos.length) return { query: wire.query, photo: null }
  return {
    query: wire.query,
    photo: photos[0] ?? null,
    photos,
    photoViews: wire.photoViews?.map(value => value ?? 'unspecified') ?? photos.map(() => 'unspecified'),
  }
}

export async function serializeValuable(item: Valuable): Promise<WireValuable> {
  return { ...item, photos: await Promise.all(item.photos.map(photoToWire)) }
}

export function deserializeValuable(wire: WireValuable): Valuable {
  return { ...wire, photos: (wire.photos ?? []).map(photoFromWire) }
}

export async function serializeRecord(record: SearchRecord): Promise<WireRecord> {
  return {
    id: record.id,
    mode: record.mode,
    createdAt: record.createdAt,
    draft: await draftToWire(record.draft),
    gallery: record.gallery
      ? {
          name: record.gallery.name,
          files: await Promise.all(record.gallery.files.map(imageToWire)),
        }
      : null,
    ...(record.assistant ? { assistant: record.assistant } : {}),
    ...(record.parentRecordId ? { parentRecordId: record.parentRecordId } : {}),
    ...(record.assistantBaseQuery !== undefined ? { assistantBaseQuery: record.assistantBaseQuery } : {}),
  }
}

export function deserializeRecord(wire: WireRecord): SearchRecord {
  return {
    id: wire.id,
    mode: wire.mode,
    createdAt: wire.createdAt,
    draft: draftFromWire(wire.draft),
    gallery: wire.gallery
      ? { name: wire.gallery.name, files: (wire.gallery.files ?? []).map(image => dataUrlToFile(image.dataUrl, image.name)) }
      : null,
    ...(wire.assistant ? { assistant: wire.assistant } : {}),
    ...(wire.parentRecordId ? { parentRecordId: wire.parentRecordId } : {}),
    ...(wire.assistantBaseQuery !== undefined ? { assistantBaseQuery: wire.assistantBaseQuery } : {}),
  }
}

export async function serializeContent(items: readonly Valuable[], records: readonly SearchRecord[]): Promise<AccountContent> {
  return {
    valuables: await Promise.all(items.map(serializeValuable)),
    records: await Promise.all(records.map(serializeRecord)),
  }
}

export function deserializeContent(content: AccountContent): { items: Valuable[]; records: SearchRecord[] } {
  return {
    items: (content.valuables ?? []).map(deserializeValuable),
    records: (content.records ?? []).map(deserializeRecord),
  }
}

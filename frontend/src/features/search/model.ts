export type SearchMode = 'gallery' | 'lost'
export type ReferencePhotoView = 'unspecified' | 'front' | 'back' | 'side' | 'top' | 'bottom' | 'diagonal'
export const REFERENCE_PHOTO_VIEWS: readonly { value: ReferencePhotoView; label: string }[] = [
  { value: 'unspecified', label: '미지정' },
  { value: 'front', label: '정면(앞)' },
  { value: 'back', label: '뒤' },
  { value: 'side', label: '옆' },
  { value: 'top', label: '위' },
  { value: 'bottom', label: '아래' },
  { value: 'diagonal', label: '대각선' },
]
export interface SearchDraft {
  query: string
  photo: File | null
  photos?: File[]
  photoViews?: ReferencePhotoView[]
}
export const MAX_LOST_REFERENCE_PHOTOS = 6
export interface GallerySource { name: string; files: File[] }
export interface SearchPreview {
  mode: SearchMode
  query: string
  photo: File | null
  photos?: File[]
  photoViews?: ReferencePhotoView[]
  gallery: { name: string; count: number } | null
  channels: readonly ('image' | 'context' | 'gallery')[]
}

export function validateSearch(mode: SearchMode, draft: SearchDraft, gallery: GallerySource | null) {
  const photos = mode === 'lost' ? getReferencePhotos(draft) : draft.photo ? [draft.photo] : []
  if (mode === 'lost' && photos.length > MAX_LOST_REFERENCE_PHOTOS) return 'too-many-photos' as const
  if (!draft.query.trim() && !photos.length) return 'empty' as const
  if (mode === 'gallery' && !gallery?.files.length) return 'gallery' as const
  return null
}

export function createSearchPreview(mode: SearchMode, draft: SearchDraft, gallery: GallerySource | null): SearchPreview {
  const snapshot = snapshotSearchDraft(mode, draft)
  return {
    mode, ...snapshot,
    gallery: mode === 'gallery' && gallery ? { name: gallery.name, count: gallery.files.length } : null,
    channels: mode === 'lost' ? ['image', 'context'] : ['gallery'],
  }
}

/** An explicitly present empty list means the user removed every reference. */
export function getReferencePhotos(draft: SearchDraft): File[] {
  return draft.photos ?? (draft.photo ? [draft.photo] : [])
}

/** View labels are manual metadata, never inferred from the image contents. */
export function getReferencePhotoViews(draft: SearchDraft): ReferencePhotoView[] {
  return getReferencePhotos(draft).map((_, index) => {
    const value = draft.photoViews?.[index]
    return value && REFERENCE_PHOTO_VIEWS.some(option => option.value === value) ? value : 'unspecified'
  })
}

/** Keep file identities, while isolating the selected list from later edits. */
export function snapshotSearchDraft(mode: SearchMode, draft: SearchDraft): SearchDraft {
  const query = draft.query.trim()
  if (mode === 'gallery') return { query, photo: draft.photo }
  const photos = [...getReferencePhotos(draft)]
  return { query, photo: photos[0] ?? null, photos, photoViews: getReferencePhotoViews(draft) }
}

export function isImageFile(file: File) {
  return file.type.startsWith('image/') || (!file.type && /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(file.name))
}

export function collectGallery(files: readonly File[]): GallerySource | null {
  // webkitdirectory supplies a flat FileList for the complete directory tree.
  // Keep every image at every depth; UI preview limits never reduce this corpus.
  const images = files.filter(isImageFile)
  if (!images.length) return null
  const path = images[0].webkitRelativePath
  return { name: path ? path.split('/')[0] : '선택한 이미지', files: images }
}

export function appendGallery(gallery: GallerySource | null, files: readonly File[]): GallerySource | null {
  const addition = collectGallery(files)
  if (!addition) return gallery
  if (!gallery) return addition
  return {
    name: gallery.name === addition.name ? gallery.name : '여러 위치의 이미지',
    files: [...gallery.files, ...addition.files],
  }
}

export function canSubmitWithEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function assertImageReadable(file: File) {
  if (!isImageFile(file)) throw new Error('이 사진 형식은 사용할 수 없어요. 지원하는 형식의 사진을 선택해 주세요.')
  const url = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('사진을 읽지 못했어요. 파일을 확인하거나 다른 사진을 선택해 주세요.'))
      image.src = url
    })
  } finally { URL.revokeObjectURL(url) }
}

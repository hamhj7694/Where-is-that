import type { GalleryRankMap } from './gallery-search-model'

const BATCH_SIZE = 16
const THUMBNAIL_SIZE = 448

export interface GalleryRankCandidate {
  id: string
  file: File
}

async function makeThumbnail(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('사진을 준비하지 못했어요.')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.86)
  } finally {
    bitmap.close()
  }
}

async function requestGalleryModel(path: string, input: object, signal: AbortSignal): Promise<unknown> {
  const response = await fetch('/api/ai/vision/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (response.ok) return body
  const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : ''
  throw new Error(message || '이 기기의 사진 분석에 연결하지 못했어요.')
}

export async function rankConnectedGallery(
  query: string,
  reference: File | null,
  candidates: readonly GalleryRankCandidate[],
  signal: AbortSignal,
  onProgress: (checked: number) => void,
): Promise<GalleryRankMap> {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) {
    throw new Error('갤러리 검색은 이 기기의 로컬 주소에서 열어 주세요.')
  }
  signal.throwIfAborted()
  const text = query.trim().slice(0, 1600)
  const [intent, referenceThumbnail] = await Promise.all([
    text ? requestGalleryModel('gallery-intent', { query: text }, signal) : null,
    reference ? makeThumbnail(reference).catch(() => {
      throw new Error('참고 사진을 읽지 못했어요. 다른 사진을 선택해 주세요.')
    }) : null,
  ])
  const queryPrompt = intent && typeof intent === 'object' && 'prompt' in intent && typeof intent.prompt === 'string'
    ? intent.prompt : text.slice(0, 160)
  const ranking: GalleryRankMap = {}

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE)
    const images: { id: string; image: string }[] = []
    for (const { id, file } of batch) {
      signal.throwIfAborted()
      try {
        images.push({ id, image: await makeThumbnail(file) })
      } catch {
        // A damaged or unsupported file does not prevent checking the rest of the gallery.
      }
    }
    if (images.length) {
      const body = await requestGalleryModel('gallery-local', { queryPrompt, reference: referenceThumbnail, candidates: images }, signal)
      if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
        throw new Error('사진 분석 결과를 읽지 못했어요.')
      }
      const ids = new Set(images.map(image => image.id))
      for (const item of body.results) {
        if (!item || !ids.has(item.id) || ![item.score, item.imageSimilarity, item.contextRelevance].every(Number.isFinite)) continue
        ranking[item.id] = {
          score: item.score,
          imageSimilarity: item.imageSimilarity,
          contextRelevance: item.contextRelevance,
        }
      }
    }
    onProgress(offset + batch.length)
  }
  return ranking
}

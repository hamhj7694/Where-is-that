import { fetchLostPhotoFingerprints, normalizeLostImage } from './lostfound-api'

const PHOTO_BATCH_SIZE = 16
const CACHE_LIMIT = 4096
const cache = new Map<string, string>()

export async function checkLostPhotos(
  images: readonly (string | null)[],
  signal?: AbortSignal,
  onBatch?: (batch: ReadonlyMap<string, string>) => void,
): Promise<ReadonlyMap<string, string>> {
  signal?.throwIfAborted()
  const urls = [...new Set(images.map(normalizeLostImage).filter(Boolean))]
  const fingerprints = new Map<string, string>()
  const pending = urls.filter(url => {
    const fingerprint = cache.get(url)
    if (!fingerprint) return true
    fingerprints.set(url, fingerprint)
    return false
  })
  if (fingerprints.size) onBatch?.(new Map(fingerprints))

  for (let start = 0; start < pending.length; start += PHOTO_BATCH_SIZE) {
    signal?.throwIfAborted()
    const batch = pending.slice(start, start + PHOTO_BATCH_SIZE)
    const timeout = AbortSignal.timeout(20_000)
    try {
      const values = await fetchLostPhotoFingerprints(batch, signal ? AbortSignal.any([signal, timeout]) : timeout)
      signal?.throwIfAborted()
      const checked = new Map<string, string>()
      for (const url of batch) {
        const fingerprint = values?.[url]
        if (typeof fingerprint !== 'string' || !/^(pixels|file):[a-f0-9]{64}$/.test(fingerprint)) continue
        cache.set(url, fingerprint)
        fingerprints.set(url, fingerprint)
        checked.set(url, fingerprint)
      }
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      if (checked.size) onBatch?.(checked)
    } catch {
      signal?.throwIfAborted()
      break
    }
  }

  return fingerprints
}

/** Keep the first ranked record for each photo. Separate records without a photo still count separately. */
export function uniqueLostPhotos<T>(
  items: readonly T[],
  imageOf: (item: T) => string | null,
  fingerprints: ReadonlyMap<string, string>,
): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const url = normalizeLostImage(imageOf(item))
    if (!url) return true
    const key = fingerprints.get(url) ?? url
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

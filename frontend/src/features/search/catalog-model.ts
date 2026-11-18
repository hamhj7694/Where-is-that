import { MAX_LOST_REFERENCE_PHOTOS, type ReferencePhotoView } from './model'

export type ResultChannel = 'image' | 'context'
export type PhotoStatus = 'verified_photo' | 'no_photo' | 'invalid'
export type LocationStatus = 'verified' | 'address_only' | 'ambiguous' | 'missing' | 'provider_error'

export interface CandidateLocation {
  status: LocationStatus
  address: string | null
  latitude?: number
  longitude?: number
}

export interface Candidate {
  id: string
  title: string
  image: string | null
  photoStatus: PhotoStatus
  photoView?: ReferencePhotoView
  category: string
  color: string
  description: string
  foundAt: string | null
  foundPlace: string | null
  custodyName: string | null
  officialUrl: string | null
  matchReasons: string[]
  location: CandidateLocation
}

export interface ResultSummary { image: Candidate[]; context: Candidate[] }

/** Summary-only projection; the full channel sources and their ranking stay intact. */
export function selectSummary(image: readonly Candidate[], context: readonly Candidate[], limit = 5): ResultSummary {
  const size = Number.isFinite(limit) ? Math.max(0, Math.min(5, Math.floor(limit))) : 5
  const imageIds = new Set<string>()
  const imageSummary: Candidate[] = []
  for (const candidate of image) {
    if (imageSummary.length >= size) break
    if (candidate.photoStatus !== 'verified_photo' || !candidate.image?.trim() || imageIds.has(candidate.id)) continue
    imageSummary.push(candidate)
    imageIds.add(candidate.id)
  }

  const contextIds = new Set<string>()
  const contextSummary: Candidate[] = []
  for (const candidate of context) {
    if (contextSummary.length >= size) break
    if (imageIds.has(candidate.id) || contextIds.has(candidate.id)) continue
    contextSummary.push(candidate)
    contextIds.add(candidate.id)
  }
  return { image: imageSummary, context: contextSummary }
}

/** Coordinates alone never establish that a custody institution is verified. */
export function canShowMap(location: CandidateLocation): boolean {
  return location.status === 'verified'
    && !!location.address?.trim()
    && typeof location.latitude === 'number'
    && Number.isFinite(location.latitude)
    && location.latitude >= -90 && location.latitude <= 90
    && typeof location.longitude === 'number'
    && Number.isFinite(location.longitude)
    && location.longitude >= -180 && location.longitude <= 180
}

export type StorageState = 'idle' | 'saving' | 'saved' | 'failed'
export interface RegistrationProgress { originals: StorageState; vectors: StorageState }

export function registrationComplete(progress: RegistrationProgress): boolean {
  return progress.originals === 'saved' && progress.vectors === 'saved'
}

/** A selection is not a transfer authorization; cancellation produces no payload. */
export function transferPayload(photoId: string, confirmed: boolean): string | null {
  return transferPayloads([photoId], confirmed)?.[0] ?? null
}

/** Multiple selected photos are transferred only after explicit confirmation. */
export function transferPayloads(photoIds: readonly string[], confirmed: boolean): string[] | null {
  if (!confirmed) return null
  const ids = [...new Set(photoIds.map(photoId => photoId.trim()).filter(Boolean))]
  return ids.length && ids.length <= MAX_LOST_REFERENCE_PHOTOS ? ids : null
}

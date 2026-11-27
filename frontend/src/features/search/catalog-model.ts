import { MAX_LOST_REFERENCE_PHOTOS, type ReferencePhotoView } from './model'

type PhotoStatus = 'verified_photo' | 'no_photo' | 'invalid'
type LocationStatus = 'verified' | 'address_only' | 'ambiguous' | 'missing' | 'provider_error'

export interface CandidateLocation {
  status: LocationStatus
  address: string | null
  latitude?: number
  longitude?: number
}

/** 카카오 Local API가 준 보관기관 장소 정보. 영업시간 필드는 제공되지 않는다. */
export interface PlaceInfo {
  name: string
  phone: string
  address: string
  roadAddress: string
  category: string
  placeUrl: string | null
  openingHours: string | null
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
  /** 실제 공개 API 상세의 습득 시각(fdHor). 공개값을 그대로 표시한다. */
  foundTime?: string | null
  foundPlace: string | null
  custodyName: string | null
  /** 실제 공개 API 상세의 보관상태(csteSteNm). */
  custodyStatus?: string | null
  officialUrl: string | null
  matchReasons: string[]
  /** 직접 찾기: 어떤 신호가 맞았는지 등급과 표시 문구. */
  matchTier?: number
  matchLabel?: string
  /** AI가 공개 사진을 직접 보고 매긴 점수. */
  visualScore?: number | null
  rankingScore?: number | null
  location: CandidateLocation
  /** 실제 공개 API 상세에서 받은 보관기관 연락처. */
  tel?: string | null
  /** 서버 지오코딩으로 만든 카카오맵 링크. */
  mapUrl?: string | null
  /** 실제 공개 API 식별자(샘플 후보에는 없음). */
  source?: string
  atcId?: string
  fdSn?: string
  /** 검색 API에 지역 필드가 없어 보관기관 위치에서 유추한 시도(실 API 후보에만 있음). */
  region?: string | null
  /** 상세에서 받은 카카오 장소 정보(이름·전화·주소·분류). */
  place?: PlaceInfo | null
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

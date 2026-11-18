import type { Candidate } from '../search/catalog-model'
import type { ReferencePhotoView } from '../search/model'

export interface AppPhoto {
  id: string
  name: string
  file: File | null
  sampleUrl: string | null
  kind: 'photo' | 'screenshot'
  photoView?: ReferencePhotoView
  path?: string
  updatedAt?: number
}

export const OFFICIAL_SEARCH_URL = 'https://minwon24.police.go.kr/cvlcpt/cvlcptGdInfo.do?cvlcptId=MW-201'

export type ValuableStatus = 'kept' | 'lost' | 'found'
export const valuableStatusLabels: Record<ValuableStatus, string> = { kept: '보관 중', lost: '분실', found: '찾음' }
export interface Valuable {
  id: string
  name: string
  notes: string
  category: string
  status: ValuableStatus
  photos: AppPhoto[]
  /** Registration time for the valuables list; optional for older in-memory records. */
  createdAt?: number
  /** Last time the item detail was opened in this browser session. */
  viewedAt?: number
  updatedAt: number
}

export function isDeleteConfirmation(value: string) {
  return value === '삭제'
}

export const samplePhotos: AppPhoto[] = [
  { id: 'sample-coast', name: '바닷가에서', file: null, sampleUrl: '/images/coast.jpg', kind: 'photo' },
  { id: 'sample-wallet', name: '검정 지갑', file: null, sampleUrl: '/images/wallet.jpg', kind: 'photo' },
  { id: 'sample-schedule', name: '주간 일정표', file: null, sampleUrl: null, kind: 'screenshot' },
  { id: 'sample-keys', name: '열쇠고리', file: null, sampleUrl: '/images/detail.jpg', kind: 'photo' },
  { id: 'sample-card', name: '작은 지갑', file: null, sampleUrl: '/images/card.jpg', kind: 'photo' },
  { id: 'sample-bag', name: '노란 가방', file: null, sampleUrl: '/images/bag.jpg', kind: 'photo' },
  { id: 'sample-screen', name: '업무 메모', file: null, sampleUrl: null, kind: 'screenshot' },
]

const records = [
  ['01', '검정 가죽 지갑', '지갑', '검정', '/images/wallet.jpg'],
  ['02', '작은 카드 지갑', '지갑', '남색', '/images/card.jpg'],
  ['03', '노란 가방', '가방', '노랑', '/images/bag.jpg'],
  ['04', '열쇠고리', '열쇠', '은색', '/images/detail.jpg'],
  ['05', '검정 반지갑', '지갑', '검정', '/images/wallet.jpg'],
  ['06', '가죽 카드 지갑', '지갑', '남색', '/images/card.jpg'],
  ['07', '작은 열쇠 묶음', '열쇠', '은색', '/images/detail.jpg'],
  ['08', '검정 지갑', '지갑', '검정', null],
  ['09', '노란 천 가방', '가방', '노랑', null],
  ['10', '카드가 든 지갑', '지갑', '검정', null],
  ['11', '금속 열쇠고리', '열쇠', '은색', null],
  ['12', '작은 가죽 지갑', '지갑', '남색', null],
] as const

// Explicit fictional fixture metadata; these labels were not inferred from photos.
const sampleCandidateViews: Record<string, ReferencePhotoView> = {
  '01': 'front', '02': 'back', '03': 'side', '04': 'top',
  '05': 'bottom', '06': 'diagonal', '07': 'unspecified',
}

/** Fictional UI fixtures, never official police records or actual search output. */
export const sampleCandidates: Candidate[] = records.map(([id, title, category, color, image], index) => ({
  id: 'demo-' + id, title, category, color, image,
  photoStatus: image ? 'verified_photo' : 'no_photo',
  ...(image ? { photoView: sampleCandidateViews[id] ?? 'unspecified' } : {}),
  description: category === '지갑' ? '카드 수납 공간이 있는 지갑' : category === '가방' ? '인쇄된 무늬가 있는 천 가방' : '금속 열쇠 여러 개와 고리',
  foundAt: '2026-11-' + String(15 - index).padStart(2, '0'),
  foundPlace: (index % 2 ? '경기' : '서울') + ' · 샘플 장소',
  custodyName: '샘플 보관기관',
  officialUrl: null,
  matchReasons: [category, color],
  location: { status: 'missing', address: null },
}))

export const initialValuables: Valuable[] = [
  { id: 'sample-v1', name: '매일 쓰는 지갑', category: '지갑', status: 'kept', notes: '검정 가죽 · 반지갑', photos: [samplePhotos[1]], createdAt: Date.UTC(2026, 10, 17, 9), viewedAt: Date.UTC(2026, 10, 17, 12), updatedAt: Date.UTC(2026, 10, 17, 9) },
  { id: 'sample-v2', name: '집 열쇠', category: '열쇠', status: 'lost', notes: '은색 열쇠고리', photos: [samplePhotos[3]], createdAt: Date.UTC(2026, 10, 16, 18), viewedAt: Date.UTC(2026, 10, 16, 20), updatedAt: Date.UTC(2026, 10, 16, 18) },
]

export function valuableCreatedAt(item: Valuable) {
  return item.createdAt ?? item.updatedAt
}

export function photoFromFile(file: File, id: string): AppPhoto {
  return { id, name: file.name, file, sampleUrl: null, kind: /screen|screenshot|capture|스크린|캡처/i.test(file.name) ? 'screenshot' : 'photo', path: file.webkitRelativePath || file.name, updatedAt: file.lastModified }
}

const localPhotoIds = new WeakMap<File, string>()
export function localPhotoId(file: File) {
  let id = localPhotoIds.get(file)
  if (!id) { id = 'local-' + crypto.randomUUID(); localPhotoIds.set(file, id) }
  return id
}

export function safeReturn(value: string | null, fallback: string) {
  return value && /^\/(gallery|lost-found|history|valuables|settings|account)(\/|\?|$)/.test(value) ? value : fallback
}

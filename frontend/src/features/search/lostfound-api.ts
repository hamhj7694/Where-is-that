import type { Candidate, PlaceInfo } from './catalog-model'

export type LostFoundSource = 'police' | 'portal'

export interface FoundItem {
  id: string
  source: LostFoundSource
  atcId: string
  fdSn: string
  name: string
  subject: string
  category: string
  color: string
  imageUrl: string | null
  foundDate: string
  foundTime: string
  foundPlace: string
  storagePlace: string
  orgName: string
  tel: string
  status: string
  address: string
  notes: string
  mapUrl: string | null
  lat: number | null
  lng: number | null
  place?: PlaceInfo | null
  /** 공개 JSON에 AI 맞춤 조건을 적용한 결과. 서버 응답에만 있다. */
  aiMatch?: { hits: string[]; allInclude: boolean }
}

export interface RouteResult {
  distance: number
  duration: number
  mapUrl: string
  path: [number, number][]
}

export interface MapConfig {
  javascriptKey: string
  available: boolean
}

export interface OriginResult {
  name: string
  lat: number
  lng: number
  address: string
}

/** 공개 검색 API에 지역 코드가 없어 보관기관·주소 텍스트에서 시도를 유추한다. */
export const REGIONS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'] as const

const REGION_KEYWORDS: readonly (readonly [string, readonly string[]])[] = [
  ['서울', ['서울', '종로', '용산', '성동', '광진', '동대문', '중랑', '성북', '강북', '도봉', '노원', '은평', '서대문', '마포', '양천', '강서', '구로', '금천', '영등포', '동작', '관악', '서초', '강남', '송파', '강동', '회기', '신월', '목동', '여의도', '명동', '종각', '홍대', '신촌', '이태원', '잠실', '삼성동', '역삼', '논현동', '방배', '사당', '신림', '가산', '천호', '상계', '중계', '창동', '수유', '미아', '안암', '왕십리', '성수', '건대', '장안', '행당', '금호', '옥수', '이촌']],
  ['부산', ['부산', '해운대', '서면', '남포', '동래', '연제', '수영', '금정', '사상', '사하', '기장', '영도']],
  ['대구', ['대구', '수성', '달서', '달성']],
  ['인천', ['인천', '송도', '연수', '남동', '부평', '계양', '미추홀', '강화', '옹진']],
  ['광주', ['광주', '광산']],
  ['대전', ['대전', '유성', '대덕']],
  ['울산', ['울산', '울주']],
  ['세종', ['세종']],
  ['경기', ['경기', '수원', '성남', '분당', '고양', '일산', '용인', '기흥', '처인', '부천', '안산', '안양', '남양주', '화성', '동탄', '평택', '송탄', '의정부', '군포', '오산', '시흥', '파주', '김포', '광명', '양주', '구리', '하남', '미사', '위례', '광교', '동두천', '과천', '여주', '이천', '안성', '포천', '양평', '가평', '연천']],
  ['강원', ['강원', '춘천', '원주', '강릉', '동해', '태백', '속초', '삼척', '홍천', '횡성', '영월', '평창', '정선', '철원', '화천', '양구', '인제', '고성', '양양']],
  ['충북', ['충북', '청주', '충주', '제천', '보은', '옥천', '영동', '증평', '진천', '괴산', '음성', '단양']],
  ['충남', ['충남', '천안', '공주', '보령', '아산', '서산', '논산', '계룡', '당진', '금산', '부여', '서천', '청양', '홍성', '예산', '태안']],
  ['전북', ['전북', '전주', '군산', '익산', '정읍', '남원', '김제', '완주', '진안', '무주', '장수', '임실', '순창', '고창', '부안']],
  ['전남', ['전남', '목포', '여수', '순천', '나주', '광양', '담양', '곡성', '구례', '고흥', '보성', '화순', '장흥', '강진', '해남', '영암', '무안', '함평', '영광', '장성', '완도', '진도', '신안']],
  ['경북', ['경북', '포항', '경주', '안동', '김천', '구미', '영주', '영천', '상주', '문경', '경산', '의성', '청송', '영양', '영덕', '청도', '고령', '성주', '칠곡', '예천', '봉화', '울진', '울릉']],
  ['경남', ['경남', '창원', '진주', '통영', '사천', '김해', '밀양', '거제', '양산', '의령', '함안', '창녕', '고성', '남해', '하동', '산청', '함양', '거창', '합천']],
  ['제주', ['제주']],
]

export function inferRegion(item: Pick<FoundItem, 'storagePlace' | 'orgName' | 'address'>): string | null {
  const text = [item.storagePlace, item.orgName, item.address].filter(Boolean).join(' ')
  for (const [region, keywords] of REGION_KEYWORDS) {
    if (keywords.some(keyword => text.includes(keyword))) return region
  }
  return null
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/** 습득일(fdYmd)과 시각(fdHor)을 `2026-11-19 (목) 21시` 한 줄로 표시한다. */
export function formatFoundDateTime(foundAt: string | null, foundTime?: string | null): string | null {
  if (!foundAt) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(foundAt.trim())
  if (!match) return foundAt
  const [, year, month, day] = match
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()]
  const raw = (foundTime ?? '').trim()
  const hour = /^\d{1,2}$/.test(raw)
    ? raw
    : /^\d{4}$/.test(raw)
      ? raw.slice(0, 2)
      : /^(\d{1,2}):\d{2}$/.exec(raw)?.[1] ?? ''
  const time = hour ? ` ${hour.padStart(2, '0')}시` : ''
  return `${year}-${month}-${day} (${weekday})${time}`
}

/** 공개 API 설명에서 `내용` 접두어를 빼고 `특이사항`을 새 줄로 분리한다. */
export function formatDescription(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  return text
    .replace(/^내용\s*:?\s*/, '')
    .replace(/\s+(특이사항\s*:)/g, '\n$1')
    .trim()
}

export interface LostSearchHints extends Record<string, unknown> {
  apiKeywords?: string[]
  include?: string[]
  any?: string[]
  exclude?: string[]
  imageFeatures?: string[]
}

interface SearchPayload {
  query: string
  sources: string[]
  total: number
  items: FoundItem[]
  errors: { source: string; code: string; message: string }[]
  apiKeywords?: string[]
  matched?: number
}

export interface LostBrowseFilters {
  category?: string
  color?: string
  region?: string
  from?: string
  to?: string
}

export interface BrowsePayload extends SearchPayload {
  page: number
  rows: number
  scanned: number
  scanLimitReached: boolean
  criteriaApplied: boolean
  filtersApplied: Record<string, string>
}

interface ErrorPayload {
  code?: string
  message?: string
}

export class LostFoundApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'LostFoundApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new LostFoundApiError('network', '서버에 연결하지 못했어요.', 0)
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (!body || typeof body !== 'object') {
      if (response.status >= 500) throw new LostFoundApiError('network', '서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.', response.status)
      throw new LostFoundApiError('unknown', '요청을 처리하지 못했어요.', response.status)
    }
    const error = body as ErrorPayload
    throw new LostFoundApiError(error.code ?? 'unknown', error.message ?? '요청을 처리하지 못했어요.', response.status)
  }
  return body as T
}

/** AI가 분리한 탐색어·AND/OR/NOT·사진 특징을 hints로 함께 보낸다. */
export function searchLostFound(keyword: string, page = 1, rows = 40, hints?: LostSearchHints): Promise<SearchPayload> {
  return request<SearchPayload>('/lostfound/search', {
    method: 'POST',
    body: JSON.stringify({ keyword, page, rows, ...(hints ? { hints } : {}) }),
  })
}

/** 직접 찾기: 검색어 없이 공개 API의 전체 목록을 페이지 단위로 가져온다. */
export function listLostFound(page = 1, rows = 40): Promise<SearchPayload> {
  return request<SearchPayload>('/lostfound/list', {
    method: 'POST',
    body: JSON.stringify({ page, rows }),
  })
}

/**
 * 직접 찾기용 서버 필터 조회. 여러 페이지를 스캔해 필터와 AI 조건을 먼저 적용하고,
 * 필터를 통과한 건수 기준으로 total/page를 다시 계산한다.
 */
export function browseLostFound(
  keyword: string,
  page = 1,
  rows = 40,
  hints?: LostSearchHints,
  filters?: LostBrowseFilters,
  maxPages = 20,
): Promise<BrowsePayload> {
  return request<BrowsePayload>('/lostfound/browse', {
    method: 'POST',
    body: JSON.stringify({
      keyword, page, rows, maxPages,
      ...(hints ? { hints } : {}),
      ...(filters ? { filters } : {}),
    }),
  })
}

export function fetchLostFoundDetail(source: LostFoundSource, atcId: string, fdSn: string): Promise<FoundItem> {
  return request<FoundItem>(`/lostfound/${source}/${encodeURIComponent(atcId)}/${encodeURIComponent(fdSn)}`)
}

/** 지도 SDK용 공개 키만 서버에서 받는다. REST 키·서비스키는 응답에 없다. */
export function fetchMapConfig(): Promise<MapConfig> {
  return request<MapConfig>('/lostfound/map-config')
}

export function geocodeOrigin(query: string): Promise<OriginResult> {
  return request<OriginResult>('/lostfound/geocode', {
    method: 'POST',
    body: JSON.stringify({ query }),
  })
}

export function fetchRoute(
  originLat: number, originLng: number,
  destinationLat: number, destinationLng: number,
  destinationName: string, originName = '현재 위치',
): Promise<RouteResult> {
  return request<RouteResult>('/lostfound/route', {
    method: 'POST',
    body: JSON.stringify({ originLat, originLng, destinationLat, destinationLng, destinationName, originName }),
  })
}

/**
 * 화면 표시용 중복 제거. 서로 다른 관리번호라도 물품명·색상·분류·습득일·보관기관이
 * 같으면 같은 후보로 보고 첫 건만 남긴다(사진이 여러 장 붙은 같은 물건 대응).
 * 백엔드의 (source, atcId, fdSn) 정확 일치 제거와는 별개다.
 */
export function dedupeLostFound(items: readonly FoundItem[]): FoundItem[] {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
  const seenIds = new Set<string>()
  const seen = new Set<string>()
  const result: FoundItem[] = []
  for (const item of items) {
    if (seenIds.has(item.id)) continue
    seenIds.add(item.id)
    const key = [item.name, item.color, item.category, item.foundDate, item.storagePlace || item.orgName]
      .map(normalize).join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

/** 공개 API 응답을 기존 후보 카드 모델로 변환한다. AI 점수·재정렬은 하지 않는다. */
export function toCandidate(item: FoundItem, detailed = false): Candidate {
  const hasCoords = detailed && typeof item.lat === 'number' && typeof item.lng === 'number'
  return {
    id: `${item.source}:${item.atcId}:${item.fdSn}`,
    source: item.source,
    atcId: item.atcId,
    fdSn: item.fdSn,
    region: inferRegion(item),
    title: item.name,
    image: item.imageUrl || null,
    photoStatus: item.imageUrl ? 'verified_photo' : 'no_photo',
    category: item.category,
    color: item.color,
    description: item.subject || item.notes || '',
    foundAt: item.foundDate || null,
    foundTime: item.foundTime || null,
    foundPlace: item.foundPlace || null,
    custodyName: item.storagePlace || item.orgName || null,
    custodyStatus: item.status || null,
    officialUrl: null,
    matchReasons: [],
    location: {
      status: hasCoords ? 'verified' : item.address ? 'address_only' : 'missing',
      address: item.address || null,
      ...(hasCoords ? { latitude: item.lat!, longitude: item.lng! } : {}),
    },
    tel: item.tel || null,
    mapUrl: item.mapUrl || null,
    place: item.place ?? null,
  }
}

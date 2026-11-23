import type { AiSearchCriteria } from './ai-match-model'

export type AiPipelineMode = 'gallery' | 'lost' | 'direct'

export interface AiSearchChannelPlan {
  query: string
  keywords: string[]
}

export interface AiSearchPlan {
  originalQuery: string
  /** 원문 + 추가 조건을 한 문장으로 다듬은 검색어. 검색 도우미가 검색창에 적는다. */
  refinedQuery?: string
  imageDescriptions: string[]
  channels: {
    combined: AiSearchChannelPlan
    image: AiSearchChannelPlan
    context: AiSearchChannelPlan
  }
  filters: {
    category: string
    region: string
    view: string
    fromDate: string
    toDate: string
  }
  /** 자연어·사진에서 분리한 AND/OR/NOT·API 탐색어. 이전 응답에는 없을 수 있다. */
  criteria?: AiSearchCriteria
  clarificationQuestions: string[]
}

export interface AiContextRankCandidate {
  id: string
  name: string
  subject: string
  notes: string
  category: string
  color: string
  foundDate: string
  foundTime: string
  foundPlace: string
  storagePlace: string
  orgName: string
  address: string
  status: string
  keepType: string
  placeName: string
  placeAddress: string
  placeRoadAddress: string
  placeCategory: string
}

export type AiLocationRelation = 'direct_match' | 'possible_nearby' | 'regional_context' | 'uncertain' | 'not_applicable'

export interface AiContextRankedCandidate {
  id: string
  score: number
  reasons: string[]
  locationRelation: AiLocationRelation
  locationEvidence: string
  uncertainty: string
}

const locationRelations: AiLocationRelation[] = ['direct_match', 'possible_nearby', 'regional_context', 'uncertain', 'not_applicable']

function isRankedContextCandidate(value: unknown): value is AiContextRankedCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AiContextRankedCandidate>
  const score = candidate.score
  return typeof candidate.id === 'string'
    && typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100
    && Array.isArray(candidate.reasons) && candidate.reasons.every(reason => typeof reason === 'string')
    && typeof candidate.locationRelation === 'string' && locationRelations.some(relation => relation === candidate.locationRelation)
    && typeof candidate.locationEvidence === 'string'
    && typeof candidate.uncertainty === 'string'
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const error = 'detail' in body ? body.detail : body
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') return fallback
  return error.message
}

async function fileToDataUrl(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('AI에 참고할 사진은 5MB 이하로 선택해 주세요.')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('사진을 읽지 못했어요.'))
    reader.onerror = () => reject(new Error('사진을 읽지 못했어요.'))
    reader.readAsDataURL(file)
  })
}

export async function prepareAiSearch(
  mode: AiPipelineMode,
  query: string,
  images: readonly File[] = [],
  filters: Record<string, string> = {},
): Promise<AiSearchPlan> {
  const imageData = await Promise.all(images.slice(0, 6).map(fileToDataUrl))
  let response: Response
  try {
    response = await fetch('/api/ai/search/prepare', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, query, images: imageData, filters, externalProcessingConfirmed: true }),
    })
  } catch {
    throw new Error('서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(apiErrorMessage(body, 'AI 검색 조건을 정리하지 못했어요.'))
  }
  return body as AiSearchPlan
}

/** 종합 관련성(score) + 이미지 유사도 + 맥락 관련성. */
export interface AiImageRankResult {
  id: string
  score: number
  imageSimilarity: number
  contextRelevance: number
  reasons: string[]
}

export interface AiCompareResult {
  results: AiImageRankResult[]
  /** AI가 참고 사진에서 읽은 대상·요소 설명. 검색 문장과 함께 3축 채점에 반영된다. */
  referenceDescriptions: string[]
  /** 이미지 유사도를 전용 비전 임베딩으로 계산했는지 여부. */
  imageSimilaritySource: 'vision-model' | 'multimodal'
}

/** 연결 갤러리 후보 사진을 참고 사진/검색 문장과 비교해 3축 점수를 받는다. */
export async function compareCandidates(input: {
  mode: AiPipelineMode
  query: string
  references: readonly File[]
  candidates: readonly { id: string; file: File }[]
}): Promise<AiCompareResult> {
  if (!input.candidates.length || input.candidates.length > 12) throw new Error('비교할 사진은 1~12장이어야 해요.')
  const references = await Promise.all(input.references.slice(0, 6).map(fileToDataUrl))
  const candidates = await Promise.all(input.candidates.map(async candidate => ({
    id: candidate.id,
    image: await fileToDataUrl(candidate.file),
  })))
  let response: Response
  try {
    response = await fetch('/api/ai/vision/compare', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: input.mode, query: input.query, references, candidates, externalProcessingConfirmed: true,
      }),
    })
  } catch {
    throw new Error('서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(body, 'AI가 사진 유사도를 비교하지 못했어요.'))
  if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
    throw new Error('AI 사진 비교 결과를 확인할 수 없어요.')
  }
  const results = body.results.flatMap((item): AiImageRankResult[] => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Partial<AiImageRankResult>
    if (typeof raw.id !== 'string' || typeof raw.score !== 'number') return []
    // 서버가 축 점수를 생략한 경우 종합 점수로 채운다(백엔드 호환 로직과 동일).
    return [{
      id: raw.id,
      score: raw.score,
      imageSimilarity: typeof raw.imageSimilarity === 'number' ? raw.imageSimilarity : raw.score,
      contextRelevance: typeof raw.contextRelevance === 'number' ? raw.contextRelevance : raw.score,
      reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((reason): reason is string => typeof reason === 'string') : [],
    }]
  })
  const expected = new Set(input.candidates.map(candidate => candidate.id))
  const ids = results.map(item => item.id)
  if (ids.length !== results.length || new Set(ids).size !== expected.size || ids.some(id => !expected.has(id))) {
    throw new Error('AI 사진 비교 결과가 일부 누락되거나 중복됐어요.')
  }
  const referenceDescriptions = 'referenceDescriptions' in body && Array.isArray(body.referenceDescriptions)
    ? body.referenceDescriptions
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.slice(0, 300))
      .slice(0, 6)
    : []
  const imageSimilaritySource = 'imageSimilaritySource' in body && body.imageSimilaritySource === 'vision-model'
    ? 'vision-model'
    : 'multimodal'
  return { results, referenceDescriptions, imageSimilaritySource }
}

/** 공개 습득물의 사진·설명을 시각 특징과 대조한 결과. */
export interface AiVisualMatchResult {
  id: string
  imageSimilarity: number
  /** photo=공개 사진 분석, description=사진 없이 설명 분석. */
  basis: 'photo' | 'description'
  reason: string
}

export interface AiVisualMatchResponse {
  results: AiVisualMatchResult[]
  source: 'vision-model' | 'multimodal'
  usedFeatures: string[]
}

/**
 * 참고 사진이 있어도 없어도 공개 항목의 사진과 설명을 함께 분석한다.
 * 사진이 없는 항목은 설명만으로 시각 특징을 확인해 같은 후보 풀에서 정렬한다.
 */
export async function matchPublicItemImages(input: {
  query: string
  imageFeatures: readonly string[]
  references: readonly File[]
  candidates: readonly { id: string; imageUrl?: string; text?: string }[]
}): Promise<AiVisualMatchResponse> {
  if (!input.candidates.length || input.candidates.length > 12) throw new Error('비교할 공개 후보는 1~12건이어야 해요.')
  const references = await Promise.all(input.references.slice(0, 6).map(fileToDataUrl))
  const candidates = input.candidates.map(candidate => ({
    id: candidate.id,
    imageUrl: candidate.imageUrl ?? '',
    text: candidate.text ?? '',
  }))
  let response: Response
  try {
    response = await fetch('/api/ai/vision/match-public', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: input.query,
        imageFeatures: input.imageFeatures,
        references,
        candidates,
        externalProcessingConfirmed: true,
      }),
    })
  } catch {
    throw new Error('서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(body, 'AI가 공개 사진·설명을 비교하지 못했어요.'))
  if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
    throw new Error('AI 사진·설명 비교 결과를 확인할 수 없어요.')
  }
  const results = body.results.flatMap((item): AiVisualMatchResult[] => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Partial<AiVisualMatchResult>
    if (typeof raw.id !== 'string' || typeof raw.imageSimilarity !== 'number'
      || !Number.isFinite(raw.imageSimilarity) || raw.imageSimilarity < 0 || raw.imageSimilarity > 100) return []
    return [{
      id: raw.id,
      imageSimilarity: Math.round(raw.imageSimilarity),
      basis: raw.basis === 'photo' ? 'photo' : 'description',
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 160) : '',
    }]
  })
  const source = 'source' in body && body.source === 'vision-model' ? 'vision-model' : 'multimodal'
  const usedFeatures = 'usedFeatures' in body && Array.isArray(body.usedFeatures)
    ? body.usedFeatures.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : []
  return { results, source, usedFeatures }
}

export async function rankLostContextCandidates(input: {
  originalQuery: string
  searchQuery: string
  imageDescriptions: readonly string[]
  filters: Record<string, string>
  candidates: readonly AiContextRankCandidate[]
}): Promise<AiContextRankedCandidate[]> {
  if (!input.candidates.length || input.candidates.length > 12) throw new Error('현재 페이지 후보를 다시 확인해 주세요.')
  let response: Response
  try {
    response = await fetch('/api/ai/search/rank-context', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, candidateDataProcessingConfirmed: true }),
    })
  } catch {
    throw new Error('서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(apiErrorMessage(body, 'AI가 설명·장소 후보를 비교하지 못했어요.'))
  }
  if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
    throw new Error('AI 설명·장소 분석 결과를 확인할 수 없어요.')
  }
  const results: unknown[] = body.results
  const expected = new Set(input.candidates.map(candidate => candidate.id))
  const ids = results.filter(isRankedContextCandidate).map(candidate => candidate.id)
  if (ids.length !== results.length || ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) {
    throw new Error('AI 설명·장소 분석 결과가 일부 누락되거나 중복됐어요.')
  }
  return results.filter(isRankedContextCandidate)
}

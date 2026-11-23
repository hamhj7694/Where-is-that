import type { AiImageRankResult, AiSearchPlan } from './ai-search-api'

export const GALLERY_CHANNELS = ['combined', 'image', 'context'] as const
export type GallerySearchChannel = typeof GALLERY_CHANNELS[number]
export const GALLERY_PREVIEW_LIMIT = 4

export interface GalleryAssistantMessage {
  id: string
  role: 'user' | 'guide'
  text: string
}

export interface GalleryAssistantState {
  draft: string
  conditions: string[]
  messages: GalleryAssistantMessage[]
  open?: boolean
  appliedConditions?: string[]
  aiPlan?: AiSearchPlan | null
  /** AI가 원문+조건을 다듬어 만든 자연어 검색어. 있으면 조건 나열 대신 이 값을 검색어로 쓴다. */
  optimizedQuery?: string
}

export function createGalleryAssistantState(): GalleryAssistantState {
  return { draft: '', conditions: [], appliedConditions: [], messages: [] }
}

export function addGalleryCondition(state: GalleryAssistantState, text: string): GalleryAssistantState {
  const condition = text.trim()
  if (!condition || state.conditions.some(value => value.trim() === condition)) return state
  return {
    ...state,
    draft: '',
    conditions: [...state.conditions, condition],
    messages: [
      ...state.messages,
      { id: crypto.randomUUID(), role: 'user', text: condition },
      { id: crypto.randomUUID(), role: 'guide', text: '조건에 담았어요. 확인 후 다시 검색해 보세요.' },
    ],
  }
}

export function removeGalleryCondition(state: GalleryAssistantState, index: number): GalleryAssistantState {
  if (!Number.isInteger(index) || index < 0 || index >= state.conditions.length) return state
  return { ...state, conditions: state.conditions.filter((_, position) => position !== index) }
}

export function editGalleryCondition(state: GalleryAssistantState, index: number, text: string): GalleryAssistantState {
  const condition = text.trim()
  if (!Number.isInteger(index) || index < 0 || index >= state.conditions.length || !condition) return state
  const previous = state.conditions[index]
  if (previous === condition || state.conditions.some((value, position) => position !== index && value.trim() === condition)) return state
  let messageIndex = -1
  for (let position = state.messages.length - 1; position >= 0; position--) {
    const message = state.messages[position]
    if (message.role === 'user' && message.text.trim() === previous.trim()) { messageIndex = position; break }
  }
  return {
    ...state,
    conditions: state.conditions.map((value, position) => position === index ? condition : value),
    messages: state.messages.map((message, position) => position === messageIndex ? { ...message, text: condition } : message),
  }
}

export function galleryConditionsChanged(state: GalleryAssistantState): boolean {
  const applied = state.appliedConditions ?? []
  return state.conditions.length !== applied.length || state.conditions.some((condition, index) => condition !== applied[index])
}

export function combineGalleryQuery(base: string, conditions: readonly string[]): string {
  return [base, ...conditions].flatMap(text => text.split(/\r?\n/))
    .filter(line => line.trim().length > 0).join('\n').trim()
}

export function uniqueGalleryItems<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function galleryPreviewItems<T extends { id: string }>(items: readonly T[]): T[] {
  return uniqueGalleryItems(items).slice(0, GALLERY_PREVIEW_LIMIT)
}

// AI 사진 비교는 한 요청당 최대 12후보다. 연결 갤러리에서 분석할 후보 수다.
export const AI_GALLERY_RANK_LIMIT = 12

export interface GalleryRankScore {
  score: number
  imageSimilarity: number
  contextRelevance: number
}
export type GalleryRankMap = Record<string, GalleryRankScore>

export function toGalleryRankMap(results: readonly AiImageRankResult[]): GalleryRankMap {
  return Object.fromEntries(results.map(result => [result.id, {
    score: result.score,
    imageSimilarity: result.imageSimilarity,
    contextRelevance: result.contextRelevance,
  }]))
}

/** 각 채널이 담당하는 축으로 정렬한다. 점수 없는 후보는 원래 연결 순서를 뒤로 유지한다. */
export function sortGalleryByRank<T extends { id: string }>(items: readonly T[], ranking: GalleryRankMap | null, channel: GallerySearchChannel): T[] {
  if (!ranking) return [...items]
  const axis: keyof GalleryRankScore = channel === 'image' ? 'imageSimilarity' : channel === 'context' ? 'contextRelevance' : 'score'
  return [...items].sort((first, second) => {
    const left = ranking[first.id]?.[axis]
    const right = ranking[second.id]?.[axis]
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return right - left
  })
}

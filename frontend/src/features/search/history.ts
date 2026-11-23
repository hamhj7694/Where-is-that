import { snapshotSearchDraft, validateSearch, type GallerySource, type SearchDraft, type SearchMode } from './model'
import { combineGalleryQuery, createGalleryAssistantState, type GalleryAssistantState } from './gallery-search-model'
import type { AiContextRankedCandidate, AiVisualMatchResult } from './ai-search-api'
import type { FoundItem } from './lostfound-api'

// Session memory only. Keep the submitted input/source separate from later edits.
export interface SearchRecord {
  id: string
  mode: SearchMode
  createdAt: number
  draft: SearchDraft
  gallery: GallerySource | null
  assistant?: GalleryAssistantState
  parentRecordId?: string
  assistantBaseQuery?: string
}

/**
 * 같은 조건으로 다시 검색해도 결과가 달라지지 않도록 검색 시점의 공개 응답과
 * AI 점수를 기록 id에 붙여 둔다. 사진 File은 담지 않고 공개 URL만 문자열로 저장한다.
 */
export interface LostResultsSnapshot {
  version: 1
  savedAt: number
  keyword: string
  hintsKey: string
  params: string
  raw: FoundItem[]
  fetched: number
  total: number
  apiPage: number
  partial: boolean
  rank?: { scope: string; results: AiContextRankedCandidate[] }
  visual?: { scope: string; results: AiVisualMatchResult[]; source: 'vision-model' | 'multimodal' }
  textScores?: [string, number][]
  /** 새로고침에서 신규 여부를 판단할 기준 id 목록. */
  baselineIds: string[]
  newRaw: FoundItem[]
  lastRefreshAt?: number
}

const LOST_RESULTS_KEY = 'geugeo-eodi:lost-results:'

export function saveLostResultsSnapshot(key: string, snapshot: LostResultsSnapshot): void {
  if (typeof window === 'undefined') return
  const payload = JSON.stringify(snapshot)
  try {
    window.localStorage.setItem(LOST_RESULTS_KEY + key, payload)
  } catch {
    // 저장 공간이 부족하면 카드에 필요한 최근 후보만 남긴다.
    try {
      window.localStorage.setItem(LOST_RESULTS_KEY + key, JSON.stringify({
        ...snapshot,
        raw: snapshot.raw.slice(0, 120),
        newRaw: snapshot.newRaw.slice(0, 40),
      }))
    } catch { /* 저장 불가면 스냅샷 없이 조건만 남긴다. */ }
  }
}

export function readLostResultsSnapshot(key: string): LostResultsSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LOST_RESULTS_KEY + key)
    if (!raw) return null
    const value = JSON.parse(raw) as LostResultsSnapshot
    return value.version === 1 && typeof value.keyword === 'string' && Array.isArray(value.raw) ? value : null
  } catch {
    return null
  }
}

export function clearLostResultsSnapshot(key: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(LOST_RESULTS_KEY + key) } catch { /* 무시 */ }
}

export function createSearchRecord(mode: SearchMode, draft: SearchDraft, gallery: GallerySource | null): SearchRecord {
  return {
    id: crypto.randomUUID(), mode, createdAt: Date.now(),
    draft: snapshotSearchDraft(mode, draft),
    gallery: mode === 'gallery' && gallery ? { name: gallery.name, files: [...gallery.files] } : null,
  }
}

export function recordPath(record: SearchRecord) {
  return (record.mode === 'gallery' ? '/gallery' : '/lost-found') + '/results?record=' + encodeURIComponent(record.id)
}

export function findSearchRecord(records: SearchRecord[], id: string | null, mode: SearchMode) {
  return records.find(record => record.id === id && record.mode === mode)
}

export function disconnectGalleryHistory(records: SearchRecord[]) {
  return records.filter(record => record.mode !== 'gallery')
}

export function removeSearchRecord(records: SearchRecord[], id: string) {
  return records.filter(record => record.id !== id)
}

export function updateSearchAssistant(records: SearchRecord[], id: string, patch: Partial<GalleryAssistantState>): SearchRecord[] {
  return records.map(record => {
    if (record.id !== id) return record
    const resolved = resolveAssistant(records, record, record.mode)
    const state = { ...resolved.assistant, ...patch }
    return {
      ...record,
      assistantBaseQuery: resolved.baseQuery,
      assistant: copyAssistant(state),
    }
  })
}

export function refineGalleryRecord(parent: SearchRecord, assistant: GalleryAssistantState): SearchRecord | null {
  const conditions = assistant.conditions.filter(condition => condition.trim().length > 0)
  const optimized = assistant.optimizedQuery?.trim()
  if (parent.mode !== 'gallery' || !parent.gallery || (!conditions.length && !assistant.appliedConditions?.length && !optimized)) return null
  const baseQuery = parent.assistantBaseQuery ?? parent.draft.query
  const draft = snapshotSearchDraft('gallery', {
    query: optimized || combineGalleryQuery(baseQuery, conditions),
    photo: parent.draft.photo,
    aiPlan: assistant.aiPlan ?? undefined,
  })
  return {
    ...parent,
    draft,
    gallery: { name: parent.gallery.name, files: [...parent.gallery.files] },
    assistantBaseQuery: baseQuery,
    assistant: copyAssistant({ ...assistant, draft: '', conditions, appliedConditions: [...conditions], optimizedQuery: undefined }),
  }
}

export function refineLostRecord(parent: SearchRecord, assistant: GalleryAssistantState): SearchRecord | null {
  const conditions = assistant.conditions.filter(condition => condition.trim().length > 0)
  const optimized = assistant.optimizedQuery?.trim()
  if (parent.mode !== 'lost' || (!conditions.length && !assistant.appliedConditions?.length && !optimized)) return null
  const baseQuery = parent.assistantBaseQuery ?? parent.draft.query
  const draft = { ...parent.draft, query: optimized || combineGalleryQuery(baseQuery, conditions), aiPlan: assistant.aiPlan ?? undefined }
  if (validateSearch('lost', draft, null)) return null
  return {
    ...parent,
    draft: snapshotSearchDraft('lost', draft),
    gallery: null,
    assistantBaseQuery: baseQuery,
    assistant: copyAssistant({ ...assistant, draft: '', conditions, appliedConditions: [...conditions], optimizedQuery: undefined }),
  }
}

function copyAssistant(state: GalleryAssistantState): GalleryAssistantState {
  return {
    ...state,
    conditions: [...state.conditions],
    ...(state.appliedConditions !== undefined ? { appliedConditions: [...state.appliedConditions] } : {}),
    messages: state.messages.map(message => ({ ...message })),
  }
}

export function overwriteGallerySearch(records: SearchRecord[], id: string, draft: SearchDraft): SearchRecord[] {
  const query = draft.query.trim()
  if (!query && !draft.photo) return records
  return records.map(record => record.id === id && record.mode === 'gallery' ? {
    ...record,
    draft: snapshotSearchDraft('gallery', draft),
    assistant: createGalleryAssistantState(),
    assistantBaseQuery: query,
  } : record)
}

export function overwriteLostSearch(records: SearchRecord[], id: string, draft: SearchDraft): SearchRecord[] {
  if (validateSearch('lost', draft, null)) return records
  return records.map(record => record.id === id && record.mode === 'lost' ? {
    ...record,
    draft: snapshotSearchDraft('lost', draft),
    assistant: createGalleryAssistantState(),
    assistantBaseQuery: draft.query.trim(),
  } : record)
}

// An old refined record has its applied conditions in the query, but only
// pending conditions in assistant.conditions. Recover that distinction without
// changing the stored record or guessing at missing ancestry.
export function resolveGalleryAssistant(records: readonly SearchRecord[], record: SearchRecord): { baseQuery: string; assistant: GalleryAssistantState } {
  return resolveAssistant(records, record, 'gallery')
}

export function resolveLostAssistant(records: readonly SearchRecord[], record: SearchRecord): { baseQuery: string; assistant: GalleryAssistantState } {
  return resolveAssistant(records, record, 'lost')
}

function resolveAssistant(records: readonly SearchRecord[], record: SearchRecord, mode: SearchMode): { baseQuery: string; assistant: GalleryAssistantState } {
  const state = record.assistant ?? { draft: '', conditions: [], messages: [] }
  if (state.appliedConditions !== undefined) {
    return { baseQuery: record.assistantBaseQuery ?? record.draft.query, assistant: copyAssistant(state) }
  }

  let baseQuery = record.draft.query
  let current = record
  const visited = new Set<string>()
  let resolved = false
  while (!visited.has(current.id)) {
    visited.add(current.id)
    if (current.assistantBaseQuery !== undefined) { baseQuery = current.assistantBaseQuery; resolved = true; break }
    if (!current.parentRecordId) { baseQuery = current.draft.query; resolved = true; break }
    const parent = records.find(candidate => candidate.id === current.parentRecordId && candidate.mode === mode)
    if (!parent) break
    current = parent
  }

  const query = combineGalleryQuery(record.draft.query, [])
  const normalizedBase = combineGalleryQuery(baseQuery, [])
  const hasPrefix = resolved && (query === normalizedBase || !normalizedBase || query.startsWith(normalizedBase + '\n'))
  if (!hasPrefix) return { baseQuery: record.draft.query, assistant: copyAssistant({ ...state, appliedConditions: [] }) }

  const suffix = query === normalizedBase ? '' : normalizedBase ? query.slice(normalizedBase.length + 1) : query
  const appliedConditions = suffix ? recoverConditionGroups(suffix, state.messages) : []
  const conditions = [...appliedConditions]
  for (const condition of state.conditions) {
    if (!conditions.some(value => value.trim() === condition.trim())) conditions.push(condition)
  }
  return { baseQuery, assistant: copyAssistant({ ...state, conditions, appliedConditions }) }
}

function recoverConditionGroups(suffix: string, messages: GalleryAssistantState['messages']): string[] {
  const candidates = messages.filter(message => message.role === 'user' && message.text.trim())
    .map(message => ({ value: message.text.trim(), match: combineGalleryQuery('', [message.text]) }))
    .sort((first, second) => second.match.length - first.match.length)
  const memo = new Map<string, string[] | null>()
  function split(remaining: string): string[] | null {
    if (!remaining) return []
    if (memo.has(remaining)) return memo.get(remaining)!
    for (const candidate of candidates) {
      if (remaining !== candidate.match && !remaining.startsWith(candidate.match + '\n')) continue
      const rest = split(remaining === candidate.match ? '' : remaining.slice(candidate.match.length + 1))
      if (rest) { const result = [candidate.value, ...rest]; memo.set(remaining, result); return result }
    }
    memo.set(remaining, null)
    return null
  }
  return split(suffix) ?? [suffix]
}

import { snapshotSearchDraft, type GallerySource, type SearchDraft, type SearchMode } from './model'
import { combineGalleryQuery, createGalleryAssistantState, type GalleryAssistantState } from './gallery-search-model'

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
    if (record.id !== id || record.mode !== 'gallery') return record
    const resolved = resolveGalleryAssistant(records, record)
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
  if (parent.mode !== 'gallery' || !parent.gallery || (!conditions.length && !assistant.appliedConditions?.length)) return null
  const baseQuery = parent.assistantBaseQuery ?? parent.draft.query
  const child = createSearchRecord('gallery', {
    query: combineGalleryQuery(baseQuery, conditions),
    photo: parent.draft.photo,
  }, parent.gallery)
  return {
    ...child,
    parentRecordId: parent.id,
    assistantBaseQuery: baseQuery,
    assistant: copyAssistant({ ...assistant, draft: '', conditions, appliedConditions: [...conditions] }),
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
    draft: { query, photo: draft.photo },
    assistant: createGalleryAssistantState(),
    assistantBaseQuery: query,
  } : record)
}

// An old refined record has its applied conditions in the query, but only
// pending conditions in assistant.conditions. Recover that distinction without
// changing the stored record or guessing at missing ancestry.
export function resolveGalleryAssistant(records: readonly SearchRecord[], record: SearchRecord): { baseQuery: string; assistant: GalleryAssistantState } {
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
    const parent = records.find(candidate => candidate.id === current.parentRecordId && candidate.mode === 'gallery')
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

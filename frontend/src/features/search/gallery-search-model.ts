export const GALLERY_CHANNELS = ['combined', 'image', 'context'] as const
export type GallerySearchChannel = typeof GALLERY_CHANNELS[number]
export const GALLERY_PREVIEW_LIMIT = 3

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

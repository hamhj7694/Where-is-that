import { prepareAiSearch, type AiPipelineMode, type AiSearchPlan } from './ai-search-api'
import { combineGalleryQuery, type GalleryAssistantState } from './gallery-search-model'

interface OptimizedQueryResult {
  plan: AiSearchPlan
  query: string
}

/** 탐색어만 있는 응답도 검색창에는 자연스러운 문장으로 적는다. */
function toNaturalQuery(value: string): string {
  const text = value.trim()
  if (!text) return ''
  if (/[요.?!]$/.test(text)) return text
  return `${text}에 맞는 물건을 찾아요`
}

/** AI 계획에서 검색창에 적을 자연어 문구를 고른다. 이전 응답에는 refinedQuery가 없을 수 있다. */
export function optimizedQueryFromPlan(plan: AiSearchPlan, fallback: string): string {
  const refined = plan.refinedQuery?.trim()
  if (refined) return refined
  const combined = plan.channels?.combined?.query?.trim()
  return toNaturalQuery(combined || fallback)
}

async function prepareOptimizedQuery(
  mode: AiPipelineMode,
  query: string,
  images: readonly File[] = [],
  filters: Record<string, string> = {},
): Promise<OptimizedQueryResult> {
  const plan = await prepareAiSearch(mode, query, images, filters)
  return { plan, query: optimizedQueryFromPlan(plan, query) }
}

/** 도우미에 담은 조건 + 아직 담지 않은 입력 문구를 중복 없이 모은다. */
export function assistantConditions(state: GalleryAssistantState): string[] {
  const conditions = state.conditions.filter(condition => condition.trim().length > 0)
  const pending = state.draft.trim()
  if (pending && !conditions.includes(pending)) conditions.push(pending)
  return conditions
}

/** AI 호출이 실패했을 때의 기존 동작: 입력한 조건을 그대로 줄 단위로 반영한다. */
export function localAssistantUpdate(state: GalleryAssistantState): GalleryAssistantState {
  const conditions = assistantConditions(state)
  return {
    ...state,
    conditions,
    appliedConditions: [...conditions],
    draft: '',
    aiPlan: state.aiPlan ?? null,
    optimizedQuery: undefined,
  }
}

/**
 * 도우미 조건을 검색용 AI가 해석한 뒤, 한 문장으로 다듬은 검색어를 함께 담은 상태를 만든다.
 * 만든 문구는 검색어로 적히고, 같은 계획(aiPlan)이 실제 탐색어·필터·랭킹에 그대로 쓰인다.
 */
export async function prepareOptimizedAssistant(
  mode: AiPipelineMode,
  state: GalleryAssistantState,
  baseQuery: string,
): Promise<GalleryAssistantState> {
  const conditions = assistantConditions(state)
  const rawQuery = combineGalleryQuery(baseQuery, conditions)
  const { plan, query } = await prepareOptimizedQuery(mode, rawQuery)
  return {
    ...state,
    conditions,
    appliedConditions: [...conditions],
    draft: '',
    aiPlan: plan,
    optimizedQuery: query,
  }
}

/** 사용자가 수정한 문구를 그대로 적용하고, 이전 문구에서 얻은 AI 조건은 다시 계산한다. */
export async function prepareEditedAssistant(
  mode: AiPipelineMode, state: GalleryAssistantState, text: string,
): Promise<GalleryAssistantState> {
  const query = text.trim()
  if (query === state.optimizedQuery?.trim()) return state
  const aiPlan = await prepareAiSearch(mode, query).catch(() => null)
  return { ...state, optimizedQuery: query, aiPlan }
}

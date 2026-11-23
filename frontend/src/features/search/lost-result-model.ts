import type { Candidate } from './catalog-model'
import { REFERENCE_PHOTO_VIEWS, type ReferencePhotoView } from './model'

// 사진 특징 후보를 마지막에 배치해 설명·조건 후보를 먼저 보여준다.
export const LOST_RESULT_CHANNELS = ['combined', 'context', 'image'] as const
export type LostResultChannel = typeof LOST_RESULT_CHANNELS[number]
export type LostResultState = 'success' | 'partial' | 'empty' | 'error' | 'loading' | 'confirmation'
type SourceState = Exclude<LostResultState, 'partial'>
export interface LostResultCounts { image: number; context: number }

/**
 * AI 점수는 축마다 눈금이 다르므로 같은 맵에 섞지 않는다. primary 축에 값이 있는
 * 후보가 먼저 오고, 그다음 secondary, 마지막에 텍스트 점수를 본다. 텍스트 점수는
 * 호출자가 AI 점수보다 낮게 잘라 넣어 부분 문자열 히트가 AI 판단을 이기지 않게 한다.
 */
export function sortByRankTier<T extends Candidate>(
  items: readonly T[],
  primary: ReadonlyMap<string, number>,
  secondary: ReadonlyMap<string, number>,
  fallback?: ReadonlyMap<string, number>,
): T[] {
  const positions = new Map(items.map((item, index) => [item.id, index]))
  const tier = (id: string) => primary.has(id) ? 0 : secondary.has(id) ? 1 : 2
  const score = (id: string) => primary.get(id) ?? secondary.get(id) ?? fallback?.get(id) ?? 0
  return [...items].sort((left, right) =>
    tier(left.id) - tier(right.id)
    || score(right.id) - score(left.id)
    || (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0),
  )
}

export const LOST_RESULT_FILTER_NAMES = {
  category: '물품 분류', color: '색상', region: '분실 예상 지역',
  from: '시작일', to: '종료일', view: '사물 방향',
} as const
export type LostResultFilterKey = keyof typeof LOST_RESULT_FILTER_NAMES
export type LostResultFilterValues = Record<LostResultFilterKey, string>

function isPhotoView(value: string): value is ReferencePhotoView {
  return REFERENCE_PHOTO_VIEWS.some(option => option.value === value)
}

export function isValidLostResultDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Unknown direction/date query values never become an accidental restrictive filter. */
export function readLostResultFilters(params: URLSearchParams): LostResultFilterValues {
  const view = params.get('view') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  return {
    category: (params.get('category') ?? '').trim(),
    color: (params.get('color') ?? '').trim(),
    region: (params.get('region') ?? '').trim(),
    from: isValidLostResultDate(from) ? from : '',
    to: isValidLostResultDate(to) ? to : '',
    view: isPhotoView(view) ? view : '',
  }
}

export function validateLostResultDates(values: Pick<LostResultFilterValues, 'from' | 'to'>): string | null {
  const from = values.from.replaceAll('/', '-')
  const to = values.to.replaceAll('/', '-')
  if ((values.from && !isValidLostResultDate(from)) || (values.to && !isValidLostResultDate(to))) return '날짜를 올바르게 선택해 주세요.'
  return from && to && from > to ? '종료일을 시작일 이후로 선택해 주세요.' : null
}

/**
 * 직접 찾기에서 자연어로 읽은 기간과 사용자가 고른 기간을 합친다.
 * 사용자가 필터를 지워 날짜 키가 사라졌다고 바로 AI 기간을 다시 넣지 않도록
 * '지웠음(aiPeriodOff)' 신호를 함께 받는다.
 */
export function resolveAiDateFilters(
  params: URLSearchParams,
  aiDates: { from: string; to: string },
  aiPeriodOff = false,
): { from: string; to: string } {
  const values = readLostResultFilters(params)
  if (aiPeriodOff) return { from: values.from, to: values.to }
  return { from: values.from || aiDates.from, to: values.to || aiDates.to }
}

export function lostResultFilterLabel(key: LostResultFilterKey, value: string): string {
  return key === 'view' ? REFERENCE_PHOTO_VIEWS.find(option => option.value === value)?.label ?? '전체 방향' : value
}

/** Candidate directions are explicit sample/source metadata, not query-photo labels. */
export function filterCandidateRecords<T extends Candidate>(items: readonly T[], params: URLSearchParams): T[] {
  const filters = readLostResultFilters(params)
  if (validateLostResultDates(filters)) return []
  return items.filter(item => {
    // API 분류는 '지갑 > 여성용 지갑' 형태라 대분류만 고르면 하위 분류까지 포함한다.
    const categoryMatches = !filters.category || item.category === filters.category
      || (!filters.category.includes(' > ') && item.category.startsWith(filters.category + ' >'))
    const view = item.photoView && isPhotoView(item.photoView) ? item.photoView : 'unspecified'
    const hasDate = !!item.foundAt && isValidLostResultDate(item.foundAt)
    return (categoryMatches)
      && (!filters.color || item.color === filters.color)
      && (!filters.region || item.region === filters.region || !!item.foundPlace?.startsWith(filters.region))
      && (!filters.from || hasDate && item.foundAt! >= filters.from)
      && (!filters.to || hasDate && item.foundAt! <= filters.to)
      && (!filters.view || view === filters.view)
  })
}

function parseSourceState(value: string | null): SourceState | undefined {
  if (value === 'needs_confirmation' || value === 'needs-confirmation') return 'confirmation'
  return value && ['success', 'empty', 'error', 'loading', 'confirmation'].includes(value) ? value as SourceState : undefined
}

function sourceState(params: URLSearchParams, channel: 'image' | 'context', count?: number): SourceState {
  const explicit = parseSourceState(params.get(channel + 'State'))
  const state = params.get('state') ?? 'success'
  let result: SourceState
  if (explicit) result = explicit
  else if (state === 'loading' || state === channel + '-loading') result = 'loading'
  else if (state === 'empty' || state === channel + '-empty') result = 'empty'
  else if (['error', 'timeout', 'api-error'].includes(state) || state === channel + '-error' || state === 'partial-' + channel || state === 'model-error' && channel === 'image') result = 'error'
  else if (['interpretation-error', 'needs-confirmation', 'needs_confirmation', 'consent-required'].includes(state)) result = 'confirmation'
  else result = 'success'
  return result === 'success' && count !== undefined && (!Number.isFinite(count) || count <= 0) ? 'empty' : result
}

/** Counts refer to the filtered sources; incomplete zero results are never normal empty. */
export function lostResultChannelState(params: URLSearchParams, channel: LostResultChannel, counts?: LostResultCounts): LostResultState {
  if (channel !== 'combined') return sourceState(params, channel, counts?.[channel])
  const state = params.get('state') ?? ''
  const explicit = params.get('combinedState')
  const override = parseSourceState(explicit)
  if (override && override !== 'success') return override
  if (state === 'combined-error') return 'error'
  if (state === 'combined-empty') return 'empty'
  if (state === 'combined-loading') return 'loading'
  const image = sourceState(params, 'image', counts?.image)
  const context = sourceState(params, 'context', counts?.context)
  const states = [image, context]
  const available = states.includes('success')
  const incomplete = states.some(value => value !== 'success' && value !== 'empty')
  if (available) return incomplete || explicit === 'partial' ? 'partial' : 'success'
  if (states.includes('error')) return 'error'
  if (states.includes('confirmation')) return 'confirmation'
  if (states.includes('loading')) return 'loading'
  return 'empty'
}

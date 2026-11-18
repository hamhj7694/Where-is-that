import type { Candidate } from './catalog-model'
import { REFERENCE_PHOTO_VIEWS, type ReferencePhotoView } from './model'

export const LOST_RESULT_CHANNELS = ['combined', 'image', 'context'] as const
export type LostResultChannel = typeof LOST_RESULT_CHANNELS[number]
export type LostResultState = 'success' | 'partial' | 'empty' | 'error' | 'loading' | 'confirmation'
type SourceState = Exclude<LostResultState, 'partial'>
export interface LostResultCounts { image: number; context: number }

export const LOST_RESULT_FILTER_NAMES = {
  category: '물품 분류', color: '색상', region: '습득지역',
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
  if ((values.from && !isValidLostResultDate(values.from)) || (values.to && !isValidLostResultDate(values.to))) return '날짜를 올바르게 선택해 주세요.'
  return values.from && values.to && values.from > values.to ? '종료일을 시작일 이후로 선택해 주세요.' : null
}

export function lostResultFilterLabel(key: LostResultFilterKey, value: string): string {
  return key === 'view' ? REFERENCE_PHOTO_VIEWS.find(option => option.value === value)?.label ?? '전체 방향' : value
}

/** Candidate directions are explicit sample/source metadata, not query-photo labels. */
export function filterCandidateRecords<T extends Candidate>(items: readonly T[], params: URLSearchParams): T[] {
  const filters = readLostResultFilters(params)
  if (validateLostResultDates(filters)) return []
  return items.filter(item => {
    const view = item.photoView && isPhotoView(item.photoView) ? item.photoView : 'unspecified'
    const hasDate = !!item.foundAt && isValidLostResultDate(item.foundAt)
    return (!filters.category || item.category === filters.category)
      && (!filters.color || item.color === filters.color)
      && (!filters.region || !!item.foundPlace?.startsWith(filters.region))
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

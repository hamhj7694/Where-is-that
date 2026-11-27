import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, ChevronDown, SlidersHorizontal, X } from 'lucide-react'
import { REFERENCE_PHOTO_VIEWS } from '../search/model'
import { REGIONS } from '../search/lostfound-api'
import { LOST_RESULT_FILTER_NAMES, lostResultFilterLabel, readLostResultFilters, validateLostResultDates, type LostResultFilterKey, type LostResultFilterValues } from '../search/lost-result-model'

const allKeys = Object.keys(LOST_RESULT_FILTER_NAMES) as LostResultFilterKey[]
// 경찰청 검색 응답의 prdtClNm('대분류 > 소분류')에서 확인한 분류 기준.
const CATEGORY_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['가방', ['기타가방', '남성용가방', '여성용가방']],
  ['귀금속', ['귀걸이', '기타', '목걸이', '반지', '시계']],
  ['기타물품', ['기타', '매장문화재', '선글라스', '안경']],
  ['도서용품', ['기타서적', '소설', '학습서적']],
  ['무주물', ['무주물']],
  ['산업용품', ['기타물품']],
  ['서류', ['기타물품', '서류']],
  ['쇼핑백', ['쇼핑백']],
  ['스포츠용품', ['스포츠용품']],
  ['악기', ['기타악기']],
  ['유가증권', ['기타']],
  ['유류품', ['유류품']],
  ['의류', ['기타의류', '남성의류', '모자', '신발', '아기의류', '여성의류']],
  ['자동차', ['기타용품', '자동차열쇠']],
  ['전자기기', ['기타용품', '무선이어폰', '스마트워치', '태블릿']],
  ['증명서', ['기타', '면허증', '신분증', '여권']],
  ['지갑', ['기타 지갑', '남성용 지갑', '여성용 지갑']],
  ['카드', ['교통카드', '기타카드', '신용(체크)카드', '일반카드']],
  ['현금', ['현금']],
  ['휴대폰', ['기타통신기기', '기타휴대폰', '삼성휴대폰', '아이폰']],
]
const CATEGORY_VALUES = CATEGORY_GROUPS.flatMap(([major, minors]) => [major, ...minors.map(minor => major + ' > ' + minor)])
const allLabels = { category: '전체 분류', color: '전체 색상', region: '전체 지역' }
// 날짜 입력 라벨에만 범위 의미를 덧붙인다(다른 화면 라벨은 그대로).
const fieldLabels: Partial<Record<LostResultFilterKey, string>> = {
  from: '시작일 (이 날짜부터)',
  to: '종료일 (이 날짜까지)',
}
const labelOf = (key: LostResultFilterKey, compact = false) => {
  if (compact && key === 'from') return '습득 시작일'
  if (compact && key === 'to') return '습득 종료일'
  return fieldLabels[key] ?? LOST_RESULT_FILTER_NAMES[key]
}
const empty = (): LostResultFilterValues => ({ category: '', color: '', region: '', from: '', to: '', view: '' })

interface FilterOption {
  value: string
  label: string
}

interface FilterSelectProps {
  id: string
  label: string
  value: string
  options: readonly FilterOption[]
  onChange: (value: string) => void
  buttonRef?: RefObject<HTMLButtonElement | null>
  className?: string
}

function FilterSelect({ id, label, value, options, onChange, buttonRef, className = '' }: FilterSelectProps) {
  const [open, setOpen] = useState(false)
  const [maxHeight, setMaxHeight] = useState(280)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const listboxId = id + '-options'

  useEffect(() => {
    if (!open) return
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  function openAt(index: number) {
    const rect = trigger.current?.getBoundingClientRect()
    if (rect) setMaxHeight(Math.max(96, Math.min(280, window.innerHeight - rect.bottom - 12)))
    setOpen(true)
    requestAnimationFrame(() => optionRefs.current[index]?.focus())
  }

  function choose(index: number) {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  function focusOption(index: number) {
    const next = Math.max(0, Math.min(options.length - 1, index))
    optionRefs.current[next]?.focus()
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusOption(index + 1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption(index - 1) }
    else if (event.key === 'Home') { event.preventDefault(); focusOption(0) }
    else if (event.key === 'End') { event.preventDefault(); focusOption(options.length - 1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(index) }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
  }

  return <div
    ref={root}
    className={'filter-field filter-field--custom ' + className + (open ? ' is-open' : '')}
    onBlur={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}
  >
    <label htmlFor={id}>{label}</label>
    <button
      ref={element => {
        trigger.current = element
        if (buttonRef) buttonRef.current = element
      }}
      id={id}
      type="button"
      className="filter-select__trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      onClick={() => open ? setOpen(false) : openAt(selectedIndex)}
      onKeyDown={event => {
        if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault()
          openAt(selectedIndex)
        }
      }}
    >
      <span>{options[selectedIndex]?.label ?? ''}</span><ChevronDown aria-hidden="true" />
    </button>
    {open && <div id={listboxId} className="filter-select__menu" role="listbox" aria-label={label} style={{ maxHeight }}>
      {options.map((option, index) => <button
        key={option.value || 'all'}
        ref={element => { optionRefs.current[index] = element }}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={value === option.value}
        className="filter-select__option"
        onClick={() => choose(index)}
        onKeyDown={event => handleOptionKeyDown(event, index)}
      >{option.label}</button>)}
    </div>}
  </div>
}

const categoryOptions: FilterOption[] = [
  { value: '', label: '전체 분류' },
  ...CATEGORY_GROUPS.flatMap(([major, minors]) => [
    { value: major, label: '전체 ' + major },
    ...minors.map(minor => ({ value: major + ' > ' + minor, label: major + ' · ' + minor })),
  ]),
]

function formatDateInput(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 8)
  if (digits.length > 6) return digits.slice(0, 4) + '/' + digits.slice(4, 6) + '/' + digits.slice(6)
  if (digits.length > 4) return digits.slice(0, 4) + '/' + digits.slice(4)
  return digits
}

interface Props {
  alwaysOpen?: boolean
  compact?: boolean
  colorOptions?: readonly string[]
  showDirection?: boolean
  customDropdowns?: boolean
  toolbarActions?: ReactNode
}

export default function LostResultFilters({
  alwaysOpen = false,
  compact = false,
  colorOptions,
  showDirection = true,
  customDropdowns = false,
  toolbarActions,
}: Props) {
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const isOpen = alwaysOpen || open
  const [values, setValues] = useState<LostResultFilterValues>(() => readLostResultFilters(params))
  const [error, setError] = useState('')
  const hasColorFilter = colorOptions !== undefined
  const colors = colorOptions ?? []
  const keys = allKeys.filter(key => (key !== 'color' || hasColorFilter) && (key !== 'view' || showDirection))
  const trigger = useRef<HTMLButtonElement>(null)
  const firstSelect = useRef<HTMLSelectElement>(null)
  const firstCustomSelect = useRef<HTMLButtonElement>(null)
  const datePickers = useRef<Record<'from' | 'to', HTMLInputElement | null>>({ from: null, to: null })
  const prefix = useId()
  const panelId = prefix + '-panel'
  const formId = prefix + '-form'
  const applied = readLostResultFilters(params)
  const active = keys.filter(key => applied[key])
  const activeValueLabel = (key: LostResultFilterKey) => compact && (key === 'from' || key === 'to')
    ? applied[key].replaceAll('-', '/')
    : lostResultFilterLabel(key, applied[key])

  // 값이 있는 화면에서만 색상·방향 필터를 유지한다.
  useEffect(() => {
    if ((hasColorFilter || !params.has('color')) && (showDirection || !params.has('view'))) return
    const next = new URLSearchParams(params)
    if (!hasColorFilter) next.delete('color')
    if (!showDirection) next.delete('view')
    setParams(next, { replace: true })
  }, [hasColorFilter, params, setParams, showDirection])

  useEffect(() => {
    if (alwaysOpen || !open) setValues(readLostResultFilters(params))
  }, [alwaysOpen, open, params])

  function toggle() {
    if (alwaysOpen) return
    const next = !open
    if (next) { setValues(readLostResultFilters(params)); setError('') }
    setOpen(next)
    if (next) setTimeout(() => (customDropdowns ? firstCustomSelect.current : firstSelect.current)?.focus(), 0)
  }
  function close() {
    if (alwaysOpen) return
    setOpen(false)
    setTimeout(() => trigger.current?.focus(), 0)
  }
  function remove(key: LostResultFilterKey) {
    const next = new URLSearchParams(params)
    next.delete(key); next.delete('page'); setParams(next)
    setTimeout(() => trigger.current?.focus(), 0)
  }
  function reset() {
    setValues(empty())
    setError('')
    const next = new URLSearchParams(params)
    for (const key of keys) next.delete(key)
    next.delete('page')
    setParams(next)
    if (alwaysOpen) {
      setTimeout(() => (customDropdowns ? firstCustomSelect.current : firstSelect.current)?.focus(), 0)
      return
    }
    setOpen(false)
    setTimeout(() => trigger.current?.focus(), 0)
  }
  function apply(event: FormEvent) {
    event.preventDefault()
    const problem = validateLostResultDates(values)
    if (problem) { setError(problem); return }
    const next = new URLSearchParams(params)
    for (const key of keys) {
      const value = key === 'from' || key === 'to' ? values[key].replaceAll('/', '-') : values[key]
      if (value) next.set(key, value)
      else next.delete(key)
    }
    if (!hasColorFilter) next.delete('color')
    if (!showDirection) next.delete('view')
    next.delete('page'); setParams(next); close()
  }
  const selectProps = (key: LostResultFilterKey) => ({
    id: prefix + key,
    value: values[key],
    onChange: (event: ChangeEvent<HTMLSelectElement>) => { setValues(previous => ({ ...previous, [key]: event.target.value })); setError('') },
  })
  const changeValue = (key: LostResultFilterKey, value: string) => {
    setValues(previous => ({ ...previous, [key]: value }))
    setError('')
  }
  const colorFilterOptions: FilterOption[] = [
    { value: '', label: allLabels.color },
    ...(values.color && !colors.includes(values.color) ? [{ value: values.color, label: values.color }] : []),
    ...colors.map(color => ({ value: color, label: color })),
  ]
  const regionFilterOptions: FilterOption[] = [
    { value: '', label: allLabels.region },
    ...(values.region && !REGIONS.includes(values.region as typeof REGIONS[number]) ? [{ value: values.region, label: values.region }] : []),
    ...REGIONS.map(region => ({ value: region, label: region })),
  ]
  const categoryFilterOptions = values.category && !CATEGORY_VALUES.includes(values.category)
    ? [...categoryOptions, { value: values.category, label: values.category }]
    : categoryOptions
  const dateField = (key: 'from' | 'to', className = 'filter-field') => <div className={className} key={key}>
    <label htmlFor={prefix + key}>{labelOf(key, compact)}</label>
    {compact ? <div className="filter-date-input">
      <input
        id={prefix + key}
        type="text"
        inputMode="numeric"
        maxLength={10}
        placeholder="YYYY/MM/DD"
        value={values[key].replaceAll('-', '/')}
        onChange={event => changeValue(key, formatDateInput(event.target.value))}
      />
      <button
        type="button"
        className="filter-date-input__calendar"
        aria-label={labelOf(key, compact) + ' 달력 열기'}
        onClick={() => {
          const picker = datePickers.current[key]
          if (!picker) return
          if (typeof picker.showPicker === 'function') picker.showPicker()
          else picker.focus()
        }}
      ><CalendarDays aria-hidden="true" /></button>
      <input
        ref={element => { datePickers.current[key] = element }}
        type="date"
        className="visually-hidden"
        tabIndex={-1}
        aria-label={labelOf(key, compact) + ' 날짜 선택'}
        value={values[key]}
        onChange={event => changeValue(key, event.target.value)}
      />
    </div> : <input
      id={prefix + key}
      type="date"
      value={values[key]}
      onChange={event => changeValue(key, event.target.value)}
    />}
  </div>

  return <>
    {alwaysOpen && <p className="search-section-title">검색 조건</p>}
    {(!alwaysOpen || active.length > 0 || toolbarActions) && <div className={'filter-bar' + (isOpen ? ' filter-bar--with-panel' : '')}>
      {!alwaysOpen && <button ref={trigger} type="button" className="filter-chip filter-chip--accordion" aria-expanded={isOpen} aria-controls={panelId} onClick={toggle}>
        <SlidersHorizontal aria-hidden="true" />검색 조건{active.length > 0 && <span>{active.length}</span>}
        <ChevronDown className={'filter-chevron' + (isOpen ? ' is-open' : '')} aria-hidden="true" />
      </button>}
      {compact && !alwaysOpen && <div className="filter-bar__actions">
        <button type="button" className="button button--secondary" onClick={reset}>초기화</button>
        <button type="submit" form={formId} className={'button ' + (isOpen ? 'button--primary' : 'button--secondary')}>조건 적용</button>
      </div>}
      {active.map(key => <button type="button" className="filter-chip" key={key} onClick={() => remove(key)} aria-label={labelOf(key, compact) + ' ' + activeValueLabel(key) + ' 해제'}>{activeValueLabel(key)}<X aria-hidden="true" /></button>)}
      {toolbarActions}
    </div>}
    <section id={panelId} className="filter-accordion" data-open={isOpen} aria-label="검색 조건" inert={!isOpen}>
      <div className="filter-accordion__inner">
        <form id={formId} className="filter-accordion__form" onSubmit={apply}>
          <div className="filter-accordion__grid">
            {customDropdowns
              ? <FilterSelect id={prefix + 'category'} label={labelOf('category')} value={values.category} options={categoryFilterOptions} onChange={value => changeValue('category', value)} buttonRef={firstCustomSelect} className="filter-field--wide" />
              : <div className="filter-field filter-field--wide">
                  <label htmlFor={prefix + 'category'}>{labelOf('category')}</label>
                  <select {...selectProps('category')} ref={firstSelect}><option value="">{allLabels.category}</option>
                    {values.category && !CATEGORY_VALUES.includes(values.category) && <option value={values.category}>{values.category}</option>}
                    {CATEGORY_GROUPS.map(([major, minors]) => <optgroup label={major} key={major}>
                      <option value={major}>전체 {major}</option>
                      {minors.map(minor => <option key={minor} value={major + ' > ' + minor}>{minor}</option>)}
                    </optgroup>)}
                  </select>
                </div>}
            {customDropdowns
              ? <FilterSelect id={prefix + 'region'} label={labelOf('region')} value={values.region} options={regionFilterOptions} onChange={value => changeValue('region', value)} className="filter-field--wide" />
              : <div className="filter-field filter-field--wide">
                  <label htmlFor={prefix + 'region'}>{labelOf('region')}</label>
                  <select {...selectProps('region')}><option value="">{allLabels.region}</option>
                    {values.region && !REGIONS.some(region => region === values.region) && <option value={values.region}>{values.region}</option>}
                    {REGIONS.map(region => <option key={region} value={region}>{region}</option>)}
                  </select>
                </div>}
            {hasColorFilter && (customDropdowns
              ? <FilterSelect id={prefix + 'color'} label={labelOf('color')} value={values.color} options={colorFilterOptions} onChange={value => changeValue('color', value)} className="filter-field--wide" />
              : <div className="filter-field filter-field--wide">
                  <label htmlFor={prefix + 'color'}>{labelOf('color')}</label>
                  <select {...selectProps('color')}><option value="">{allLabels.color}</option>
                    {values.color && !colors.includes(values.color) && <option value={values.color}>{values.color}</option>}
                    {colors.map(color => <option key={color} value={color}>{color}</option>)}
                  </select>
                </div>)}
            {showDirection && <div className="filter-field filter-field--wide">
              <label htmlFor={prefix + 'view'}>{labelOf('view')}</label>
              <select {...selectProps('view')}><option value="">전체 방향</option>{REFERENCE_PHOTO_VIEWS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </div>}
            {compact
              ? <div className="filter-date-range">{(['from', 'to'] as const).map(key => dateField(key))}</div>
              : (['from', 'to'] as const).map(key => dateField(key, 'filter-field filter-field--date'))}
          </div>
          {(!compact || error) && <div className="filter-accordion__footer">
            <div className="filter-accordion__help">
              {!compact && <>
                <p>방향은 샘플 사진 정보에 적용돼요.</p>
                <p>분류는 경찰청 공개 분류, 지역은 보관기관 위치, 날짜는 습득일 기준이에요.</p>
              </>}
              {error && <p role="alert" className="form-error">{error}</p>}
            </div>
            {!compact && <div className="filter-accordion__actions">
              <button type="button" className="button button--secondary" onClick={reset}>초기화</button>
              <button type="submit" className="button button--primary">조건 적용</button>
            </div>}
          </div>}
        </form>
      </div>
    </section>
  </>
}

import { useId, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SlidersHorizontal, X } from 'lucide-react'
import Modal from '../../components/Modal'
import { REFERENCE_PHOTO_VIEWS } from '../search/model'
import { LOST_RESULT_FILTER_NAMES, lostResultFilterLabel, readLostResultFilters, validateLostResultDates, type LostResultFilterKey, type LostResultFilterValues } from '../search/lost-result-model'

const keys = Object.keys(LOST_RESULT_FILTER_NAMES) as LostResultFilterKey[]
const options = { category: ['지갑', '가방', '열쇠'], color: ['검정', '남색', '노랑', '은색'], region: ['서울', '경기'] } as const
const allLabels = { category: '전체 분류', color: '모든 색상', region: '전체 지역' }
const empty = (): LostResultFilterValues => ({ category: '', color: '', region: '', from: '', to: '', view: '' })

export default function LostResultFilters() {
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState(empty)
  const [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const prefix = useId()
  const applied = readLostResultFilters(params)
  const active = keys.filter(key => applied[key])
  function show() { setValues(readLostResultFilters(params)); setError(''); setOpen(true) }
  function remove(key: LostResultFilterKey) { const next = new URLSearchParams(params); next.delete(key); next.delete('page'); setParams(next); requestAnimationFrame(() => trigger.current?.focus()) }
  function apply(event: FormEvent) {
    event.preventDefault()
    const problem = validateLostResultDates(values)
    if (problem) { setError(problem); return }
    const next = new URLSearchParams(params)
    for (const key of keys) { if (values[key]) next.set(key, values[key]); else next.delete(key) }
    next.delete('page'); setParams(next); setOpen(false)
  }
  return <><div className="filter-bar"><button ref={trigger} type="button" className="filter-chip" aria-haspopup="dialog" onClick={show}><SlidersHorizontal aria-hidden="true" />검색 조건{active.length > 0 && <span>{active.length}</span>}</button>
    {active.map(key => <button type="button" className="filter-chip" key={key} onClick={() => remove(key)} aria-label={LOST_RESULT_FILTER_NAMES[key] + ' ' + lostResultFilterLabel(key, applied[key]) + ' 해제'}>{lostResultFilterLabel(key, applied[key])}<X aria-hidden="true" /></button>)}</div>
    <Modal open={open} title="검색 조건" focusKey="lost-result-filters" onClose={() => setOpen(false)}><form onSubmit={apply}>
      {(['category', 'color', 'region'] as const).map(key => <div className="field" key={key}><label htmlFor={prefix + key}>{LOST_RESULT_FILTER_NAMES[key]}</label><select id={prefix + key} value={values[key]} onChange={event => { setValues(previous => ({ ...previous, [key]: event.target.value })); setError('') }}><option value="">{allLabels[key]}</option>
        {values[key] && !options[key].some(value => value === values[key]) && <option value={values[key]}>{values[key]}</option>}
        {options[key].map(value => <option key={value}>{value}</option>)}</select></div>)}
      <div className="field"><label htmlFor={prefix + 'view'}>사물 방향</label><select id={prefix + 'view'} value={values.view} onChange={event => setValues(previous => ({ ...previous, view: event.target.value }))}><option value="">전체 방향</option>{REFERENCE_PHOTO_VIEWS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
      <p className="field__help">방향은 샘플 사진 정보에 적용돼요.</p>
      <div className="form-pair">{(['from', 'to'] as const).map(key => <div className="field" key={key}><label htmlFor={prefix + key}>{LOST_RESULT_FILTER_NAMES[key]}</label><input id={prefix + key} type="date" value={values[key]} onChange={event => { setValues(previous => ({ ...previous, [key]: event.target.value })); setError('') }} /></div>)}</div>
      {error && <p role="alert" className="form-error">{error}</p>}<p className="field__help">샘플 기록에 적용돼요.</p><div className="button-row"><button type="button" className="button button--secondary" onClick={() => { setValues(empty()); setError('') }}>초기화</button><button type="submit" className="button button--primary">조건 적용</button></div>
    </form></Modal></>
}

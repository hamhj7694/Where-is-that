import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { ArrowUp, Pencil, Trash2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { addGalleryCondition, editGalleryCondition, galleryConditionsChanged, removeGalleryCondition, type GalleryAssistantState } from '../search/gallery-search-model'
import { canSubmitWithEnter } from '../search/model'
import { localAssistantUpdate, prepareOptimizedAssistant } from '../search/query-optimizer'

interface Props {
  id: string
  wide: boolean
  hideHeading?: boolean
  mode?: 'gallery' | 'lost'
  baseQuery?: string
  state: GalleryAssistantState
  inputRef: RefObject<HTMLTextAreaElement | null>
  onChange: (patch: Partial<GalleryAssistantState>) => void
  onClose: () => void
  onApply?: (state: GalleryAssistantState) => void
}

const prompts = [
  { label: '색상', text: '색상: ' },
  { label: '촬영 시기', text: '촬영 시기: ' },
  { label: '사진 속 글자', text: '사진 속 글자: ' },
]

export default function GallerySearchAssistant({ id, wide, hideHeading = false, mode = 'gallery', baseQuery = '', state, inputRef, onChange, onClose, onApply }: Props) {
  const log = useRef<HTMLDivElement>(null)
  const conditionInput = useRef<HTMLTextAreaElement>(null)
  const [feedback, setFeedback] = useState('')
  const [editing, setEditing] = useState<{ original: string; text: string } | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const conditionPrompts = mode === 'lost' ? [{ label: '물건 특징', text: '물건 특징: ' }, { label: '분실 시기', text: '분실 시기: ' }, { label: '분실 장소', text: '분실 장소: ' }] : prompts
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [state.messages.length])

  function addCondition(event?: FormEvent) {
    event?.preventDefault()
    if (!onApply) return
    const next = addGalleryCondition(state, state.draft)
    if (next === state) { setFeedback(state.draft.trim() ? '이미 추가한 조건이에요.' : '추가할 조건을 적어 주세요.'); return }
    onChange({ ...next, aiPlan: null, optimizedQuery: undefined }); setFeedback('')
    inputRef.current?.focus()
  }

  async function applyConditions() {
    if (!onApply || optimizing || editing) return
    setOptimizing(true); setFeedback('')
    try {
      const next = await prepareOptimizedAssistant(mode, state, baseQuery)
      onChange(next)
      onApply(next)
      setFeedback('검색 문구를 한 문장으로 다듬어 검색어에 담았어요.')
    } catch {
      const next = localAssistantUpdate(state)
      onChange(next)
      onApply(next)
      setFeedback('새 문구를 만들지 못해 적어 둔 조건을 그대로 반영했어요.')
    } finally {
      setOptimizing(false)
    }
  }

  function cancelConditionEdit() {
    setEditing(null); setFeedback('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  function saveCondition(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    if (!editing.text.trim()) { setFeedback('수정할 조건을 적어 주세요.'); return }
    const index = state.conditions.indexOf(editing.original)
    const next = editGalleryCondition(state, index, editing.text)
    if (next === state && editing.text.trim() !== editing.original) { setFeedback('같은 조건이 이미 있어요.'); return }
    onChange({ ...next, aiPlan: null, optimizedQuery: undefined }); setEditing(null); setFeedback('조건을 수정했어요.')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return <aside id={id} className="gallery-assistant" role={wide ? 'complementary' : 'region'} aria-labelledby={hideHeading ? undefined : id + '-title'} aria-label={hideHeading ? '검색 조건 도우미' : undefined}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    {!hideHeading && <header className="gallery-assistant__heading"><h2 id={id + '-title'}>검색 도우미</h2><button type="button" className="icon-button" aria-label="검색 도우미 닫기" onClick={onClose}><X aria-hidden="true" /></button></header>}
    <p className="gallery-assistant__notice">기억나는 특징을 더하면 적어둔 내용과 함께 검색어에 반영해요.</p>
    <div className="gallery-assistant__body" ref={log} role="log" tabIndex={0} aria-label="현재 검색의 추가 조건" aria-live="polite" aria-relevant="additions">
      {!state.conditions.length && <p className="gallery-assistant__intro">{state.appliedConditions?.length ? '추가 조건을 모두 뺐어요.' : mode === 'lost' ? '기억나는 특징·분실 시기·장소를 더해 보세요.' : '기억나는 색상·시기·글자를 더해 보세요.'}</p>}
      {state.conditions.map((condition, index) => <div className="gallery-assistant__condition" key={condition}>
        {editing?.original === condition ? <form className="gallery-assistant__condition-editor" onSubmit={saveCondition}
          onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); cancelConditionEdit() } }}>
          <label htmlFor={id + '-condition'}>조건 수정</label><textarea id={id + '-condition'} ref={conditionInput} rows={3} maxLength={400} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} />
          <div className="gallery-assistant__condition-actions"><button type="button" onClick={cancelConditionEdit}>취소</button><button type="submit">저장</button></div>
        </form> : <><p>{condition}</p><div className="gallery-assistant__condition-actions">
          <button type="button" aria-label={'추가 조건 ' + (index + 1) + ' 수정'} onClick={() => { setEditing({ original: condition, text: condition }); setFeedback(''); requestAnimationFrame(() => conditionInput.current?.focus()) }}><Pencil aria-hidden="true" />수정</button>
          <button type="button" aria-label={'추가 조건 ' + (index + 1) + ' 삭제'} onClick={() => { if (editing?.original === condition) setEditing(null); onChange({ ...removeGalleryCondition(state, index), aiPlan: null, optimizedQuery: undefined }); setFeedback('조건을 뺐어요.'); requestAnimationFrame(() => inputRef.current?.focus()) }}><Trash2 aria-hidden="true" />삭제</button>
        </div></>}
      </div>)}
      {galleryConditionsChanged(state) && <p className="gallery-assistant__pending">다시 검색하면 반영돼요.</p>}
    </div>
    {onApply ? <>
      <div className="gallery-assistant__prompts" aria-label="조건 작성 도움">{conditionPrompts.map(prompt => <button type="button" key={prompt.label} disabled={!!editing} onClick={() => {
        const next = state.draft + (state.draft && !state.draft.endsWith('\n') ? '\n' : '') + prompt.text
        if (next.length > 400) { setFeedback('조건은 400자까지 적을 수 있어요.'); inputRef.current?.focus(); return }
        onChange({ draft: next, aiPlan: null, optimizedQuery: undefined }); setFeedback(''); requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.length, next.length) })
      }}>{prompt.label}</button>)}</div>
      <form className="gallery-assistant__composer" onSubmit={addCondition}>
        <label htmlFor={id + '-input'}>추가할 조건</label>
        <textarea id={id + '-input'} ref={inputRef} value={state.draft} rows={3} maxLength={400} disabled={!!editing} placeholder={mode === 'lost' ? '예: 앞면에 작은 금색 로고가 있어요' : '예: 파란 바다가 보이는 사진'} onChange={event => { onChange({ draft: event.target.value, aiPlan: null, optimizedQuery: undefined }); setFeedback('') }}
          onKeyDown={event => { if (canSubmitWithEnter(event.nativeEvent)) { event.preventDefault(); addCondition() } }} />
        <button type="submit" className="button button--secondary" aria-label="조건 추가" title="조건 추가" disabled={!!editing || !state.draft.trim()}><ArrowUp aria-hidden="true" /></button>
      </form>
      {(galleryConditionsChanged(state) || !!state.optimizedQuery) && <button type="button" className="button button--primary gallery-assistant__apply" disabled={!!editing || optimizing} onClick={() => void applyConditions()}>
        {optimizing ? '검색 문구를 다듬고 있어요…' : '새 문구로 다시 검색'}
      </button>}
    </> : <Link className="button button--secondary" to={mode === 'lost' ? '/lost-found' : '/gallery'}>검색 입력으로</Link>}
    <p className="gallery-assistant__feedback" role="status">{feedback}</p>
  </aside>
}

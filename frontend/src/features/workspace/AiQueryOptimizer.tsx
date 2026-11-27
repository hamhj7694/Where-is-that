import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { AiPipelineMode } from '../search/ai-search-api'
import type { GalleryAssistantState } from '../search/gallery-search-model'
import { localAssistantUpdate, prepareEditedAssistant, prepareOptimizedAssistant } from '../search/query-optimizer'

interface Props {
  mode: AiPipelineMode
  baseQuery: string
  state: GalleryAssistantState
  onChange: (patch: Partial<GalleryAssistantState>) => void
  onApply: (state: GalleryAssistantState) => void
  disabled?: boolean
  renderInline?: (action: ReactNode, feedback: ReactNode) => ReactNode
}

/** 검색 결과 화면 본문에 두는 AI 문구 생성기. 도우미 패널 안에는 해석 버튼·결과를 두지 않는다. */
export default function AiQueryOptimizer({ mode, baseQuery, state, onChange, onApply, disabled = false, renderInline }: Props) {
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<{ base: string; suggestion: string; text: string } | null>(null)
  const editorId = useId()
  const panelId = editorId + '-panel'
  const applyRequest = useRef<AbortController | null>(null)
  const suggestion = state.optimizedQuery ?? ''
  const editable = mode === 'lost'
  const text = editable && edit?.base === baseQuery && edit.suggestion === suggestion ? edit.text : suggestion

  useEffect(() => () => applyRequest.current?.abort(), [baseQuery, suggestion])

  async function optimize() {
    if (busy || applying || disabled) return
    setBusy(true); setError('')
    try {
      const next = await prepareOptimizedAssistant(mode, state, baseQuery)
      setEdit(null)
      onChange(next)
    } catch {
      if (editable && suggestion) {
        setError('새 추천 문구를 만들지 못했어요. 지금 문구로 다시 검색할 수 있어요.')
      } else {
        onChange(localAssistantUpdate(state))
        setError('문구를 만들지 못했어요. 적어 둔 조건으로 그대로 다시 검색할 수 있어요.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    const query = text.trim()
    if (!query || busy || disabled || applyRequest.current) return
    if (!editable || query === suggestion.trim()) {
      setExpanded(false)
      onApply(state)
      return
    }
    const request = new AbortController()
    applyRequest.current = request
    setApplying(true)
    try {
      const next = await prepareEditedAssistant(mode, state, query)
      if (!request.signal.aborted) {
        setEdit(null)
        setExpanded(false)
        onApply(next)
      }
    } finally {
      applyRequest.current = null
      setApplying(false)
    }
  }

  const action = editable
    ? <button type="button" className="text-button query-optimizer__action" disabled={disabled} aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined} onClick={() => setExpanded(value => !value)}>
        <Sparkles aria-hidden="true" />AI로 검색어 다듬기<ChevronDown className="query-optimizer__chevron" aria-hidden="true" />
      </button>
    : <button type="button" className="button button--secondary" disabled={busy || applying || disabled} onClick={() => void optimize()}>
        <Sparkles aria-hidden="true" />{busy ? '다듬는 중…' : '다듬어 보기'}
      </button>
  const applyButton = <button type="button" className="button button--primary" disabled={busy || applying || disabled || !text.trim()} onClick={() => void apply()}>
    {applying ? '다시 검색 준비 중…' : '이 문구로 다시 검색'}
  </button>
  const errorMessage = error && <p className="form-error" role="alert">{error}</p>
  const feedback = editable ? expanded && <div id={panelId} className="query-optimizer__result">
      <div className="query-optimizer__panel-head">
        <strong>다듬은 검색 문구</strong>
        <button type="button" className="button button--secondary" disabled={busy || applying || disabled} onClick={() => void optimize()}>
          {busy ? '다듬는 중…' : suggestion ? '추천 문구 다시 만들기' : '추천 문구 만들기'}
        </button>
      </div>
      {suggestion && <>
        <label htmlFor={editorId} className="visually-hidden">다듬은 검색 문구</label>
        <textarea id={editorId} rows={3} maxLength={300} value={text} readOnly={busy || applying || disabled}
          onChange={event => setEdit({ base: baseQuery, suggestion, text: event.target.value })} />
        {applyButton}
      </>}
      {errorMessage}
    </div> : (suggestion || error) && <>
      {suggestion && <div className="query-optimizer__result" role="status">
        <strong>다듬은 검색 문구</strong><p>{suggestion}</p>{applyButton}
      </div>}
      {errorMessage}
    </>

  if (renderInline) return renderInline(action, feedback)
  return <section className="query-optimizer" aria-label="검색어 다듬기">
    <div className="query-optimizer__head">
      <div><strong>검색어 다듬기</strong><p>기억나는 특징을 적어둔 내용과 함께 자연스럽게 정리해 줘요.</p></div>
      {action}
    </div>
    {feedback}
  </section>
}

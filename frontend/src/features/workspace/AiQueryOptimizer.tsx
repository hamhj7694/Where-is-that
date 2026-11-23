import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { AiPipelineMode } from '../search/ai-search-api'
import type { GalleryAssistantState } from '../search/gallery-search-model'
import { localAssistantUpdate, prepareOptimizedAssistant } from '../search/query-optimizer'

interface Props {
  mode: AiPipelineMode
  baseQuery: string
  state: GalleryAssistantState
  onChange: (patch: Partial<GalleryAssistantState>) => void
  onApply: (state: GalleryAssistantState) => void
  disabled?: boolean
}

/** 검색 결과 화면 본문에 두는 AI 문구 생성기. 도우미 패널 안에는 해석 버튼·결과를 두지 않는다. */
export default function AiQueryOptimizer({ mode, baseQuery, state, onChange, onApply, disabled = false }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function optimize() {
    if (busy || disabled) return
    setBusy(true); setError('')
    try {
      onChange(await prepareOptimizedAssistant(mode, state, baseQuery))
    } catch {
      onChange(localAssistantUpdate(state))
      setError('문구를 만들지 못했어요. 적어 둔 조건으로 그대로 다시 검색할 수 있어요.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="query-optimizer" aria-label="검색어 다듬기">
    <div className="query-optimizer__head">
      <div><strong>검색어 다듬기</strong><p>기억나는 특징을 적어둔 내용과 함께 자연스럽게 정리해 줘요.</p></div>
      <button type="button" className="button button--secondary" disabled={busy || disabled} onClick={() => void optimize()}>
        <Sparkles aria-hidden="true" />{busy ? '다듬는 중…' : '다듬어 보기'}
      </button>
    </div>
    {state.optimizedQuery && <div className="query-optimizer__result" role="status">
      <strong>다듬은 검색 문구</strong>
      <p>{state.optimizedQuery}</p>
      <button type="button" className="button button--primary" disabled={disabled} onClick={() => onApply(state)}>이 문구로 다시 검색</button>
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}

import { useRef, useState, type ClipboardEvent, type ReactNode, type RefObject } from 'react'
import { ImagePlus, Search, X } from 'lucide-react'
import { assertImageReadable, canSubmitWithEnter, clipboardImageFiles, getReferencePhotos, getReferencePhotoViews, MAX_LOST_REFERENCE_PHOTOS, REFERENCE_PHOTO_VIEWS, type ReferencePhotoView, type SearchDraft } from './model'
import { usePhotoPreview } from './usePhotoPreview'
import { copy } from './copy'
import LostReferenceDialog from './LostReferenceDialog'
import { localPhotoId } from '../workspace/data'
import { prepareAiSearch } from './ai-search-api'

function AttachedPhoto({ file, index, view, onEdit, onRemove }: { file: File; index: number; view: ReferencePhotoView; onEdit: (button: HTMLButtonElement) => void; onRemove: () => void }) {
  const source = usePhotoPreview(file)
  return <div className="lost-attachment"><div><button type="button" className="attachment__preview-button" aria-label={`참고 사진 ${index + 1} 편집`} aria-haspopup="dialog" onClick={event => onEdit(event.currentTarget)}>{source && <img src={source} alt={`참고 사진 ${index + 1}`} draggable={false} />}</button><span className="lost-attachment__view">{REFERENCE_PHOTO_VIEWS.find(option => option.value === view)?.label ?? '미지정'}</span></div>
    <button type="button" className="icon-button" aria-label={`참고 사진 ${index + 1} 삭제`} onClick={onRemove}><X aria-hidden="true" /></button></div>
}

interface Props {
  draft: SearchDraft; error: string; textareaRef: RefObject<HTMLTextAreaElement | null>
  onDraft: (patch: Partial<SearchDraft>) => void; onSubmit: (draft?: SearchDraft, autoRankConsent?: boolean) => void; onError: (message: string) => void
  initialAttachmentOpen?: boolean; submitLabel?: string; secondaryAction?: ReactNode
}

export default function LostSearchComposer({ draft, error, textareaRef, onDraft, onSubmit, onError, initialAttachmentOpen = false, submitLabel, secondaryAction }: Props) {
  const [editor, setEditor] = useState<{ selected: number; dropped: File[]; open?: boolean } | null>(initialAttachmentOpen ? { selected: 0, dropped: [] } : null)
  const [guideOpen, setGuideOpen] = useState(true)
  const [aiBusy, setAiBusy] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const composing = useRef(false)
  const photos = getReferencePhotos(draft)
  const views = getReferencePhotoViews(draft)
  const editorOpen = !!editor && editor.open !== false
  const attachmentKey = photos.map((file, index) => localPhotoId(file) + ':' + views[index]).join('|')
  function openEditor(selected = -1, dropped: File[] = [], button: HTMLElement | null = trigger.current) { opener.current = button; setEditor({ selected: editor ? selected : Math.max(0, selected), dropped, open: true }) }
  function closeEditor() { setEditor(previous => previous ? { ...previous, open: false, dropped: [] } : null); requestAnimationFrame(() => { if (initialAttachmentOpen) textareaRef.current?.focus(); else (opener.current?.isConnected ? opener.current : trigger.current)?.focus() }) }
  function commit(files: File[], photoViews: ReferencePhotoView[]) { onDraft({ photo: files[0] ?? null, photos: [...files], photoViews: [...photoViews], aiPlan: undefined }); onError('') }
  async function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardImageFiles(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    const room = MAX_LOST_REFERENCE_PHOTOS - photos.length
    if (room <= 0) { onError(`참고 사진은 ${MAX_LOST_REFERENCE_PHOTOS}장까지 추가할 수 있어요.`); return }
    const accepted = files.slice(0, room)
    try {
      await Promise.all(accepted.map(assertImageReadable))
      commit([...photos, ...accepted], [...views, ...accepted.map((): ReferencePhotoView => 'unspecified')])
    } catch (error) {
      onError(error instanceof Error ? error.message : '사진을 읽지 못했어요.')
    }
  }
  async function searchWithAi() {
    if (aiBusy) return
    setAiBusy(true)
    try {
      const aiPlan = await prepareAiSearch('lost', draft.query, photos)
      const nextDraft = { ...draft, aiPlan }
      onDraft({ aiPlan })
      onSubmit(nextDraft, true)
    } catch {
      // AI 해석에 실패해도 검색 자체는 막히지 않도록 원문 검색으로 폴백한다.
      // onDraft는 비동기이므로 Submit에 명시적으로 plan을 제외한 draft를 넘긴다.
      onSubmit({ ...draft, aiPlan: undefined })
    } finally {
      setAiBusy(false)
    }
  }
  return <><form ref={form} className={`composer ${error ? 'composer--error' : ''}`} aria-label="분실물 찾기 입력" onSubmit={event => {
    event.preventDefault()
    if (editorOpen || aiBusy) return
    if (!draft.query.trim() && !photos.length) { onSubmit(); return }
    void searchWithAi()
  }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) openEditor(photos.length, Array.from(event.dataTransfer.files)) }}>
    <div className="composer__body"><label htmlFor="search-query">{copy.lost.inputLabel}</label><textarea ref={textareaRef} id="search-query" value={draft.query} placeholder={copy.lost.placeholder} rows={3} spellCheck={false} autoComplete="off" aria-invalid={!!error} aria-describedby={error ? 'search-error' : undefined}
      onChange={event => onDraft({ query: event.target.value, aiPlan: undefined })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onPaste={event => void pasteImages(event)}
      onKeyDown={event => { if (canSubmitWithEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); if (!editorOpen) form.current?.requestSubmit() } }} />
      {!!photos.length && <div className="lost-attachments" aria-label={`참고 사진 ${photos.length}장`}>{photos.map((file, index) => <AttachedPhoto key={index} file={file} index={index} view={views[index]} onEdit={button => openEditor(index, [], button)} onRemove={() => { commit(photos.filter((_, position) => position !== index), views.filter((_, position) => position !== index)); requestAnimationFrame(() => trigger.current?.focus()) }} />)}<span>{photos.length}/{MAX_LOST_REFERENCE_PHOTOS}장</span></div>}
    </div><div className="composer__toolbar"><button ref={trigger} type="button" className="attachment-button" aria-haspopup="dialog" onClick={() => openEditor()}><ImagePlus aria-hidden="true" /><span>{photos.length ? '사진 추가·편집' : '참고 사진 추가'}</span></button>
      <span className="keyboard-hint" aria-hidden="true">줄바꿈 <kbd>Shift</kbd> <kbd>↵</kbd> · 이미지 붙여넣기</span>{secondaryAction}<button type="submit" className="button button--primary search-button" disabled={aiBusy}><Search aria-hidden="true" /><span>{aiBusy ? 'AI가 검색 중…' : submitLabel ?? copy.lost.action}</span></button></div>
  </form>{editor && <LostReferenceDialog key={attachmentKey} open={editorOpen} photos={photos} views={views} selected={editor.selected} dropped={editor.dropped} guideOpen={guideOpen} onGuideToggle={setGuideOpen} onClose={closeEditor} onConfirm={commit} />}</>
}

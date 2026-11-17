import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { ImagePlus, Search, X } from 'lucide-react'
import { canSubmitWithEnter, getReferencePhotos, type SearchDraft } from './model'
import { usePhotoPreview } from './usePhotoPreview'
import { copy } from './copy'
import LostReferenceDialog from './LostReferenceDialog'

function AttachedPhoto({ file, index, onEdit, onRemove }: { file: File; index: number; onEdit: () => void; onRemove: () => void }) {
  const source = usePhotoPreview(file)
  return <div className="lost-attachment"><button type="button" className="attachment__preview-button" aria-label={`참고 사진 ${index + 1} 편집`} aria-haspopup="dialog" onClick={onEdit}>{source && <img src={source} alt={`참고 사진 ${index + 1}`} draggable={false} />}</button>
    <button type="button" className="icon-button" aria-label={`참고 사진 ${index + 1} 삭제`} onClick={onRemove}><X aria-hidden="true" /></button></div>
}

interface Props {
  draft: SearchDraft; error: string; textareaRef: RefObject<HTMLTextAreaElement | null>
  onDraft: (patch: Partial<SearchDraft>) => void; onSubmit: (event: FormEvent) => void; onError: (message: string) => void
  initialAttachmentOpen?: boolean; submitLabel?: string; secondaryAction?: ReactNode
}

export default function LostSearchComposer({ draft, error, textareaRef, onDraft, onSubmit, onError, initialAttachmentOpen = false, submitLabel, secondaryAction }: Props) {
  const [editor, setEditor] = useState<{ selected: number; dropped: File[] } | null>(initialAttachmentOpen ? { selected: 0, dropped: [] } : null)
  const form = useRef<HTMLFormElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  const photos = getReferencePhotos(draft)
  function commit(files: File[]) { onDraft({ photo: files[0] ?? null, photos: [...files] }); onError('') }
  return <><form ref={form} className={`composer ${error ? 'composer--error' : ''}`} aria-label="분실물 찾기 입력" onSubmit={event => { if (editor) { event.preventDefault(); return } onSubmit(event) }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) setEditor({ selected: photos.length, dropped: Array.from(event.dataTransfer.files) }) }}>
    <div className="composer__body"><label htmlFor="search-query">{copy.lost.inputLabel}</label><textarea ref={textareaRef} id="search-query" value={draft.query} placeholder={copy.lost.placeholder} rows={3} spellCheck={false} autoComplete="off" aria-invalid={!!error} aria-describedby={error ? 'search-error' : undefined}
      onChange={event => onDraft({ query: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => { if (canSubmitWithEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); if (!editor) form.current?.requestSubmit() } }} />
      {!!photos.length && <div className="lost-attachments" aria-label={`참고 사진 ${photos.length}장`}>{photos.map((file, index) => <AttachedPhoto key={index} file={file} index={index} onEdit={() => setEditor({ selected: index, dropped: [] })} onRemove={() => { commit(photos.filter((_, position) => position !== index)); requestAnimationFrame(() => trigger.current?.focus()) }} />)}<span>{photos.length}/3장</span></div>}
    </div><div className="composer__toolbar"><button ref={trigger} type="button" className="attachment-button" aria-haspopup="dialog" onClick={() => setEditor({ selected: 0, dropped: [] })}><ImagePlus aria-hidden="true" /><span>{photos.length ? '사진 추가·편집' : '참고 사진 추가'}</span></button>
      <span className="keyboard-hint" aria-hidden="true">줄바꿈 <kbd>Shift</kbd> <kbd>↵</kbd></span>{secondaryAction}<button type="submit" className="button button--primary search-button"><Search aria-hidden="true" /><span>{submitLabel ?? copy.lost.action}</span></button></div>
  </form>{editor && <LostReferenceDialog photos={photos} selected={editor.selected} dropped={editor.dropped} onClose={() => { setEditor(null); if (initialAttachmentOpen) requestAnimationFrame(() => textareaRef.current?.focus()) }} onConfirm={commit} />}</>
}

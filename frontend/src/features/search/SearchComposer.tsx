import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Crop, ImagePlus, Search, X, LoaderCircle } from 'lucide-react'
import Modal from '../../components/Modal'
import PhotoGuide from './PhotoGuide'
import { copy } from './copy'
import { assertImageReadable, canSubmitWithEnter, clipboardImageFiles, formatFileSize, type SearchDraft, type SearchMode } from './model'
import { usePhotoPreview } from './usePhotoPreview'
import CropDialog from '../workspace/CropDialog'
import { localPhotoId, photoFromFile, type AppPhoto } from '../workspace/data'
import { originalReferencePhoto, rememberReferenceCrop } from './reference-photo-model'
import LostSearchComposer from './LostSearchComposer'

export { usePhotoPreview }
type CropSession = { photo: AppPhoto; token: number; mode: SearchMode }

interface Props {
  mode: SearchMode; draft: SearchDraft; error: string; textareaRef: RefObject<HTMLTextAreaElement | null>
  onDraft: (patch: Partial<SearchDraft>) => void; onSubmit: (draft?: SearchDraft, autoRankConsent?: boolean) => void
  onError: (message: string) => void
  initialAttachmentOpen?: boolean
  submitLabel?: string
  secondaryAction?: ReactNode
}

export default function SearchComposer(props: Props) {
  return props.mode === 'lost' ? <LostSearchComposer {...props} /> : <SingleSearchComposer {...props} />
}

function SingleSearchComposer({ mode, draft, error, textareaRef, onDraft, onSubmit, onError, initialAttachmentOpen = false, submitLabel, secondaryAction }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const sequence = useRef(0)
  const composing = useRef(false)
  const currentMode = useRef(mode)
  const [reading, setReading] = useState(false)
  const readingRef = useRef(false)
  const [uploadOpen, setUploadOpen] = useState(initialAttachmentOpen)
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(initialAttachmentOpen ? draft.photo : null)
  const [pendingOriginal, setPendingOriginal] = useState<File | null>(initialAttachmentOpen ? originalReferencePhoto(draft.photo) : null)
  const [cropSession, setCropSession] = useState<CropSession | null>(null)
  const [cropFooter, setCropFooter] = useState<HTMLDivElement | null>(null)
  const [attachmentError, setAttachmentError] = useState('')
  const chooseButton = useRef<HTMLButtonElement>(null)
  const cropButton = useRef<HTMLButtonElement>(null)
  const attachmentOpen = useRef(initialAttachmentOpen)
  const previousMode = useRef(mode)
  const preview = usePhotoPreview(draft.photo)
  const pendingPreview = usePhotoPreview(pendingPhoto)
  currentMode.current = mode

  useEffect(() => {
    if (previousMode.current === mode) return
    previousMode.current = mode
    sequence.current++
    attachmentOpen.current = false
    readingRef.current = false
    setReading(false)
    setUploadOpen(false)
    setPendingPhoto(null)
    setPendingOriginal(null)
    setCropSession(null)
    setAttachmentError('')
  }, [mode])
  useEffect(() => {
    attachmentOpen.current = initialAttachmentOpen
    return () => { sequence.current++; attachmentOpen.current = false }
  }, [initialAttachmentOpen])

  function openAttachment() {
    sequence.current++
    attachmentOpen.current = true
    if (!pendingPhoto) {
      setPendingPhoto(draft.photo)
      setPendingOriginal(originalReferencePhoto(draft.photo))
    }
    setCropSession(current => current ? { ...current, token: sequence.current } : null)
    setAttachmentError('')
    setUploadOpen(true)
  }

  function closeAttachment() {
    sequence.current++
    attachmentOpen.current = false
    readingRef.current = false
    setReading(false)
    setUploadOpen(false)
    setAttachmentError('')
    if (initialAttachmentOpen) requestAnimationFrame(() => textareaRef.current?.focus())
  }

  async function choosePhoto(file?: File) {
    if (!file) return
    const id = ++sequence.current
    const modeAtSelection = mode
    attachmentOpen.current = true
    setUploadOpen(true)
    setCropSession(null)
    setAttachmentError('')
    readingRef.current = true
    setReading(true)
    try {
      await assertImageReadable(file)
      if (sequence.current !== id || currentMode.current !== modeAtSelection) return
      setPendingPhoto(file)
      setPendingOriginal(file)
    } catch (error) {
      if (sequence.current === id && currentMode.current === modeAtSelection) setAttachmentError(error instanceof Error ? error.message : '사진을 읽지 못했어요.')
    } finally { if (sequence.current === id) { readingRef.current = false; setReading(false) } }
  }

  async function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardImageFiles(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    const file = files[0]
    try {
      await assertImageReadable(file)
      sequence.current++
      onDraft({ photo: file, aiPlan: undefined }); onError(''); setAttachmentError('')
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '사진을 읽지 못했어요.')
    }
  }

  function beginCrop() {
    if (!pendingOriginal || readingRef.current) return
    const token = ++sequence.current
    setCropSession({ photo: photoFromFile(pendingOriginal, localPhotoId(pendingOriginal)), token, mode })
  }

  function finishCrop(photo: AppPhoto) {
    if (!cropSession || !attachmentOpen.current || cropSession.token !== sequence.current || cropSession.mode !== currentMode.current || !photo.file) return
    setPendingPhoto(photo.file)
    setAttachmentError('')
  }

  function closeCrop() {
    sequence.current++
    setCropSession(null)
    requestAnimationFrame(() => cropButton.current?.focus())
  }

  function confirmAttachment() {
    if (!pendingPhoto || readingRef.current || cropSession || !attachmentOpen.current || previousMode.current !== mode) return
    rememberReferenceCrop(pendingPhoto, pendingOriginal ?? pendingPhoto)
    onDraft({ photo: pendingPhoto, aiPlan: undefined }); onError(''); closeAttachment()
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (canSubmitWithEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
      event.preventDefault()
      if (!readingRef.current && !(attachmentOpen.current && cropSession)) form.current?.requestSubmit()
    }
  }

  const photoTools = <div className="reference-photo-tools"><button ref={chooseButton} type="button" className={`button ${pendingPhoto ? 'button--secondary' : 'button--primary'}`} onClick={() => fileInput.current?.click()} disabled={reading}>
    {reading ? '사진 확인 중' : pendingPhoto ? '다른 사진 선택' : '기기에서 사진 선택'}
  </button>{pendingPhoto && <button ref={cropButton} type="button" className="button button--secondary" disabled={reading} onClick={beginCrop}><Crop aria-hidden="true" />영역 선택</button>}
    {pendingOriginal && pendingPhoto !== pendingOriginal && <button type="button" className="button button--secondary" disabled={reading} onClick={() => { sequence.current++; setPendingPhoto(pendingOriginal) }}>전체 사진으로</button>}</div>

  const attachedPreview = preview ? <img src={preview} alt="검색에 참고할 사진 미리보기" width="64" height="64" draggable={false} /> : <span className="attachment__placeholder" />

  return <><form ref={form} className={`composer ${error ? 'composer--error' : ''}`} onSubmit={event => {
    if (readingRef.current || (attachmentOpen.current && cropSession)) { event.preventDefault(); return }
    event.preventDefault()
    onSubmit()
  }} aria-label={`${copy[mode].name} 입력`}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
    onDrop={event => { event.preventDefault(); void choosePhoto(event.dataTransfer.files[0]) }}>
    <div className="composer__body">
      <label htmlFor="search-query">{copy[mode].inputLabel}</label>
      <textarea ref={textareaRef} id="search-query" value={draft.query} placeholder={copy[mode].placeholder}
        rows={3} maxLength={300} spellCheck={false} autoComplete="off" aria-invalid={!!error} aria-describedby={error ? 'search-error' : undefined}
        onChange={event => onDraft({ query: event.target.value.slice(0, 300), aiPlan: undefined })} onKeyDown={handleKey}
        onPaste={event => void pasteImage(event)}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} />
      {draft.photo && <div className="attachment">
        <button type="button" className="attachment__preview-button" aria-label="참고 사진 추가 창 열기" title="참고 사진 편집" aria-haspopup="dialog" onClick={openAttachment} disabled={reading}>{attachedPreview}</button>
        <div className="attachment__text"><span>참고 사진</span><strong title={draft.photo.name}>{draft.photo.name}</strong><small>{formatFileSize(draft.photo.size)}</small></div>
        <button type="button" className="icon-button" aria-label="참고 사진 빼기" onClick={() => { sequence.current++; readingRef.current = false; setReading(false); setPendingPhoto(null); setPendingOriginal(null); setCropSession(null); onDraft({ photo: null, aiPlan: undefined }) }}><X /></button>
      </div>}
    </div>
    <div className="composer__toolbar">
      <button type="button" className="attachment-button" onClick={openAttachment} aria-haspopup="dialog" disabled={reading}>
        {reading ? <LoaderCircle aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}<span>{reading ? '사진 확인 중' : draft.photo ? '사진 바꾸기' : '사진 첨부'}</span>
      </button>
      <span className="keyboard-hint" aria-hidden="true">줄바꿈 <kbd>Shift</kbd> <kbd>↵</kbd> · 이미지 붙여넣기</span>
      {secondaryAction}
      <button type="submit" className="button button--primary search-button" disabled={reading}><Search aria-hidden="true" /><span>{submitLabel ?? copy[mode].action}</span></button>
    </div>
  </form>
  <Modal open={uploadOpen && previousMode.current === mode} title="참고 사진 추가" focusKey={`attachment-${mode}`} className="upload-modal" initialFocus={chooseButton} onClose={closeAttachment}
    footer={cropSession ? <div ref={setCropFooter} /> : <div className="photo-picker__actions"><button type="button" className="button button--secondary" onClick={closeAttachment}>취소</button>
      {pendingPhoto && <button type="button" className="button button--primary" disabled={reading} onClick={confirmAttachment}>이 사진 사용</button>}
    </div>}>
    <input type="file" accept="image/*" ref={fileInput} hidden tabIndex={-1} aria-label="참고 사진 파일 선택"
      onChange={event => { void choosePhoto(event.target.files?.[0]); event.target.value = '' }} />
    <p className="upload-intro">{mode === 'gallery' ? '참고 사진은 선택사항이에요. 검색은 연결한 갤러리 전체에서 해요.' : '분실 전 사진도 좋아요. 사진 없이도 검색할 수 있어요.'}</p>
    <div className={`photo-picker ${pendingPhoto ? 'photo-picker--selected photo-picker--large' : ''}`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={event => { event.preventDefault(); void choosePhoto(event.dataTransfer.files[0]) }} aria-busy={reading}>
      {pendingPhoto && !cropSession && photoTools}
      {cropSession ? <CropDialog inline actionHost={cropFooter} photo={cropSession.photo} open={uploadOpen} onClose={closeCrop} onCrop={finishCrop} />
        : pendingPhoto && pendingPreview ? <div className="photo-picker__preview"><div className="reference-photo-stage"><img src={pendingPreview} alt="사용 전 확인할 참고 사진 미리보기" /></div><div><span>{pendingOriginal && pendingPhoto !== pendingOriginal ? '선택한 영역' : '선택한 참고 사진'}</span><strong>{pendingPhoto.name}</strong><small>{formatFileSize(pendingPhoto.size)}</small></div></div>
        : <><ImagePlus className="photo-picker__icon" aria-hidden="true" /><p>사진을 여기에 놓거나 선택해 주세요</p></>}
      {!cropSession && !pendingPhoto && photoTools}
    </div>
    {attachmentError && <p className="form-error" role="alert">{attachmentError}</p>}
    {!cropSession && <p className="upload-privacy">브라우저에서만 미리 봐요. 서버 전송은 없어요.</p>}
    {!cropSession && (pendingPhoto ? <details className="reference-photo-guide"><summary>사진 준비 팁</summary><PhotoGuide mode={mode} /></details> : <PhotoGuide mode={mode} />)}
  </Modal>
  </>
}

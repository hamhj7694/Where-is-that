import { useEffect, useRef, useState } from 'react'
import { Crop, ImagePlus, Trash2 } from 'lucide-react'
import Modal from '../../components/Modal'
import CropDialog from '../workspace/CropDialog'
import { isDeleteConfirmation, localPhotoId, photoFromFile, type AppPhoto } from '../workspace/data'
import { formatFileSize, MAX_LOST_REFERENCE_PHOTOS, REFERENCE_PHOTO_VIEWS, type ReferencePhotoView } from './model'
import { prepareLostReferenceFiles } from './lost-reference-import'
import { originalReferencePhoto, rememberReferenceCrop } from './reference-photo-model'
import { usePhotoPreview } from './usePhotoPreview'
import PhotoGuide from './PhotoGuide'
import PhotoDirectionGuide from './PhotoDirectionGuide'

type Entry = { file: File; original: File; view: ReferencePhotoView }
function PhotoTab({ file, index, view, selected, onSelect, onView, showDirection, disabled }: { file: File; index: number; view: ReferencePhotoView; selected: boolean; onSelect: () => void; onView: (view: ReferencePhotoView) => void; showDirection: boolean; disabled: boolean }) {
  const source = usePhotoPreview(file)
  return <div className="lost-photo-item"><button type="button" className={'lost-photo-tab' + (selected ? ' is-selected' : '')} aria-label={`사진 ${index + 1} 선택`} aria-pressed={selected} disabled={disabled} onClick={onSelect}>{source && <img src={source} alt="" />}</button>
    {showDirection && <label><span className="visually-hidden">사진 {index + 1} 방향</span><select aria-label={`사진 ${index + 1} 방향`} value={view} disabled={disabled} onChange={event => onView(event.target.value as ReferencePhotoView)}>{REFERENCE_PHOTO_VIEWS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}</div>
}

export default function LostReferenceDialog({ open, photos, views, selected: initialSelected, dropped, guideOpen, onGuideToggle, onClose, onConfirm, variant = 'lost' }: { open: boolean; photos: File[]; views: ReferencePhotoView[]; selected: number; dropped: File[]; guideOpen: boolean; onGuideToggle: (open: boolean) => void; onClose: () => void; onConfirm: (photos: File[], views: ReferencePhotoView[]) => void; variant?: 'lost' | 'valuable' }) {
  const isValuable = variant === 'valuable'
  const [entries, setEntries] = useState<Entry[]>(() => photos.map((file, index) => ({ file, original: originalReferencePhoto(file)!, view: views[index] ?? 'unspecified' })))
  const [selected, setSelected] = useState(Math.min(initialSelected, Math.max(0, photos.length - 1)))
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [deleteTargetIndex, setDeleteTargetIndex] = useState<number | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [crop, setCrop] = useState<{ photo: AppPhoto; index: number; token: number } | null>(null)
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const addInput = useRef<HTMLInputElement>(null), replaceInput = useRef<HTMLInputElement>(null)
  const firstButton = useRef<HTMLButtonElement>(null), cropButton = useRef<HTMLButtonElement>(null), deleteConfirmationInput = useRef<HTMLInputElement>(null)
  const active = useRef(true), sequence = useRef(0), busy = useRef(false)
  const reader = useRef<AbortController | null>(null)
  const currentEntries = useRef(entries)
  currentEntries.current = entries
  const entry = entries[selected]
  const preview = usePhotoPreview(entry?.file ?? null)
  useEffect(() => { if (deleteTargetIndex !== null) deleteConfirmationInput.current?.focus() }, [deleteTargetIndex])
  useEffect(() => {
    active.current = open
    if (open) {
      setCrop(current => current ? { ...current, token: sequence.current } : null)
      if (initialSelected >= 0 && !crop) setSelected(Math.min(initialSelected, Math.max(0, currentEntries.current.length - 1)))
      if (dropped.length) { setCrop(null); void readFiles(dropped, undefined, true) }
    }
    return () => { active.current = false; sequence.current++; busy.current = false; reader.current?.abort() }
    // Closing pauses this transaction; reopening retains its staged files and crop.
  }, [open, dropped])

  function close() { active.current = false; sequence.current++; busy.current = false; reader.current?.abort(); setReading(false); setDeleteTargetIndex(null); setDeleteConfirmation(''); onClose() }
  function deleteSelectedPhoto() {
    if (deleteTargetIndex === null || !isDeleteConfirmation(deleteConfirmation) || !active.current) return
    const index = deleteTargetIndex
    setEntries(previous => previous.filter((_, position) => position !== index))
    setSelected(Math.max(0, index - 1))
    setDeleteTargetIndex(null)
    setDeleteConfirmation('')
    setError('')
    requestAnimationFrame(() => firstButton.current?.focus())
  }
  async function readFiles(files: File[], replaceIndex?: number, fromDrop = false) {
    if (!files.length || busy.current || deleteTargetIndex !== null || (crop && !fromDrop) || !active.current) return
    const existing = currentEntries.current
    const token = ++sequence.current
    reader.current?.abort()
    const controller = new AbortController()
    reader.current = controller
    busy.current = true; setReading(true); setError('')
    try {
      const ready = await prepareLostReferenceFiles(files, existing.length, { replace: replaceIndex !== undefined, signal: controller.signal })
      if (!active.current || token !== sequence.current) return
      const additions = ready.map(file => ({ file, original: file, view: 'unspecified' as const }))
      setEntries(replaceIndex === undefined ? [...existing, ...additions] : existing.map((item, index) => index === replaceIndex ? additions[0] : item))
      setSelected(replaceIndex ?? existing.length)
    } catch (problem) { if (active.current && token === sequence.current) setError(problem instanceof Error ? problem.message : '사진을 읽지 못했어요.') }
    finally { if (active.current && token === sequence.current) { busy.current = false; setReading(false) } }
  }
  function beginCrop() { if (entry && !busy.current) setCrop({ photo: photoFromFile(entry.original, localPhotoId(entry.original)), index: selected, token: ++sequence.current }) }
  function finishCrop(result: AppPhoto) {
    if (!crop || !active.current || crop.token !== sequence.current || !result.file) return
    setEntries(previous => previous.map((item, index) => index === crop.index ? { ...item, file: result.file! } : item))
  }
  function closeCrop() { sequence.current++; setCrop(null); requestAnimationFrame(() => cropButton.current?.focus()) }
  function confirm() {
    if (!active.current || busy.current || crop) return
    entries.forEach(item => rememberReferenceCrop(item.file, item.original))
    onConfirm(entries.map(item => item.file), entries.map(item => item.view ?? 'unspecified')); close()
  }
  return <Modal open={open} title={isValuable ? '물건 사진 추가' : '참고 사진 추가'} focusKey={isValuable ? 'valuable-photos' : 'lost-reference-photos'} className="upload-modal" initialFocus={firstButton} onClose={close}
    footer={crop ? <div ref={setFooter} /> : <div className="photo-picker__actions"><button type="button" className="button button--secondary" onClick={close}>취소</button><button type="button" className="button button--primary" disabled={reading || isValuable && (!entries.length || deleteTargetIndex !== null)} onClick={confirm}>{entries.length ? `사진 ${entries.length}장 사용` : isValuable ? '사진 추가' : '사진 없이 계속'}</button></div>}>
    <input ref={addInput} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-label="참고 사진 여러 장 선택" onChange={event => { void readFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    <input ref={replaceInput} type="file" accept="image/*" hidden tabIndex={-1} aria-label="선택한 참고 사진 교체" onChange={event => { void readFiles(Array.from(event.target.files ?? []), selected); event.target.value = '' }} />
    <p className="upload-intro">{isValuable ? `같은 물건의 사진을 최대 ${MAX_LOST_REFERENCE_PHOTOS}장까지 등록해 주세요.` : `같은 물건의 사진을 최대 ${MAX_LOST_REFERENCE_PHOTOS}장까지 넣어 주세요. 사진 없이도 검색할 수 있어요.`}</p>
    <div className="photo-picker photo-picker--large" aria-busy={reading} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); void readFiles(Array.from(event.dataTransfer.files)) }}>
      {crop ? <CropDialog inline actionHost={footer} photo={crop.photo} open={open} onClose={closeCrop} onCrop={finishCrop} /> : <>
        <div className="lost-photo-strip" aria-label={isValuable ? '물건 사진 목록' : '참고 사진 목록'}>{entries.map((item, index) => <PhotoTab key={index} file={item.file} view={item.view ?? 'unspecified'} index={index} selected={selected === index} showDirection disabled={reading || deleteTargetIndex !== null} onSelect={() => { setSelected(index); setError('') }} onView={view => { setEntries(previous => previous.map((entry, position) => position === index ? { ...entry, view } : entry)); setSelected(index); setError('') }} />)}<button ref={firstButton} type="button" className="button button--secondary lost-photo-add" disabled={reading || deleteTargetIndex !== null || entries.length >= MAX_LOST_REFERENCE_PHOTOS} onClick={() => addInput.current?.click()}><ImagePlus aria-hidden="true" />{reading ? '사진 확인 중' : `사진 추가 (${entries.length}/${MAX_LOST_REFERENCE_PHOTOS})`}</button></div>
        {entry && <><div className="reference-photo-tools"><button type="button" className="button button--secondary" disabled={reading || deleteTargetIndex !== null} onClick={() => replaceInput.current?.click()}>사진 교체</button><button ref={cropButton} type="button" className="button button--secondary" disabled={reading || deleteTargetIndex !== null} onClick={beginCrop}><Crop aria-hidden="true" />영역 선택</button>{entry.file !== entry.original && <button type="button" className="button button--secondary" disabled={reading || deleteTargetIndex !== null} onClick={() => setEntries(previous => previous.map((item, index) => index === selected ? { ...item, file: item.original } : item))}>전체 사진으로</button>}<button type="button" className="button button--secondary" disabled={reading || deleteTargetIndex !== null} onClick={() => { if (isValuable) { setDeleteTargetIndex(selected); setDeleteConfirmation('') } else { setEntries(previous => previous.filter((_, index) => index !== selected)); setSelected(Math.max(0, selected - 1)); setError(''); requestAnimationFrame(() => firstButton.current?.focus()) } }}><Trash2 aria-hidden="true" />이 사진 삭제</button></div>
          {isValuable && deleteTargetIndex !== null && <div className="photo-delete-confirmation"><p><strong>{entries[deleteTargetIndex]?.file.name}</strong> 사진을 물건 등록에서 제외하려면 ‘삭제’를 입력해 주세요.</p><label className="field"><span className="visually-hidden">삭제 확인 문구</span><input ref={deleteConfirmationInput} autoComplete="off" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label><div className="button-row"><button type="button" className="button button--secondary" onClick={() => { setDeleteTargetIndex(null); setDeleteConfirmation('') }}>취소</button><button type="button" className="button button--primary" disabled={!isDeleteConfirmation(deleteConfirmation)} onClick={deleteSelectedPhoto}>삭제</button></div></div>}
          <div className="photo-picker__preview"><div className="reference-photo-stage">{preview && <img src={preview} alt={`사진 ${selected + 1} 큰 미리보기`} />}</div><div><span>사진 {selected + 1} · {REFERENCE_PHOTO_VIEWS.find(option => option.value === entry.view)?.label ?? '미지정'}{entry.file !== entry.original ? ' · 선택한 영역' : ''}</span><strong>{entry.file.name}</strong><small>{formatFileSize(entry.file.size)}</small></div></div></>}
      </>}
    </div>{error && <p className="form-error" role="alert">{error}</p>}{!crop && <><p className="upload-privacy">브라우저에서만 미리 봐요. 서버 전송은 없어요.</p>{!isValuable && <details className="reference-photo-guide" open={guideOpen} onToggle={event => onGuideToggle(event.currentTarget.open)}><summary>사진 준비 팁</summary><PhotoGuide mode="lost"><PhotoDirectionGuide compact={entries.length > 0} /></PhotoGuide></details>}</>}
  </Modal>
}

import { useEffect, useRef, useState } from 'react'
import { Crop, ImagePlus, Trash2 } from 'lucide-react'
import Modal from '../../components/Modal'
import CropDialog from '../workspace/CropDialog'
import { localPhotoId, photoFromFile, type AppPhoto } from '../workspace/data'
import { formatFileSize, MAX_LOST_REFERENCE_PHOTOS } from './model'
import { prepareLostReferenceFiles } from './lost-reference-import'
import { originalReferencePhoto, rememberReferenceCrop } from './reference-photo-model'
import { usePhotoPreview } from './usePhotoPreview'
import PhotoGuide from './PhotoGuide'

type Entry = { file: File; original: File }
function PhotoTab({ file, index, selected, onSelect, disabled }: { file: File; index: number; selected: boolean; onSelect: () => void; disabled: boolean }) {
  const source = usePhotoPreview(file)
  return <button type="button" className={'lost-photo-tab' + (selected ? ' is-selected' : '')} aria-label={`사진 ${index + 1} 선택`} aria-pressed={selected} disabled={disabled} onClick={onSelect}>{source && <img src={source} alt="" />}<span>사진 {index + 1}</span></button>
}

export default function LostReferenceDialog({ photos, selected: initialSelected, dropped, onClose, onConfirm }: { photos: File[]; selected: number; dropped: File[]; onClose: () => void; onConfirm: (photos: File[]) => void }) {
  const [entries, setEntries] = useState<Entry[]>(() => photos.map(file => ({ file, original: originalReferencePhoto(file)! })))
  const [selected, setSelected] = useState(Math.min(initialSelected, Math.max(0, photos.length - 1)))
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [crop, setCrop] = useState<{ photo: AppPhoto; index: number; token: number } | null>(null)
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const addInput = useRef<HTMLInputElement>(null), replaceInput = useRef<HTMLInputElement>(null)
  const firstButton = useRef<HTMLButtonElement>(null), cropButton = useRef<HTMLButtonElement>(null)
  const active = useRef(true), sequence = useRef(0), busy = useRef(false)
  const reader = useRef<AbortController | null>(null)
  const currentEntries = useRef(entries)
  currentEntries.current = entries
  const entry = entries[selected]
  const preview = usePhotoPreview(entry?.file ?? null)
  useEffect(() => {
    active.current = true
    if (dropped.length) void readFiles(dropped)
    return () => { active.current = false; sequence.current++; busy.current = false; reader.current?.abort() }
    // This dialog is a transaction; dropped files are consumed only at mount.
  }, [])

  function close() { active.current = false; sequence.current++; busy.current = false; reader.current?.abort(); onClose() }
  async function readFiles(files: File[], replaceIndex?: number) {
    if (!files.length || busy.current || crop) return
    const existing = currentEntries.current
    const token = ++sequence.current
    reader.current?.abort()
    const controller = new AbortController()
    reader.current = controller
    busy.current = true; setReading(true); setError('')
    try {
      const ready = await prepareLostReferenceFiles(files, existing.length, { replace: replaceIndex !== undefined, signal: controller.signal })
      if (!active.current || token !== sequence.current) return
      const additions = ready.map(file => ({ file, original: file }))
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
    onConfirm(entries.map(item => item.file)); close()
  }
  return <Modal open title="참고 사진 추가" focusKey="lost-reference-photos" className="upload-modal" initialFocus={firstButton} onClose={close}
    footer={crop ? <div ref={setFooter} /> : <div className="photo-picker__actions"><button type="button" className="button button--secondary" onClick={close}>취소</button><button type="button" className="button button--primary" disabled={reading} onClick={confirm}>{entries.length ? `사진 ${entries.length}장 사용` : '사진 없이 계속'}</button></div>}>
    <input ref={addInput} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-label="참고 사진 여러 장 선택" onChange={event => { void readFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    <input ref={replaceInput} type="file" accept="image/*" hidden tabIndex={-1} aria-label="선택한 참고 사진 교체" onChange={event => { void readFiles(Array.from(event.target.files ?? []), selected); event.target.value = '' }} />
    <p className="upload-intro">같은 물건의 사진을 최대 3장까지 넣어 주세요. 사진 없이도 검색할 수 있어요.</p>
    <div className="photo-picker photo-picker--large" aria-busy={reading} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); void readFiles(Array.from(event.dataTransfer.files)) }}>
      {crop ? <CropDialog inline actionHost={footer} photo={crop.photo} open onClose={closeCrop} onCrop={finishCrop} /> : <>
        <div className="lost-photo-strip" aria-label="참고 사진 목록">{entries.map((item, index) => <PhotoTab key={index} file={item.file} index={index} selected={selected === index} disabled={reading} onSelect={() => { setSelected(index); setError('') }} />)}<button ref={firstButton} type="button" className="button button--secondary lost-photo-add" disabled={reading || entries.length >= MAX_LOST_REFERENCE_PHOTOS} onClick={() => addInput.current?.click()}><ImagePlus aria-hidden="true" />{reading ? '사진 확인 중' : `사진 추가 (${entries.length}/3)`}</button></div>
        {entry && <><div className="reference-photo-tools"><button type="button" className="button button--secondary" disabled={reading} onClick={() => replaceInput.current?.click()}>사진 교체</button><button ref={cropButton} type="button" className="button button--secondary" disabled={reading} onClick={beginCrop}><Crop aria-hidden="true" />영역 선택</button>{entry.file !== entry.original && <button type="button" className="button button--secondary" disabled={reading} onClick={() => setEntries(previous => previous.map((item, index) => index === selected ? { ...item, file: item.original } : item))}>전체 사진으로</button>}<button type="button" className="button button--secondary" disabled={reading} onClick={() => { setEntries(previous => previous.filter((_, index) => index !== selected)); setSelected(Math.max(0, selected - 1)); setError(''); requestAnimationFrame(() => firstButton.current?.focus()) }}><Trash2 aria-hidden="true" />이 사진 삭제</button></div>
          <div className="photo-picker__preview"><div className="reference-photo-stage">{preview && <img src={preview} alt={`사진 ${selected + 1} 큰 미리보기`} />}</div><div><span>사진 {selected + 1}{entry.file !== entry.original ? ' · 선택한 영역' : ''}</span><strong>{entry.file.name}</strong><small>{formatFileSize(entry.file.size)}</small></div></div></>}
        {!entry && <p>정면·옆면·로고가 보이는 사진도 좋아요.</p>}
      </>}
    </div>{error && <p className="form-error" role="alert">{error}</p>}{!crop && <><p className="upload-privacy">브라우저에서만 미리 봐요. 서버 전송은 없어요.</p><details className="reference-photo-guide"><summary>사진 준비 팁</summary><PhotoGuide mode="lost" /></details></>}
  </Modal>
}

import { useRef, useState, type ChangeEvent, type InputHTMLAttributes } from 'react'
import { ArrowRight, FolderOpen, Images } from 'lucide-react'
import Modal from '../../components/Modal'
import useGalleryImport, { type GalleryImportHandler } from './useGalleryImport'
import GalleryBasePathField from './GalleryBasePathField'
import useLocalGalleryPicker from './useLocalGalleryPicker'

interface Props { open: boolean; onClose: () => void; onAdd: GalleryImportHandler }

export default function GalleryAddDialog({ open, onClose, onAdd }: Props) {
  const photos = useRef<HTMLInputElement>(null)
  const directory = useRef<HTMLInputElement>(null)
  const firstOption = useRef<HTMLButtonElement>(null)
  const importer = useGalleryImport(onAdd)
  const [basePath, setBasePath] = useState('')
  const localPicker = useLocalGalleryPicker()
  const busy = importer.busy || localPicker.busy || localPicker.checking
  const supportsDirectory = 'webkitdirectory' in document.createElement('input')
  function close() { localPicker.cancel(); importer.cancel(); setBasePath(''); onClose() }
  async function select(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (await importer.run(files, { basePath })) close()
  }
  async function selectLocal(kind: 'folder' | 'images') {
    importer.cancel()
    const picked = await localPicker.select(kind)
    if (picked && await importer.run(picked.files, { nativeLocations: picked.locations })) close()
  }
  return <Modal open={open} title="이미지 추가" onClose={close} focusKey="gallery-add" initialFocus={firstOption} className="gallery-add-dialog"
    footer={<button type="button" className="button button--secondary" onClick={close}>취소</button>}>
    <p>기존 사진은 그대로 두고 추가해요.</p>
    {!localPicker.available && !localPicker.checking && <GalleryBasePathField value={basePath} onChange={setBasePath} disabled={busy} />}
    <input type="file" accept="image/*" multiple ref={photos} hidden aria-label="추가할 사진 선택" tabIndex={-1} onChange={select} />
    <input type="file" multiple ref={directory} hidden aria-label="추가할 사진 폴더 선택" tabIndex={-1} {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)} onChange={select} />
    <div className="selection-options" aria-busy={busy}>
      <button type="button" ref={firstOption} disabled={busy} onClick={() => { if (localPicker.available) void selectLocal('images'); else photos.current?.click() }}><Images aria-hidden="true" /><span><strong>사진 추가</strong></span><ArrowRight aria-hidden="true" /></button>
      {(supportsDirectory || localPicker.available) && <button type="button" disabled={busy} onClick={() => { if (localPicker.available) void selectLocal('folder'); else directory.current?.click() }}><FolderOpen aria-hidden="true" /><span><strong>폴더 추가</strong><small>하위 폴더 포함{localPicker.available ? ' · 전체 경로 자동 연결' : ''}</small></span><ArrowRight aria-hidden="true" /></button>}
    </div>
    {(importer.error || localPicker.error) && <p role="alert" className="form-error">{importer.error || localPicker.error}</p>}
    <p role="status" className="field__help">{localPicker.checking ? '연결 방식을 확인하고 있어요.' : localPicker.busy ? localPicker.notice : importer.busy ? '중복 이미지를 확인하고 있어요.' : importer.notice || localPicker.notice}</p>
  </Modal>
}

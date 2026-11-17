import { useRef, type ChangeEvent, type InputHTMLAttributes } from 'react'
import { ArrowRight, FolderOpen, Images } from 'lucide-react'
import Modal from '../../components/Modal'
import useGalleryImport, { type GalleryImportHandler } from './useGalleryImport'

interface Props { open: boolean; onClose: () => void; onAdd: GalleryImportHandler }

export default function GalleryAddDialog({ open, onClose, onAdd }: Props) {
  const photos = useRef<HTMLInputElement>(null)
  const directory = useRef<HTMLInputElement>(null)
  const firstOption = useRef<HTMLButtonElement>(null)
  const importer = useGalleryImport(onAdd)
  const supportsDirectory = 'webkitdirectory' in document.createElement('input')
  function close() { importer.cancel(); onClose() }
  async function select(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (await importer.run(files)) close()
  }
  return <Modal open={open} title="이미지 추가" onClose={close} focusKey="gallery-add" initialFocus={firstOption} className="gallery-add-dialog"
    footer={<button type="button" className="button button--secondary" onClick={close}>취소</button>}>
    <p>기존 사진은 그대로 두고 추가해요.</p>
    <input type="file" accept="image/*" multiple ref={photos} hidden aria-label="추가할 사진 선택" tabIndex={-1} onChange={select} />
    <input type="file" multiple ref={directory} hidden aria-label="추가할 사진 폴더 선택" tabIndex={-1} {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)} onChange={select} />
    <div className="selection-options" aria-busy={importer.busy}>
      <button type="button" ref={firstOption} disabled={importer.busy} onClick={() => photos.current?.click()}><Images aria-hidden="true" /><span><strong>사진 추가</strong></span><ArrowRight aria-hidden="true" /></button>
      {supportsDirectory && <button type="button" disabled={importer.busy} onClick={() => directory.current?.click()}><FolderOpen aria-hidden="true" /><span><strong>폴더 추가</strong><small>하위 폴더 포함</small></span><ArrowRight aria-hidden="true" /></button>}
    </div>
    {importer.error && <p role="alert" className="form-error">{importer.error}</p>}
    <p role="status" className="field__help">{importer.busy ? '중복 이미지를 확인하고 있어요.' : importer.notice}</p>
  </Modal>
}

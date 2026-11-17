import { useRef, type ChangeEvent, type InputHTMLAttributes } from 'react'
import { ArrowRight, FolderOpen, Images } from 'lucide-react'
import type { GallerySource } from './model'
import useGalleryImport, { type GalleryImportHandler } from './useGalleryImport'

interface Props {
  gallery: GallerySource | null
  error: string
  onConnect: GalleryImportHandler
  onCancel: () => void
  onDisconnect: () => void
}

export default function GalleryConnection({ gallery, error, onConnect, onCancel, onDisconnect }: Props) {
  const photos = useRef<HTMLInputElement>(null)
  const directory = useRef<HTMLInputElement>(null)
  const importer = useGalleryImport(onConnect)
  const supportsDirectory = 'webkitdirectory' in document.createElement('input')
  async function select(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    await importer.run(files)
  }
  return <section className="gallery-connection" aria-labelledby="gallery-connect-heading">
    <h2 id="gallery-connect-heading" tabIndex={-1}>{gallery ? '갤러리 관리' : '찾고 싶은 사진이 있는 갤러리나 폴더를 연결해 주세요.'}</h2>
    <p>{gallery ? gallery.name + ' · ' + gallery.files.length.toLocaleString('ko-KR') + '장 연결됨' : '선택한 사진이나 폴더 전체에서 찾아요.'}</p>
    <input type="file" accept="image/*" multiple ref={photos} hidden aria-label="갤러리 사진 여러 장 선택" tabIndex={-1} onChange={select} />
    <input type="file" multiple ref={directory} hidden aria-label="갤러리 폴더 선택" tabIndex={-1} {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)} onChange={select} />
    <div className="selection-options gallery-connection__options" aria-busy={importer.busy}>
      <button type="button" disabled={importer.busy} onClick={() => photos.current?.click()}><Images aria-hidden="true" /><span><strong>사진 여러 장 선택</strong></span><ArrowRight aria-hidden="true" /></button>
      {supportsDirectory && <button type="button" disabled={importer.busy} onClick={() => directory.current?.click()}><FolderOpen aria-hidden="true" /><span><strong>사진 폴더 연결</strong><small>하위 폴더 포함</small></span><ArrowRight aria-hidden="true" /></button>}
    </div>
    {(importer.error || error) && <p role="alert" className="form-error">{importer.error || error}</p>}
    <p role="status">{importer.busy ? '중복 이미지를 확인하고 있어요.' : importer.notice}</p>
    {!gallery && importer.busy && <button type="button" className="button button--secondary" onClick={importer.cancel}>확인 중단</button>}
    <p className="gallery-connection__note">사진은 서버로 보내지 않아요. 새로고침하면 연결이 해제돼요.</p>
    {gallery && <div className="button-row gallery-connection__actions"><button type="button" className="button button--secondary" onClick={() => { importer.cancel(); onCancel() }}>← 돌아가기</button><button type="button" className="button button--secondary" onClick={() => { importer.cancel(); onDisconnect() }}>갤러리 해제</button></div>}
  </section>
}

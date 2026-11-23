import { useState } from 'react'
import { Images, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePhotoPreview } from './SearchComposer'
import type { GallerySource } from './model'
import { localPhotoId, photoFromFile } from '../workspace/data'
import { PhotoViewer } from '../workspace/components'
import GalleryAddDialog from './GalleryAddDialog'
import type { GalleryImportHandler } from './useGalleryImport'

const PREVIEW_LIMIT = 3

function GalleryThumbnail({ file, onOpen }: { file: File; onOpen: () => void }) {
  const source = usePhotoPreview(file)
  const [failed, setFailed] = useState(false)
  return <button type="button" className="gallery-preview__image" onClick={onOpen} aria-label={file.name + ' 크게 보기'}>{source && !failed
    ? <img src={source} alt="" onError={() => setFailed(true)} />
    : <Images aria-hidden="true" />}</button>
}

export default function GalleryPreview({ gallery, onAdd }: { gallery: GallerySource | null; onAdd: GalleryImportHandler }) {
  const [selected, setSelected] = useState<File | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const shown = selected && gallery?.files.includes(selected) ? selected : null
  if (!gallery?.files.length) return <span className="gallery-preview-icon" aria-hidden="true"><Images /></span>
  const canAdd = gallery.files.length <= PREVIEW_LIMIT
  return <>
    <div className="gallery-preview" role="group" aria-label="연결한 갤러리 미리보기. 사진을 누르면 크게 볼 수 있어요.">
      {gallery.files.slice(0, PREVIEW_LIMIT).map(file => <GalleryThumbnail key={localPhotoId(file)} file={file} onOpen={() => { setSelected(file); setViewerOpen(true) }} />)}
      <span className="gallery-preview__count">사진 {gallery.files.length.toLocaleString('ko-KR')}장</span>
      <Link className="gallery-preview__more" to="/gallery/results?view=all" aria-label={'연결한 사진 ' + gallery.files.length.toLocaleString('ko-KR') + '장 전체 보기'}>전체 보기</Link>
      {canAdd && <button type="button" className="gallery-preview__add" aria-haspopup="dialog" onClick={() => setAddOpen(true)}><Plus aria-hidden="true" /><span>사진 추가</span></button>}
    </div>
    {shown && <PhotoViewer photo={photoFromFile(shown, localPhotoId(shown))} open={viewerOpen} onClose={() => setViewerOpen(false)} />}
    {canAdd && <GalleryAddDialog open={addOpen} onClose={() => setAddOpen(false)} onAdd={onAdd} />}
  </>
}

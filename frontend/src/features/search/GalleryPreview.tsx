import { useState } from 'react'
import { Images, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePhotoPreview } from './SearchComposer'
import type { GallerySource } from './model'
import { localPhotoId, photoFromFile } from '../workspace/data'
import { PhotoViewer } from '../workspace/components'
import GalleryAddDialog from './GalleryAddDialog'
import type { GalleryImportHandler } from './useGalleryImport'

const DESKTOP_PREVIEW_LIMIT = 6
const MOBILE_PREVIEW_LIMIT = 4

function GalleryThumbnail({ file, onOpen, desktopOnly = false }: { file: File; onOpen: () => void; desktopOnly?: boolean }) {
  const source = usePhotoPreview(file)
  const [failed, setFailed] = useState(false)
  return <button type="button" className={'gallery-preview__image' + (desktopOnly ? ' gallery-preview__image--desktop' : '')} onClick={onOpen} aria-label={file.name + ' 크게 보기'}>{source && !failed
    ? <img src={source} alt="" onError={() => setFailed(true)} />
    : <Images aria-hidden="true" />}</button>
}

export default function GalleryPreview({ gallery, onAdd }: { gallery: GallerySource | null; onAdd: GalleryImportHandler }) {
  const [selected, setSelected] = useState<File | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const shown = selected && gallery?.files.includes(selected) ? selected : null
  if (!gallery?.files.length) return <span className="gallery-preview-icon" aria-hidden="true"><Images /></span>
  const hasDesktopMore = gallery.files.length > DESKTOP_PREVIEW_LIMIT
  const canAdd = !hasDesktopMore
  const mobileAddRow = canAdd && gallery.files.length > MOBILE_PREVIEW_LIMIT
  return <><div className={'gallery-preview' + (mobileAddRow ? ' gallery-preview--add-row' : '')} role="group" aria-label="연결한 갤러리 미리보기. 사진을 누르면 크게 볼 수 있어요.">
    {gallery.files.slice(0, DESKTOP_PREVIEW_LIMIT).map((file, index) => <GalleryThumbnail key={localPhotoId(file)} file={file} desktopOnly={index >= MOBILE_PREVIEW_LIMIT} onOpen={() => { setSelected(file); setViewerOpen(true) }} />)}
    {gallery.files.length > MOBILE_PREVIEW_LIMIT && <Link className={'gallery-preview__more' + (hasDesktopMore ? '' : ' gallery-preview__more--mobile-only')} to="/gallery/results?view=all" aria-label={'이미지 더보기 · 연결한 ' + gallery.files.length.toLocaleString('ko-KR') + '장 전체 보기'}>이미지<br />더보기</Link>}
    {canAdd && <button type="button" className="gallery-preview__more gallery-preview__add" aria-haspopup="dialog" onClick={() => setAddOpen(true)}><Plus aria-hidden="true" /><span>이미지 추가</span></button>}
  </div>{shown && <PhotoViewer photo={photoFromFile(shown, localPhotoId(shown))} open={viewerOpen} onClose={() => setViewerOpen(false)} />}
    {canAdd && <GalleryAddDialog open={addOpen} onClose={() => setAddOpen(false)} onAdd={onAdd} />}
  </>
}

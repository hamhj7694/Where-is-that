import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronDown, ChevronUp, Images } from 'lucide-react'
import { usePhotoPreview } from '../search/usePhotoPreview'
import { getReferencePhotos, getReferencePhotoViews, REFERENCE_PHOTO_VIEWS, type ReferencePhotoView, type SearchDraft, type SearchMode } from '../search/model'
import { localPhotoId, photoFromFile } from './data'
import { PhotoViewer } from './components'
import { AiSearchPlanView } from '../search/AiSearchControls'

interface Props {
  draft: SearchDraft
  mode?: SearchMode
  editButtonRef: RefObject<HTMLButtonElement | null>
  onEdit: (photo?: boolean) => void
  secondaryAction?: ReactNode
  feedback?: ReactNode
}

function ReferencePhoto({ file, index, view, onEdit }: { file: File; index: number; view: ReferencePhotoView; onEdit: () => void }) {
  const source = usePhotoPreview(file)
  const [open, setOpen] = useState(false)
  const label = REFERENCE_PHOTO_VIEWS.find(option => option.value === view)?.label ?? '미지정'
  return <div className="lost-query-summary__photo"><button type="button" className="gallery-query-summary__photo" aria-label={`참고 사진 ${index + 1}, ${label}, 크게 보기`} aria-haspopup="dialog" onClick={() => setOpen(true)}>{source ? <img src={source} alt={`검색 참고 사진 ${index + 1}`} /> : <Images aria-hidden="true" />}</button><span>{label}</span>
    <PhotoViewer photo={photoFromFile(file, localPhotoId(file))} open={open} onClose={() => setOpen(false)} className="gallery-reference-viewer" footer={<button type="button" className="button button--primary" onClick={() => { setOpen(false); onEdit() }}>사진 추가·편집</button>} /></div>
}

export default function GalleryQuerySummary({ draft, mode = 'gallery', editButtonRef, onEdit, secondaryAction, feedback }: Props) {
  const source = usePhotoPreview(draft.photo)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const text = useRef<HTMLParagraphElement>(null)
  const textId = useId()
  const photos = mode === 'lost' ? getReferencePhotos(draft) : []
  const views = mode === 'lost' ? getReferencePhotoViews(draft) : []
  const hasPhoto = mode === 'lost' ? photos.length > 0 : !!draft.photo
  const query = draft.query || '참고 사진으로 찾기'
  useLayoutEffect(() => {
    if (expanded || !text.current) return
    const element = text.current
    const measure = () => setCanExpand(query.includes('\n') || element.scrollWidth > element.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [query, expanded])

  const editButton = <button type="button" className="button button--secondary gallery-query-summary__edit" ref={editButtonRef} onClick={() => onEdit()}>검색 수정</button>
  return <><div className={'query-summary gallery-query-summary' + (hasPhoto ? '' : ' gallery-query-summary--text-only') + (mode === 'lost' ? ' lost-query-summary' + (photos.length > 1 ? ' lost-query-summary--multiple' : '') : '')}>
    {mode === 'gallery' && draft.photo && <button type="button" className="gallery-query-summary__photo" aria-label="검색 참고 사진 크게 보기" aria-haspopup="dialog" onClick={() => setViewerOpen(true)}>{source ? <img src={source} alt="검색에 참고한 사진" /> : <Images aria-hidden="true" />}</button>}
    <div className="gallery-query-summary__content"><p id={textId} ref={text} className={'gallery-query-summary__text' + (expanded ? ' is-expanded' : '')}>{query}</p>
      {(canExpand || expanded) && <button type="button" className="gallery-query-summary__expand" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded(previous => !previous)}>{expanded ? '접기' : '펼치기'}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}
      {mode === 'lost' ? <div className="lost-query-summary__actions">{secondaryAction}{editButton}</div> : editButton}
    </div>
    {mode === 'lost' && photos.length > 0 && <div className="lost-query-summary__photos">{photos.map((file, index) => <ReferencePhoto key={localPhotoId(file) + '-' + index} file={file} index={index} view={views[index]} onEdit={() => onEdit(true)} />)}</div>}
    {feedback && <div className="lost-query-summary__feedback">{feedback}</div>}
  </div>{mode === 'gallery' && draft.aiPlan && <AiSearchPlanView plan={draft.aiPlan} originalQuery={draft.aiPlan.originalQuery || draft.query} />}
  {mode === 'gallery' && draft.photo && <PhotoViewer photo={photoFromFile(draft.photo, localPhotoId(draft.photo))} open={viewerOpen} onClose={() => setViewerOpen(false)} className="gallery-reference-viewer"
    footer={<button type="button" className="button button--primary" onClick={() => { setViewerOpen(false); onEdit(true) }}>사진 변경·수정</button>} />}</>
}

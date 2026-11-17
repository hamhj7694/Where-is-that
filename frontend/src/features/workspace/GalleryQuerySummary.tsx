import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, Images } from 'lucide-react'
import { usePhotoPreview } from '../search/usePhotoPreview'
import type { SearchDraft } from '../search/model'
import { localPhotoId, photoFromFile } from './data'
import { PhotoViewer } from './components'

interface Props {
  draft: SearchDraft
  editButtonRef: RefObject<HTMLButtonElement | null>
  onEdit: (photo?: boolean) => void
}

export default function GalleryQuerySummary({ draft, editButtonRef, onEdit }: Props) {
  const source = usePhotoPreview(draft.photo)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const text = useRef<HTMLParagraphElement>(null)
  const textId = useId()
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

  return <><div className={'query-summary gallery-query-summary' + (draft.photo ? '' : ' gallery-query-summary--text-only')}>
    {draft.photo && <button type="button" className="gallery-query-summary__photo" aria-label="검색 참고 사진 크게 보기" aria-haspopup="dialog" onClick={() => setViewerOpen(true)}>{source ? <img src={source} alt="검색에 참고한 사진" /> : <Images aria-hidden="true" />}</button>}
    <div className="gallery-query-summary__content"><p id={textId} ref={text} className={'gallery-query-summary__text' + (expanded ? ' is-expanded' : '')}>{query}</p>
      {(canExpand || expanded) && <button type="button" className="gallery-query-summary__expand" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded(previous => !previous)}>{expanded ? '접기' : '펼치기'}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}
      <button type="button" className="button button--secondary gallery-query-summary__edit" ref={editButtonRef} onClick={() => onEdit()}>검색 수정</button>
    </div>
  </div>{draft.photo && <PhotoViewer photo={photoFromFile(draft.photo, localPhotoId(draft.photo))} open={viewerOpen} onClose={() => setViewerOpen(false)} className="gallery-reference-viewer"
    footer={<button type="button" className="button button--primary" onClick={() => { setViewerOpen(false); onEdit(true) }}>사진 변경·수정</button>} />}</>
}

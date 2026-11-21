import { useId, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { ArrowUpRight, ChevronDown, ChevronUp, Images, Search, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import Modal from '../../components/Modal'
import { usePhotoPreview } from '../search/SearchComposer'
import { recordPath, type SearchRecord } from '../search/history'
import { getReferencePhotos } from '../search/model'
import { PageHeading } from './components'

function HistoryRow({ record, onDelete, deleteRef }: { record: SearchRecord; onDelete: () => void; deleteRef: Ref<HTMLButtonElement> }) {
  const photos = record.mode === 'lost' ? getReferencePhotos(record.draft) : record.draft.photo ? [record.draft.photo] : []
  const preview = usePhotoPreview(photos[0] ?? record.gallery?.files[0] ?? null)
  const isGallery = record.mode === 'gallery'
  const title = record.draft.query || '참고 사진으로 찾기'
  const textId = useId()
  const text = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  useLayoutEffect(() => {
    const element = text.current
    if (!element) return
    let active = true
    const measure = () => {
      if (active) setCanExpand(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 2 + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    void document.fonts.ready.then(measure)
    return () => { active = false; observer.disconnect() }
  }, [title])
  return <li><div className="history-entry"><Link className="history-row" to={recordPath(record)}>
    <span className="history-row__image" aria-hidden="true">{preview ? <img src={preview} alt="" /> : isGallery ? <Images /> : <Search />}</span>
    <span className="history-row__body"><strong id={textId} ref={text} className={'history-row__query' + (expanded ? ' is-expanded' : '')}>{title}</strong><span>{isGallery ? '파일 미리보기' : '샘플 결과'}{photos.length > 1 && <> · 사진 {photos.length}장</>} · <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span></span>
    <ArrowUpRight aria-hidden="true" /><span className="visually-hidden">결과 다시 보기</span>
  </Link>{(canExpand || expanded) && <button type="button" className="history-row__toggle" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded(previous => !previous)}>{expanded ? '접기' : '펼치기'}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}</div>
    <button ref={deleteRef} type="button" className="icon-button history-delete" aria-label={title + ' 기록 삭제'} title="기록 삭제" aria-haspopup="dialog" onClick={onDelete}><Trash2 aria-hidden="true" /></button></li>
}

export default function HistoryPage({ records, onDeleteRecord }: { records: SearchRecord[]; onDeleteRecord: (id: string) => void }) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const deleteConfirmationInput = useRef<HTMLInputElement>(null)
  const warningId = useId()
  const confirmationId = useId()
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>())
  const startLinks = useRef(new Map<string, HTMLAnchorElement>())
  const pending = records.find(record => record.id === pendingId)

  function confirmDelete() {
    if (!pending || deleteConfirmation !== '삭제') return
    const sameSection = records.filter(record => record.mode === pending.mode)
    const index = sameSection.findIndex(record => record.id === pending.id)
    const next = sameSection[index + 1] ?? sameSection[index - 1]
    const mode = pending.mode
    onDeleteRecord(pending.id)
    setPendingId(null)
    setDeleteConfirmation('')
    setMessage('기록을 삭제했어요.')
    requestAnimationFrame(() => {
      const nextButton = next ? deleteButtons.current.get(next.id) : null
      const target = nextButton ?? startLinks.current.get(mode)
      target?.focus()
    })
  }
  const sections = [
    { mode: 'gallery', title: '갤러리에서 찾은 사진', to: '/gallery', cta: '갤러리에서 찾으러 가기', empty: '아직 갤러리에서 찾은 기록이 없어요' },
    { mode: 'lost', title: '찾은 분실물', to: '/lost-found', cta: '다른 분실물 찾으러 가기', empty: '아직 분실물을 찾은 기록이 없어요' },
  ] as const
  return <main id="main-content" className="content-workspace history-workspace">
    <PageHeading title="찾은 기록" description="검색 내용과 결과를 다시 볼 수 있어요." />
    <p className="history-retention">로그인한 계정에 저장되며, 다시 로그인해도 이어서 볼 수 있어요.</p>
    <p className="history-status" role="status" aria-live="polite">{message}</p>
    <div className="history-sections">{sections.map(section => {
      const items = records.filter(record => record.mode === section.mode)
      return <section key={section.mode} className="history-section" aria-labelledby={'history-' + section.mode}>
        <div className="section-heading"><h2 id={'history-' + section.mode}>{section.title} <span>{items.length}</span></h2></div>
        <Link ref={node => { if (node) startLinks.current.set(section.mode, node); else startLinks.current.delete(section.mode) }} to={section.to} className="button button--secondary history-start">{section.cta}<ArrowUpRight aria-hidden="true" /></Link>
        {items.length ? <ul className="history-list">{items.map(record => <HistoryRow key={record.id} record={record} onDelete={() => { setMessage(''); setDeleteConfirmation(''); setPendingId(record.id) }} deleteRef={node => { if (node) deleteButtons.current.set(record.id, node); else deleteButtons.current.delete(record.id) }} />)}</ul>
          : <p className="history-empty">{section.empty}</p>}
      </section>
    })}</div>
    <Modal open={!!pending} title="기록을 삭제할까요?" descriptionId={warningId} focusKey={pendingId ?? 'history-delete'} initialFocus={deleteConfirmationInput} onClose={() => { setPendingId(null); setDeleteConfirmation('') }}>
      {pending && <><p className="history-delete-query">{pending.draft.query || '참고 사진으로 찾기'}</p><p className="field__help">{new Date(pending.createdAt).toLocaleString('ko-KR')}</p></>}
      <p id={warningId}>삭제한 기록은 복구할 수 없어요.<br />사진 원본은 그대로 유지돼요.</p>
      <label className="field history-delete-confirmation" htmlFor={confirmationId}><span>삭제하려면 ‘삭제’를 입력해 주세요.</span><input id={confirmationId} ref={deleteConfirmationInput} autoComplete="off" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label>
      <div className="button-row history-delete-actions"><button type="button" className="button button--secondary" onClick={() => { setPendingId(null); setDeleteConfirmation('') }}>취소</button><button type="button" className="button button--primary" disabled={deleteConfirmation !== '삭제'} onClick={confirmDelete}>삭제</button></div>
    </Modal>
  </main>
}

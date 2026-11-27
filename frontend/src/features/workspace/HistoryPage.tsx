import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ArrowUpRight, Bookmark, ChevronDown, ChevronUp, Images, RotateCcw, Search, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import Modal from '../../components/Modal'
import { usePhotoPreview } from '../search/usePhotoPreview'
import { galleryHistoryPreview, recordPath, type SearchRecord } from '../search/history'
import { getReferencePhotos } from '../search/model'
import { bookmarkLink, requestBookmarkRemoval, restoreBookmark, useBookmarks, type BookmarkView } from './bookmarks'
import { PageHeading, RetryButton } from './components'

const HISTORY_PREVIEW_LIMIT = 3

function HistorySection<T>({ id, title, items, empty, action, renderItem }: {
  id: string
  title: string
  items: readonly T[]
  empty: ReactNode
  action?: ReactNode
  renderItem: (item: T) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const listId = id + '-list'
  const hiddenCount = items.length - HISTORY_PREVIEW_LIMIT
  return <section className="history-section" aria-labelledby={id}>
    <div className="section-heading"><h2 id={id}>{title} <span className="history-section__count">{items.length}</span></h2></div>
    {action}
    {items.length
      ? <ul className="history-list" id={listId}>{(expanded ? items : items.slice(0, HISTORY_PREVIEW_LIMIT)).map(renderItem)}</ul>
      : <p className="history-empty">{empty}</p>}
    {hiddenCount > 0 && <button type="button" className="history-more" aria-expanded={expanded} aria-controls={listId}
      onClick={event => {
        const button = event.currentTarget
        setExpanded(!expanded)
        if (expanded) requestAnimationFrame(() => button.scrollIntoView({ block: 'nearest' }))
      }}>
      {expanded ? '목록 접기' : `${hiddenCount}개 더 보기`}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>}
  </section>
}

function HistoryRow({ record, onDelete, deleteRef }: { record: SearchRecord; onDelete: () => void; deleteRef: Ref<HTMLButtonElement> }) {
  const isGallery = record.mode === 'gallery'
  const photos = isGallery ? [] : getReferencePhotos(record.draft)
  const [resultPreview, setResultPreview] = useState<{ record: SearchRecord; file: File | null } | null>(null)
  const [failedPreview, setFailedPreview] = useState<string | null>(null)
  const previewFile = isGallery ? (resultPreview?.record === record ? resultPreview.file : null) : photos[0] ?? null
  const preview = usePhotoPreview(previewFile)
  const showPreview = !!preview && preview !== failedPreview
  const title = record.draft.query || '참고 사진으로 찾기'
  const textId = useId()
  const text = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  useEffect(() => {
    if (record.mode !== 'gallery') return
    const controller = new AbortController()
    void galleryHistoryPreview(record, controller.signal).then(file => {
      if (!controller.signal.aborted) setResultPreview({ record, file })
    }).catch(() => { /* An unreadable preview leaves the placeholder icon visible. */ })
    return () => controller.abort()
  }, [record])
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
    <span className="history-row__image" aria-hidden="true">{showPreview ? <img src={preview} alt="" onError={() => setFailedPreview(preview)} /> : isGallery ? <Images /> : <Search />}</span>
    <span className="history-row__body"><strong id={textId} ref={text} className={'history-row__query' + (expanded ? ' is-expanded' : '')}>{title}</strong><span>{isGallery ? (showPreview ? '추천 사진 미리보기' : '갤러리 검색') : '공개 후보'}{photos.length > 1 && <> · 사진 {photos.length}장</>} · <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span></span>
    <ArrowUpRight aria-hidden="true" /><span className="visually-hidden">결과 다시 보기</span>
  </Link>{(canExpand || expanded) && <button type="button" className="history-row__toggle" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded(previous => !previous)}>{expanded ? '접기' : '펼치기'}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}</div>
    <button ref={deleteRef} type="button" className="icon-button history-delete" aria-label={title + ' 기록 삭제'} title="기록 삭제" aria-haspopup="dialog" onClick={onDelete}><Trash2 aria-hidden="true" /></button></li>
}

function BookmarkRow({ entry, onRemove, onUndo, removeRef }: { entry: BookmarkView; onRemove: () => void; onUndo: () => void; removeRef: (node: HTMLButtonElement | null) => void }) {
  const [imageFailed, setImageFailed] = useState(false)
  return <li className={entry.pendingRemoval ? 'is-pending' : undefined}><div className="history-entry"><Link className="history-row" to={bookmarkLink(entry.path, entry.kind, entry.title)}>
    <span className="history-row__image" aria-hidden="true">{entry.image && !imageFailed ? <img src={entry.image} alt="" onError={() => setImageFailed(true)} /> : entry.kind === 'gallery' ? <Images /> : <Bookmark />}</span>
    <span className="history-row__body"><strong className="history-row__query">{entry.title}</strong><span>{entry.subtitle} · <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>{entry.pendingRemoval && <span className="bookmark-pending">해제 예정</span>}</span></span>
    <ArrowUpRight aria-hidden="true" /><span className="visually-hidden">상세 보기</span>
  </Link></div>
    {entry.pendingRemoval
      ? <button id={'bookmark-undo-' + entry.id} type="button" className="button button--secondary bookmark-undo" aria-label={entry.title + ' 북마크 되돌리기'} onClick={onUndo}><RotateCcw aria-hidden="true" />되돌리기</button>
      : <button ref={removeRef} type="button" className="icon-button history-delete" aria-label={entry.title + ' 북마크 해제'} title="북마크 해제" aria-haspopup="dialog" onClick={onRemove}><Bookmark aria-hidden="true" fill="currentColor" /></button>}</li>
}

export default function HistoryPage({ records, onDeleteRecord, session, onRetryAccountLoad }: { records: SearchRecord[]; onDeleteRecord: (id: string) => void; session: boolean; onRetryAccountLoad?: () => void }) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [pendingBookmark, setPendingBookmark] = useState<BookmarkView | null>(null)
  const [message, setMessage] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const deleteConfirmationInput = useRef<HTMLInputElement>(null)
  const warningId = useId()
  const bookmarkWarningId = useId()
  const confirmationId = useId()
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>())
  const startLinks = useRef(new Map<string, HTMLAnchorElement>())
  const bookmarkButtons = useRef(new Map<string, HTMLButtonElement>())
  const pending = records.find(record => record.id === pendingId)
  const bookmarks = useBookmarks()

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
  function confirmBookmarkRemoval() {
    if (!pendingBookmark) return
    const id = pendingBookmark.id
    requestBookmarkRemoval(id)
    setPendingBookmark(null)
    setMessage('북마크를 해제했어요. 실수였다면 목록에서 되돌릴 수 있어요.')
    requestAnimationFrame(() => document.getElementById('bookmark-undo-' + id)?.focus())
  }
  function undoBookmarkRemoval(entry: BookmarkView) {
    restoreBookmark(entry.id)
    setMessage('북마크를 되돌렸어요.')
    requestAnimationFrame(() => bookmarkButtons.current.get(entry.id)?.focus())
  }
  const sections = [
    { mode: 'gallery', title: '갤러리에서 찾은 사진', to: '/gallery', cta: '갤러리에서 찾으러 가기', empty: '아직 갤러리에서 찾은 기록이 없어요' },
    { mode: 'lost', title: '찾은 분실물', to: '/lost-found', cta: '다른 분실물 찾으러 가기', empty: '아직 분실물을 찾은 기록이 없어요' },
  ] as const
  const bookmarkSections = [
    { kind: 'gallery' as const, id: 'history-bookmark-gallery', title: '갤러리에서 북마크한 사진', empty: '아직 북마크한 사진이 없어요' },
    { kind: 'lost' as const, id: 'history-bookmark-lost', title: '북마크한 분실물', empty: '아직 북마크한 분실물이 없어요' },
  ] as const
  return <main id="main-content" className="content-workspace history-workspace">
    <PageHeading title="찾은 기록" description="검색 내용과 결과를 다시 볼 수 있어요." />
    <p className="history-retention">{session
      ? '로그인 후 검색한 기록은 계정에, 비로그인 기록과 북마크는 이 브라우저에 저장해요.'
      : '검색 기록과 북마크는 이 브라우저에 저장해요.'}</p>
    {session && onRetryAccountLoad && <div className="inline-error" role="status"><p>계정 기록을 불러오지 못했어요.</p><RetryButton onClick={onRetryAccountLoad} label="다시 불러오기" /></div>}
    <p className="history-status" role="status" aria-live="polite">{message}</p>
    <div className="history-sections">{sections.map(section => {
      const items = records.filter(record => record.mode === section.mode)
      return <HistorySection key={section.mode} id={'history-' + section.mode} title={section.title} items={items} empty={section.empty}
        action={<Link ref={node => { if (node) startLinks.current.set(section.mode, node); else startLinks.current.delete(section.mode) }} to={section.to} className="button button--secondary history-start">{section.cta}<ArrowUpRight aria-hidden="true" /></Link>}
        renderItem={record => <HistoryRow key={record.id} record={record} onDelete={() => { setMessage(''); setDeleteConfirmation(''); setPendingId(record.id) }} deleteRef={node => { if (node) deleteButtons.current.set(record.id, node); else deleteButtons.current.delete(record.id) }} />} />
    })}{bookmarkSections.map(section => {
      const items = bookmarks.filter(bookmark => bookmark.kind === section.kind)
      return <HistorySection key={section.id} id={section.id} title={section.title} items={items}
        empty={<>{section.empty}<br />검색 결과의 상세 페이지에서 북마크하면 여기에 표시돼요.</>}
        renderItem={entry => <BookmarkRow key={entry.id} entry={entry} onRemove={() => { setMessage(''); setPendingBookmark(entry) }} onUndo={() => undoBookmarkRemoval(entry)} removeRef={node => { if (node) bookmarkButtons.current.set(entry.id, node); else bookmarkButtons.current.delete(entry.id) }} />} />
    })}</div>
    <Modal open={!!pending} title="기록을 삭제할까요?" descriptionId={warningId} focusKey={pendingId ?? 'history-delete'} initialFocus={deleteConfirmationInput} onClose={() => { setPendingId(null); setDeleteConfirmation('') }}>
      {pending && <><p className="history-delete-query">{pending.draft.query || '참고 사진으로 찾기'}</p><p className="field__help">{new Date(pending.createdAt).toLocaleString('ko-KR')}</p></>}
      <p id={warningId}>삭제한 기록은 복구할 수 없어요.<br />사진 원본은 그대로 유지돼요.</p>
      <label className="field history-delete-confirmation" htmlFor={confirmationId}><span>삭제하려면 ‘삭제’를 입력해 주세요.</span><input id={confirmationId} ref={deleteConfirmationInput} autoComplete="off" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label>
      <div className="button-row history-delete-actions"><button type="button" className="button button--secondary" onClick={() => { setPendingId(null); setDeleteConfirmation('') }}>취소</button><button type="button" className="button button--primary" disabled={deleteConfirmation !== '삭제'} onClick={confirmDelete}>삭제</button></div>
    </Modal>
    <Modal open={!!pendingBookmark} title="북마크를 해제할까요?" descriptionId={bookmarkWarningId} focusKey={pendingBookmark?.id ?? 'bookmark-remove'} onClose={() => setPendingBookmark(null)}>
      {pendingBookmark && <><p className="history-delete-query">{pendingBookmark.title}</p><p className="field__help">{pendingBookmark.subtitle}</p></>}
      <p id={bookmarkWarningId}>해제하면 북마크 목록에서 제거돼요.<br />실수로 눌렀다면 페이지를 이동하기 전까지 되돌릴 수 있어요.</p>
      <div className="button-row history-delete-actions"><button type="button" className="button button--secondary" onClick={() => setPendingBookmark(null)}>취소</button><button type="button" className="button button--primary" onClick={confirmBookmarkRemoval}>해제</button></div>
    </Modal>
  </main>
}

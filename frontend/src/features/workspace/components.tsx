import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, ImageOff, Info, MapPin, RotateCcw, ShieldCheck } from 'lucide-react'
import Modal from '../../components/Modal'
import { usePhotoPreview } from '../search/SearchComposer'
import { MAX_LOST_REFERENCE_PHOTOS, REFERENCE_PHOTO_VIEWS, type ReferencePhotoView } from '../search/model'
import { canShowMap, transferPayloads, type Candidate, type CandidateLocation } from '../search/catalog-model'
import { localPhotoId, OFFICIAL_SEARCH_URL, photoFromFile, type AppPhoto } from './data'
import { categoryIcon } from './category-icon'

export function PageHeading({ title, description, action, back }: { title: string; description?: string; action?: ReactNode; back?: { to: string; label: string } }) {
  useEffect(() => { document.title = title + ' — 그거어디?' }, [title])
  return <>{back && <Link className="page-back" to={back.to}><ArrowLeft aria-hidden="true" />{back.label}</Link>}
    <div className="content-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div></>
}

export function DemoNotice({ children = '샘플 화면 · 실제 검색 결과가 아니에요.' }: { children?: ReactNode }) {
  return <p className="demo-banner"><Info aria-hidden="true" /><span>{children}</span></p>
}

export function EmptyState({ title, description, children, error = false }: { title: string; description?: string; children?: ReactNode; error?: boolean }) {
  return <div className={error ? 'empty-state inline-error' : 'empty-state'} role={error ? 'alert' : undefined}>
    {error ? <Info aria-hidden="true" /> : <ImageOff aria-hidden="true" />}<h2>{title}</h2>{description && <p>{description}</p>}{children && <div className="button-row">{children}</div>}
  </div>
}

/** 모든 목록 화면이 공유하는 페이지네이션. 번호 직접 입력 + 이전/다음을 제공한다. */
export function Pagination({ page, pages, onChange, inputId, position = 'bottom', allowBeyond = false }: {
  page: number
  pages: number
  onChange: (page: number) => void
  inputId: string
  position?: 'top' | 'bottom'
  allowBeyond?: boolean
}) {
  const [input, setInput] = useState(String(page))
  useEffect(() => { setInput(String(page)) }, [page])
  const total = Math.max(1, pages)
  const maxPage = allowBeyond ? Math.max(total, page + 1) : total

  function go(next: number) { onChange(Math.min(maxPage, Math.max(1, next))) }
  function submit(event: FormEvent) {
    event.preventDefault()
    const value = input.trim()
    if (!value || !Number.isFinite(Number(value))) { setInput(String(page)); return }
    go(Math.trunc(Number(value)))
  }

  return <div className={'pagination pagination--' + position}>
    <button type="button" className="pagination__nav" disabled={page <= 1} onClick={() => go(page - 1)}>이전</button>
    <form className="pagination__jump" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={inputId}>이동할 페이지 번호</label>
      <input id={inputId} type="number" inputMode="numeric" min={1} max={maxPage} value={input} onChange={event => setInput(event.target.value)} />
      <span className="pagination__total">/ {total}</span>
      <button type="submit" className="pagination__nav pagination__nav--jump">이동</button>
    </form>
    <button type="button" className="pagination__nav" disabled={page >= total && !allowBeyond} onClick={() => go(page + 1)}>다음</button>
  </div>
}

export function SampleScreenshot({ name = '이번 주 일정' }: { name?: string }) {
  return <div className="schedule-preview" role="img" aria-label={name + ' 샘플 스크린샷'}><div className="schedule-preview__title"><span>{name}</span><span>주간</span></div>
    <div className="schedule-preview__days">{['월', '화', '수', '목', '금'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="schedule-preview__grid"><span>기획 검토</span><span>자료 공유</span><span>화면 정리</span></div></div>
}

export function PhotoImage({ photo, className = '' }: { photo: AppPhoto; className?: string }) {
  const local = usePhotoPreview(photo.file)
  const source = local ?? photo.sampleUrl
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  if (!photo.file && !photo.sampleUrl && photo.kind === 'screenshot') return <div className={className}><SampleScreenshot name={photo.name} /></div>
  return source && !failed ? <img className={className} src={source} alt={photo.name} onError={() => setFailed(true)} /> : <div className={'no-photo ' + className}><ImageOff aria-hidden="true" /><span>{failed ? '사진을 열 수 없어요' : '사진 준비 중'}</span></div>
}

export function PhotoViewer({ photo, open, onClose, footer, className = '' }: { photo: AppPhoto; open: boolean; onClose: () => void; footer?: ReactNode; className?: string }) {
  return <Modal open={open} title={photo.name} focusKey={'viewer-' + photo.id} className={'photo-viewer ' + className} onClose={onClose} footer={footer}><div className="viewer-photo"><PhotoImage photo={photo} /></div></Modal>
}

export function NoPhoto({ message = '등록된 사진 없음', category }: { message?: string; category?: string | null }) {
  const hasCategory = !!category?.trim()
  const Icon = hasCategory ? categoryIcon(category) : ImageOff
  return <div className={hasCategory ? 'no-photo no-photo--category' : 'no-photo'}>
    <Icon aria-hidden="true" />
    <span>{message}</span>
    {hasCategory && <small className="no-photo__category">{category}</small>}
  </div>
}

export function FoundCard({ item, to, context = false }: { item: Candidate; to: string; context?: boolean }) {
  const [failed, setFailed] = useState(false)
  const photo = item.photoStatus === 'verified_photo' && item.image && !failed
  return <Link to={to} className={context ? 'context-card' : 'found-card'}>
    <div className={context ? 'context-card__image' : 'found-card__image'}>{photo ? <img src={item.image!} alt={item.title + ' 사진'} loading="lazy" onError={() => setFailed(true)} /> : <NoPhoto message={failed ? '사진 표시 오류' : undefined} category={item.category} />}</div>
    <div className={context ? 'context-card__body' : 'found-card__body'}><h3>{item.title}</h3>{!context && <p>{item.color} · {item.category}</p>}
      {context && <><div className="match-reasons">{item.matchReasons.map(reason => <span key={reason}>{reason}</span>)}</div><p>{item.foundPlace}</p></>}
      <small>{item.foundAt}</small></div>
    {context && <ArrowRight className="context-card__actions" aria-label="상세 보기" />}
  </Link>
}

function QueryReferencePhoto({ file, index, view = 'unspecified' }: { file: File; index: number; view?: ReferencePhotoView }) {
  const [open, setOpen] = useState(false)
  const photo = photoFromFile(file, localPhotoId(file))
  const viewLabel = REFERENCE_PHOTO_VIEWS.find(option => option.value === view)?.label ?? '미지정'
  const direction = view === 'unspecified' ? '방향 미지정' : '선택한 방향 ' + viewLabel
  return <div className="query-summary__photo-item"><button type="button" className="query-summary__photo-button" aria-label={'참고 사진 ' + (index + 1) + ', ' + direction + ', 크게 보기: ' + file.name} aria-haspopup="dialog" onClick={() => setOpen(true)}><PhotoImage photo={photo} /></button>
    <span className="query-summary__photo-view">{viewLabel}</span>
    <PhotoViewer photo={photo} open={open} onClose={() => setOpen(false)} />
  </div>
}

export function QuerySummary({ query, photo, photos, photoViews, editTo, onEdit }: { query: string; photo: File | null; photos?: readonly File[]; photoViews?: readonly ReferencePhotoView[]; editTo: string; onEdit?: () => void }) {
  const preview = usePhotoPreview(photos === undefined ? photo : null)
  const hasPhoto = photos === undefined ? !!photo : photos.length > 0
  return <div className="query-summary">{photos === undefined ? preview && <img className="query-summary__photo" src={preview} alt="검색에 참고한 사진" />
    : photos.length > 0 && <div className="query-summary__photos" role="group" aria-label={'검색에 참고한 사진 ' + photos.length + '장'}>{photos.map((file, index) => <QueryReferencePhoto file={file} index={index} view={photoViews?.[index]} key={localPhotoId(file) + '-' + index} />)}{photos.length > 1 && <span className="query-summary__photo-count">사진 {photos.length}장</span>}</div>}
    <p>{query || (hasPhoto ? '참고 사진으로 찾기' : '샘플 검색')}</p><SearchEditAction to={editTo} onEdit={onEdit} /></div>
}

export function SearchEditAction({ to, onEdit, children = '검색 수정', primary = false }: { to: string; onEdit?: () => void; children?: ReactNode; primary?: boolean }) {
  const className = 'button ' + (primary ? 'button--primary' : 'button--secondary')
  return onEdit ? <button type="button" className={className} onClick={onEdit}>{children}</button> : <Link className={className} to={to}>{children}</Link>
}

const locationMessages: Record<CandidateLocation['status'], string> = {
  verified: '방문 전 보관 여부를 확인해 주세요.', address_only: '지도 위치는 아직 확인되지 않았어요.', ambiguous: '보관기관 위치를 정확히 확인하지 못했어요.', missing: '확인된 위치 정보가 없어요.', provider_error: '지도를 불러오지 못했어요.',
}

export function LocationCard({ item, location = item.location }: { item: Candidate; location?: CandidateLocation }) {
  const showMap = canShowMap(location)
  return <section className="institution-card" aria-labelledby="institution-heading"><div className="section-heading"><h2 id="institution-heading">보관기관 및 위치</h2><MapPin aria-hidden="true" /></div>
    <h3>{item.custodyName ?? '보관기관 정보 없음'}</h3>{location.address && <p>{location.address}</p>}
    {item.mapUrl ? <div className="location-fallback"><MapPin aria-hidden="true" /><p>아래 링크에서 실제 보관기관 위치를 확인해 주세요.</p></div>
      : showMap ? <div className="mini-map" role="img" aria-label="샘플 지도 구성. 실제 기관 위치가 아닙니다."><svg viewBox="0 0 600 160" aria-hidden="true"><rect width="600" height="160" fill="#eff0eb" /><path d="M0 45H600M0 115H600M100 0V160M310 0V160M500 0V160" stroke="#fff" strokeWidth="18" /><circle cx="310" cy="80" r="12" fill="#222322" /><circle cx="310" cy="80" r="4" fill="#e5db72" /></svg><span>샘플 지도 · 실제 위치가 아니에요</span></div>
        : <div className="location-fallback"><MapPin aria-hidden="true" /><p>{locationMessages[location.status]}</p></div>}
    <p className="field__help">실제 보관 여부는 연락처로 문의 부탁드립니다.</p>
    <div className="button-row">
      {item.mapUrl && <a className="button button--secondary" href={item.mapUrl} target="_blank" rel="noreferrer">카카오맵에서 보기<ArrowRight aria-hidden="true" /></a>}
      <a className="button button--secondary" href={item.officialUrl ?? OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">{item.officialUrl ? '공식 정보 확인' : '공식 검색 안내'}<ArrowRight aria-hidden="true" /></a>
    </div>
  </section>
}

export function TransferDialog({ photos, open, onClose, onTransfer, initialPhotoId }: { photos: readonly AppPhoto[]; open: boolean; onClose: () => void; onTransfer: (photos: readonly AppPhoto[]) => Promise<void>; initialPhotoId?: string }) {
  const availablePhotos = photos.slice(0, MAX_LOST_REFERENCE_PHOTOS)
  const photoKey = availablePhotos.map(photo => photo.id).join('|')
  const [activeId, setActiveId] = useState(initialPhotoId ?? availablePhotos[0]?.id ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>(initialPhotoId && availablePhotos.some(photo => photo.id === initialPhotoId) ? [initialPhotoId] : availablePhotos[0] ? [availablePhotos[0].id] : [])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open && photoKey === '') return
    const firstId = initialPhotoId && availablePhotos.some(photo => photo.id === initialPhotoId) ? initialPhotoId : availablePhotos[0]?.id ?? ''
    setActiveId(firstId)
    setSelectedIds(firstId ? [firstId] : [])
    setConfirmed(false)
    setError('')
  }, [open, photoKey, initialPhotoId])
  const activePhoto = availablePhotos.find(photo => photo.id === activeId) ?? availablePhotos[0]
  function togglePhoto(photoId: string) {
    if (busy) return
    if (selectedIds.includes(photoId)) {
      const next = selectedIds.filter(id => id !== photoId)
      setSelectedIds(next)
      if (activeId === photoId) setActiveId(next[0] ?? photoId)
      return
    }
    if (selectedIds.length >= MAX_LOST_REFERENCE_PHOTOS) return
    setSelectedIds([...selectedIds, photoId])
    setActiveId(photoId)
  }
  if (!activePhoto) return null
  const selectedPhotos = availablePhotos.filter(photo => selectedIds.includes(photo.id))
  return <Modal open={open} title="분실물 찾기에 사용할 사진" focusKey={'transfer-' + activePhoto.id} onClose={() => { if (!busy) onClose() }}>
    <PhotoImage photo={activePhoto} className="transfer-photo" />
    {availablePhotos.length > 1 && <><p className="transfer-photo-picker__label">검색에 사용할 사진 <span>{selectedPhotos.length}/{MAX_LOST_REFERENCE_PHOTOS}</span></p><div className="transfer-photo-picker" role="group" aria-label="분실물 검색에 사용할 사진 선택">{availablePhotos.map((photo, index) => { const selected = selectedIds.includes(photo.id); return <button type="button" key={photo.id} className={'transfer-photo-picker__item' + (selected ? ' is-selected' : '')} aria-pressed={selected} aria-label={'사진 ' + (index + 1) + (selected ? ' 선택 해제' : ' 선택')} onClick={() => togglePhoto(photo.id)}><PhotoImage photo={photo} /><span className="transfer-photo-picker__mark">{selected ? <Check aria-hidden="true" /> : index + 1}</span></button> })}</div></>}
    <p>선택한 사진 {selectedPhotos.length}장으로 새 검색을 시작해요.</p>
    <p className="storage-note">정식 검색에서는 선택한 사진만 서버에서 일시 처리해요. 사진 보관함에 자동 저장하지 않아요.</p>
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />선택한 사진만 분실물 검색에 사용해요</label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="button-row"><button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>취소</button>
      <button type="button" className="button button--primary" disabled={!confirmed || !selectedPhotos.length || busy} onClick={async () => {
        const payload = transferPayloads(selectedIds, confirmed)
        if (!payload) return
        setBusy(true)
        try { await onTransfer(selectedPhotos) } catch { setError('사진을 열지 못했어요. 다시 선택해 주세요.') } finally { setBusy(false) }
      }}>{busy ? '사진 준비 중' : selectedPhotos.length > 1 ? `사진 ${selectedPhotos.length}장으로 찾기` : '이 사진으로 찾기'}</button></div>
    <p className="field__help"><ShieldCheck aria-hidden="true" />현재 체험에서는 서버 전송이 없어요.</p>
  </Modal>
}

export function RetryButton({ onClick }: { onClick: () => void }) { return <button type="button" className="button button--secondary" onClick={onClick}><RotateCcw aria-hidden="true" />다시 보기</button> }

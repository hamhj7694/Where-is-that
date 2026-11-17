import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ImageOff, Info, MapPin, RotateCcw, ShieldCheck } from 'lucide-react'
import Modal from '../../components/Modal'
import { usePhotoPreview } from '../search/SearchComposer'
import { canShowMap, transferPayload, type Candidate, type CandidateLocation } from '../search/catalog-model'
import { localPhotoId, OFFICIAL_SEARCH_URL, photoFromFile, type AppPhoto } from './data'

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

export function NoPhoto({ message = '등록된 사진 없음' }: { message?: string }) {
  return <div className="no-photo"><ImageOff aria-hidden="true" /><span>{message}</span></div>
}

export function FoundCard({ item, to, context = false }: { item: Candidate; to: string; context?: boolean }) {
  const [failed, setFailed] = useState(false)
  const photo = item.photoStatus === 'verified_photo' && item.image && !failed
  return <Link to={to} className={context ? 'context-card' : 'found-card'}>
    <div className={context ? 'context-card__image' : 'found-card__image'}>{photo ? <img src={item.image!} alt={item.title + ' 샘플 사진'} loading="lazy" onError={() => setFailed(true)} /> : <NoPhoto message={failed ? '사진 표시 오류' : undefined} />}</div>
    <div className={context ? 'context-card__body' : 'found-card__body'}><h3>{item.title}</h3>{!context && <p>{item.color} · {item.category}</p>}
      {context && <><div className="match-reasons">{item.matchReasons.map(reason => <span key={reason}>{reason}</span>)}</div><p>{item.foundPlace}</p></>}
      <small>{item.foundAt} · 샘플</small></div>
    {context && <ArrowRight className="context-card__actions" aria-label="상세 보기" />}
  </Link>
}

function QueryReferencePhoto({ file, index }: { file: File; index: number }) {
  const [open, setOpen] = useState(false)
  const photo = photoFromFile(file, localPhotoId(file))
  return <><button type="button" className="query-summary__photo-button" aria-label={'참고 사진 ' + (index + 1) + ' 크게 보기: ' + file.name} aria-haspopup="dialog" onClick={() => setOpen(true)}><PhotoImage photo={photo} /></button>
    <PhotoViewer photo={photo} open={open} onClose={() => setOpen(false)} />
  </>
}

export function QuerySummary({ query, photo, photos, editTo, onEdit }: { query: string; photo: File | null; photos?: readonly File[]; editTo: string; onEdit?: () => void }) {
  const preview = usePhotoPreview(photos === undefined ? photo : null)
  const hasPhoto = photos === undefined ? !!photo : photos.length > 0
  return <div className="query-summary">{photos === undefined ? preview && <img className="query-summary__photo" src={preview} alt="검색에 참고한 사진" />
    : photos.length > 0 && <div className="query-summary__photos" role="group" aria-label={'검색에 참고한 사진 ' + photos.length + '장'}>{photos.map((file, index) => <QueryReferencePhoto file={file} index={index} key={localPhotoId(file) + '-' + index} />)}{photos.length > 1 && <span className="query-summary__photo-count">사진 {photos.length}장</span>}</div>}
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
    {showMap ? <div className="mini-map" role="img" aria-label="샘플 지도 구성. 실제 기관 위치가 아닙니다."><svg viewBox="0 0 600 160" aria-hidden="true"><rect width="600" height="160" fill="#eff0eb" /><path d="M0 45H600M0 115H600M100 0V160M310 0V160M500 0V160" stroke="#fff" strokeWidth="18" /><circle cx="310" cy="80" r="12" fill="#222322" /><circle cx="310" cy="80" r="4" fill="#e5db72" /></svg><span>샘플 지도 · 실제 위치가 아니에요</span></div>
      : <div className="location-fallback"><MapPin aria-hidden="true" /><p>{locationMessages[location.status]}</p></div>}
    <p className="field__help">같은 물건인지, 현재 보관 중인지 확인해 주세요.</p>
    <a className="button button--secondary" href={item.officialUrl ?? OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">{item.officialUrl ? '공식 정보 확인' : '공식 검색 안내'}<ArrowRight aria-hidden="true" /></a>
  </section>
}

export function TransferDialog({ photo, open, onClose, onTransfer }: { photo: AppPhoto; open: boolean; onClose: () => void; onTransfer: (photo: AppPhoto) => Promise<void> }) {
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) { setConfirmed(false); setError('') } }, [open, photo.id])
  return <Modal open={open} title="이 사진으로 분실물 찾기" focusKey={photo.id} onClose={() => { if (!busy) onClose() }}>
    <PhotoImage photo={photo} className="transfer-photo" /><p>선택한 사진 한 장으로 새 검색을 시작해요.</p>
    <p className="storage-note">정식 검색에서는 이 사진만 서버에서 일시 처리해요. 소중한 것들에 자동 저장하지 않아요.</p>
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />선택한 사진만 사용해요</label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="button-row"><button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>취소</button>
      <button type="button" className="button button--primary" disabled={!confirmed || busy} onClick={async () => {
        if (!transferPayload(photo.id, confirmed)) return
        setBusy(true)
        try { await onTransfer(photo) } catch { setError('사진을 열지 못했어요. 다시 선택해 주세요.') } finally { setBusy(false) }
      }}>{busy ? '사진 준비 중' : '이 사진으로 찾기'}</button></div>
    <p className="field__help"><ShieldCheck aria-hidden="true" />현재 체험에서는 서버 전송이 없어요.</p>
  </Modal>
}

export function RetryButton({ onClick }: { onClick: () => void }) { return <button type="button" className="button button--secondary" onClick={onClick}><RotateCcw aria-hidden="true" />다시 보기</button> }

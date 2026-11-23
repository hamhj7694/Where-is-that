import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ImagePlus, LockKeyhole, Plus, Search, Trash2, X } from 'lucide-react'
import Modal from '../../components/Modal'
import { MAX_LOST_REFERENCE_PHOTOS, REFERENCE_PHOTO_VIEWS, type ReferencePhotoView } from '../search/model'
import { registrationComplete, type RegistrationProgress } from '../search/catalog-model'
import LostReferenceDialog from '../search/LostReferenceDialog'
import { DemoNotice, EmptyState, PageHeading, PhotoImage, PhotoViewer, TransferDialog } from './components'
import { isDeleteConfirmation, localPhotoId, photoFromFile, valuableCreatedAt, valuableStatusLabels, type AppPhoto, type Valuable, type ValuableStatus } from './data'

export interface ValuableProps {
  session: boolean
  items: Valuable[]
  onSave: (item: Valuable) => void
  onDelete: (id: string) => void
  onTransfer: (photos: readonly AppPhoto[]) => Promise<void>
  onView?: (id: string) => void
}

export function AuthGate({ returnTo = '/valuables' }: { returnTo?: string }) {
  return <main id="main-content" className="content-workspace"><div className="login-panel"><LockKeyhole aria-hidden="true" /><PageHeading title="소중한 물건 사진을 계정에" description="사진 원본과 사진별 검색정보를 보관해요." />
    <Link className="button button--primary" to={'/auth/login?returnTo=' + encodeURIComponent(returnTo)}>로그인하고 시작하기</Link><Link className="button button--secondary" to="/">검색으로 돌아가기</Link>
    <p className="field__help">갤러리·분실물 검색은 로그인 없이 이용해요.</p></div></main>
}

type ValuableSort = 'latest' | 'updated' | 'viewed' | 'title'

function valuableSearchFields(item: Valuable) {
  return [item.name, item.category, item.notes].map(value => value.toLocaleLowerCase('ko-KR'))
}

function formatValuableDate(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return '등록 날짜 확인 중'
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(value)
}

function formatValuableDateTime(value: number | undefined, fallback = '시간 정보 없음') {
  if (!value || !Number.isFinite(value)) return fallback
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value)
}

function valuablePhotoViewLabel(photo: AppPhoto) {
  return REFERENCE_PHOTO_VIEWS.find(option => option.value === photo.photoView)?.label ?? '미지정'
}

export function ValuablesList({ session, items }: ValuableProps) {
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ValuableSort>('latest')
  if (!session || params.get('state') === 'expired') return <AuthGate />
  const shown = params.get('state') === 'empty' ? [] : items
  const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR')
  const keywordMatches = normalizedQuery ? shown.filter(item => valuableSearchFields(item).some(field => field.includes(normalizedQuery))) : shown
  const searchMode = !normalizedQuery ? null : keywordMatches.length ? 'keyword' : 'natural'
  const naturalTokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const filtered = !normalizedQuery ? shown : searchMode === 'keyword' ? keywordMatches : shown.filter(item => {
    const fields = valuableSearchFields(item).join(' ')
    const hits = naturalTokens.filter(token => fields.includes(token)).length
    return hits >= Math.max(1, Math.ceil(naturalTokens.length / 2))
  })
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'title') return a.name.localeCompare(b.name, 'ko')
    if (sort === 'updated') return b.updatedAt - a.updatedAt
    if (sort === 'viewed') return (b.viewedAt ?? 0) - (a.viewedAt ?? 0)
    return valuableCreatedAt(b) - valuableCreatedAt(a)
  })
  return <main id="main-content" className="content-workspace"><PageHeading title="소중한 물건 사진 보관함" description="소중한 물건을 잃어버리기 전에 사진을 미리 등록해 보세요!" action={<Link className="button button--primary" to="/valuables/new"><Plus aria-hidden="true" />물건 추가</Link>} /><DemoNotice>임시 목록 · 로그인한 계정에 저장돼요.</DemoNotice>
    <div className="valuable-list-tools" role="search" aria-label="사진 보관함 검색과 정렬"><label className="valuable-search-field"><Search aria-hidden="true" /><span className="visually-hidden">사진 보관함 검색</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="물건 이름이나 특징 검색" /></label><label className="valuable-sort-field"><span>정렬</span><select value={sort} onChange={event => setSort(event.target.value as ValuableSort)}><option value="latest">최신 등록순</option><option value="updated">최신 수정순</option><option value="viewed">최신 조회순</option><option value="title">제목순</option></select></label></div>
    {normalizedQuery && <p className="valuable-search-status" role="status">{searchMode === 'keyword' ? '키워드 검색' : '자연어 검색 · 현재는 등록한 정보의 단어를 기준으로 찾아요.'} · {sorted.length}개</p>}
    {sorted.length ? <div className="item-grid">{sorted.map(item => <Link className="valuable-card" key={item.id} to={'/valuables/' + item.id}><div className="photo-card__image"><PhotoImage photo={item.photos[0]} /></div><div className="photo-card__caption"><h2>{item.name}</h2><p>{item.category} · 사진 {item.photos.length}장</p><p className="valuable-card__date">등록 날짜 · {formatValuableDate(valuableCreatedAt(item))}</p><span className="status-badge">{valuableStatusLabels[item.status]}</span></div></Link>)}</div>
      : normalizedQuery ? <EmptyState title="검색 결과가 없어요" description="다른 이름이나 특징으로 검색해 보세요." /> : <EmptyState title="아직 등록한 물건이 없어요" description="오래 간직할 물건을 사진으로 남겨보세요."><Link className="button button--primary" to="/valuables/new">첫 물건 추가</Link></EmptyState>}
  </main>
}

function RegistrationState({ state }: { state: string }) {
  const [params, setParams] = useSearchParams()
  const stages: Record<string, RegistrationProgress> = {
    'original-saving': { originals: 'saving', vectors: 'idle' }, 'vector-saving': { originals: 'saved', vectors: 'saving' },
    'original-error': { originals: 'failed', vectors: 'idle' }, 'vector-error': { originals: 'saved', vectors: 'failed' },
    complete: { originals: 'saved', vectors: 'saved' },
  }
  const progress = stages[state]
  if (!progress) return null
  const labels = { idle: '대기', saving: '처리 중', saved: '저장됨', failed: '실패' }
  return <div className="storage-note" role="status"><strong>{registrationComplete(progress) ? '완료 상태 예시' : '저장 상태 예시'}</strong><p>사진 원본 · {labels[progress.originals]} / 검색정보 · {labels[progress.vectors]}</p><small>실제 서버 저장은 진행되지 않아요.</small>{state.endsWith('error') && <button type="button" className="button button--secondary" onClick={() => { const next = new URLSearchParams(params); next.delete('state'); setParams(next) }}>다시 작성</button>}</div>
}

export function ValuableEditor(props: ValuableProps) {
  const { id } = useParams()
  const { pathname, search } = useLocation()
  if (!props.session) return <AuthGate returnTo={pathname + search} />
  const item = id ? props.items.find(value => value.id === id) : undefined
  if (id && !item) return <main id="main-content" className="content-workspace"><PageHeading title="물건 수정" /><EmptyState title="임시 항목을 찾을 수 없어요" description="새로고침하면 체험용 항목은 사라져요."><Link to="/valuables" className="button button--primary">목록으로</Link></EmptyState></main>
  return <ValuableForm key={id ?? 'new'} {...props} item={item} />
}

function ValuableForm({ item, onSave }: ValuableProps & { item?: Valuable }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [name, setName] = useState(item?.name ?? '')
  const [category, setCategory] = useState(item?.category ?? '기타')
  const [status, setStatus] = useState<ValuableStatus>(item?.status ?? 'kept')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [photos, setPhotos] = useState<AppPhoto[]>(item?.photos ?? [])
  const [photoDialogOpen, setPhotoDialogOpen] = useState(false)
  const [photoDeleteIndex, setPhotoDeleteIndex] = useState<number | null>(null)
  const [photoDeleteConfirmation, setPhotoDeleteConfirmation] = useState('')
  const [photoIndex, setPhotoIndex] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [error, setError] = useState('')
  const photoButton = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const photoDeleteInput = useRef<HTMLInputElement>(null)
  const dialogPhotos = photos.filter(photo => photo.file).map(photo => photo.file!)
  const dialogKey = dialogPhotos.map(file => localPhotoId(file)).join('|') || 'empty'
  const selectedPhoto = photos[Math.min(photoIndex, Math.max(0, photos.length - 1))]
  function commitPhotos(files: File[], views: ReferencePhotoView[]) {
    const existingNonFilePhotos = photos.filter(photo => !photo.file)
    const next = files.map((file, index) => {
      const existing = photos.find(photo => photo.file === file)
      return { ...(existing ?? photoFromFile(file, crypto.randomUUID())), photoView: views[index] ?? 'unspecified' }
    })
    const committed = [...existingNonFilePhotos, ...next].slice(0, MAX_LOST_REFERENCE_PHOTOS)
    setPhotos(committed)
    setPhotoIndex(Math.max(0, committed.length - 1))
    setError('')
    setPhotoDialogOpen(false)
  }
  function removePhoto(index: number) {
    setPhotos(previous => {
      const next = previous.filter((_, position) => position !== index)
      setPhotoIndex(current => Math.min(current, Math.max(0, next.length - 1)))
      return next
    })
  }
  function confirmPhotoRemoval() {
    if (photoDeleteIndex === null || !isDeleteConfirmation(photoDeleteConfirmation)) return
    removePhoto(photoDeleteIndex)
    setPhotoDeleteIndex(null)
    setPhotoDeleteConfirmation('')
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setError('물건 이름을 적어 주세요.'); nameInput.current?.focus(); return }
    if (!photos.length) { setError('사진을 한 장 이상 추가해 주세요.'); photoButton.current?.focus(); return }
    setError(''); setAgreed(false); setReviewOpen(true)
  }
  function saveDraft() {
    if (!agreed) return
    const now = Date.now()
    const value: Valuable = { id: item?.id ?? crypto.randomUUID(), name: name.trim(), category, status, notes: notes.trim(), photos, createdAt: item?.createdAt ?? now, viewedAt: item?.viewedAt, updatedAt: now }
    onSave(value); setReviewOpen(false); navigate('/valuables/' + value.id)
  }
  return <main id="main-content" className="content-workspace"><PageHeading title={item ? '물건 수정' : '소중한 물건 남기기'} back={{ to: item ? '/valuables/' + item.id : '/valuables', label: item ? '수정 취소' : '목록으로' }} /><DemoNotice>임시 항목 · 로그인한 계정에 저장돼요.</DemoNotice>
    <RegistrationState state={params.get('state') ?? ''} />
    <form className="form-layout" onSubmit={submit}><div><div className="section-heading"><h2>물건 사진 <span>{photos.length}장</span></h2><button ref={photoButton} type="button" className="button button--secondary" onClick={() => setPhotoDialogOpen(true)} disabled={photos.length >= MAX_LOST_REFERENCE_PHOTOS}><ImagePlus aria-hidden="true" />사진 추가</button></div>
      {photos.length ? <div className="valuable-photo-browser"><div className="valuable-photo-thumbnails" aria-label="물건 사진 목록">{photos.map((photo, index) => <div className="valuable-photo-thumbnail-item" key={photo.id}><button type="button" className={'valuable-photo-thumbnail' + (photoIndex === index ? ' is-selected' : '')} aria-label={`${photo.name} · ${valuablePhotoViewLabel(photo)} 방향 사진`} aria-pressed={photoIndex === index} onClick={() => setPhotoIndex(index)}><PhotoImage photo={photo} /></button><span>{valuablePhotoViewLabel(photo)}</span></div>)}</div><div className="valuable-photo-main"><div className="valuable-photo-main__image"><PhotoImage photo={selectedPhoto} /></div><div className="valuable-photo-main__caption"><strong>{selectedPhoto.name}</strong><span className="valuable-photo-main__view">{valuablePhotoViewLabel(selectedPhoto)}</span><button type="button" className="icon-button" aria-label={selectedPhoto.name + ' 빼기'} onClick={() => { setPhotoDeleteIndex(Math.min(photoIndex, photos.length - 1)); setPhotoDeleteConfirmation('') }}><X aria-hidden="true" /></button></div></div></div>
        : <div className="empty-state photo-empty"><p>물건 전체와 특징을 담아 주세요.</p></div>}
    </div><div><div className="field"><label htmlFor="valuable-name">물건 이름</label><input ref={nameInput} id="valuable-name" value={name} maxLength={60} onChange={e => { setName(e.target.value); setError('') }} placeholder="예: 매일 쓰는 지갑" /></div>
      <div className="form-pair"><div className="field"><label htmlFor="valuable-category">분류</label><select id="valuable-category" value={category} onChange={e => setCategory(e.target.value)}>{['지갑', '가방', '열쇠', '전자기기', '기타'].map(value => <option key={value}>{value}</option>)}</select></div><div className="field"><label htmlFor="valuable-status">물건 상태</label><select id="valuable-status" value={status} onChange={e => setStatus(e.target.value as ValuableStatus)}>{(Object.keys(valuableStatusLabels) as ValuableStatus[]).map(value => <option value={value} key={value}>{valuableStatusLabels[value]}</option>)}</select></div></div>
      <div className="field"><label htmlFor="valuable-notes">기억할 특징 <span>선택</span></label><textarea id="valuable-notes" value={notes} maxLength={600} rows={3} onChange={e => setNotes(e.target.value)} placeholder="색상, 흠집, 각인처럼 구별되는 특징" /></div>
      <p className="storage-note">등록한 사진 원본을 로그인한 계정에 저장해요.</p>
      <details className="storage-note"><summary>저장 범위 자세히</summary><p>사진별로 찾는 데 쓰는 정보는 아직 만들지 않아요. 갤러리 전체는 자동 등록하지 않아요.</p><p>저장한 내용은 목록·상세에서 확인하고 삭제할 수 있어요.</p></details>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="button-row"><Link className="button button--secondary" to={item ? '/valuables/' + item.id : '/valuables'}>취소</Link><button className="button button--primary" type="submit">{item ? '변경 내용 확인' : '등록 내용 확인'}</button></div>
    </div></form>
    <LostReferenceDialog key={dialogKey} open={photoDialogOpen} photos={dialogPhotos} views={dialogPhotos.map(file => photos.find(photo => photo.file === file)?.photoView ?? 'unspecified')} selected={0} dropped={[]} guideOpen={false} onGuideToggle={() => undefined} onClose={() => setPhotoDialogOpen(false)} onConfirm={commitPhotos} variant="valuable" />
    <Modal open={photoDeleteIndex !== null} title="사진을 제외할까요?" focusKey="valuable-photo-delete" initialFocus={photoDeleteInput} onClose={() => { setPhotoDeleteIndex(null); setPhotoDeleteConfirmation('') }}><p><strong>{photos[photoDeleteIndex ?? -1]?.name}</strong> 사진을 이 물건에서 제외해요. 기기의 원본 파일은 그대로 유지돼요.</p><label className="field photo-delete-confirmation"><span>계속하려면 ‘삭제’를 입력해 주세요.</span><input ref={photoDeleteInput} autoComplete="off" value={photoDeleteConfirmation} onChange={event => setPhotoDeleteConfirmation(event.target.value)} /></label><div className="button-row"><button type="button" className="button button--secondary" onClick={() => { setPhotoDeleteIndex(null); setPhotoDeleteConfirmation('') }}>취소</button><button type="button" className="button button--primary" disabled={!isDeleteConfirmation(photoDeleteConfirmation)} onClick={confirmPhotoRemoval}>삭제</button></div></Modal>
    <Modal open={reviewOpen} title={item ? '변경 내용 확인' : '등록 내용 확인'} focusKey="review-valuable" onClose={() => setReviewOpen(false)} footer={<div className="button-row"><button type="button" className="button button--secondary" onClick={() => setReviewOpen(false)}>취소</button><button type="button" className="button button--primary" disabled={!agreed} onClick={saveDraft}>{item ? '변경 적용' : '임시로 추가'}</button></div>}>
      <dl className="detail-facts"><div><dt>물건</dt><dd>{name.trim()}</dd></div><div><dt>사진</dt><dd>원본 {photos.length}장</dd></div><div><dt>분류·상태</dt><dd>{category} · {valuableStatusLabels[status]}</dd></div></dl>
      <p className="storage-note">저장한 사진과 입력 정보는 로그인한 계정에 보관돼요.</p><label className="checkbox-row"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />저장 범위를 확인했어요</label>
    </Modal>
  </main>
}

export function ValuableDetail({ session, items, onDelete, onTransfer, onView }: ValuableProps) {
  const { id } = useParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [photoIndex, setPhotoIndex] = useState(0)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [error, setError] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const deleteConfirmationInput = useRef<HTMLInputElement>(null)
  const item = items.find(value => value.id === id)
  const viewedItemId = useRef<string | null>(null)
  useEffect(() => {
    if (!session || !item || params.get('state') === 'missing' || viewedItemId.current === item.id) return
    viewedItemId.current = item.id
    onView?.(item.id)
  }, [item?.id, onView])
  if (!session) return <AuthGate returnTo={pathname} />
  if (!item || params.get('state') === 'missing') return <main id="main-content" className="content-workspace"><PageHeading title="소중한 물건 사진 보관함" /><EmptyState title="임시 항목을 찾을 수 없어요"><Link to="/valuables" className="button button--primary">목록으로</Link></EmptyState></main>
  const selected = item.photos[Math.min(photoIndex, item.photos.length - 1)]
  return <main id="main-content" className="content-workspace"><PageHeading title={item.name} back={{ to: '/valuables', label: '목록으로' }} action={<Link to={'/valuables/' + item.id + '/edit'} className="button button--secondary">수정</Link>} /><DemoNotice>임시 항목 · 로그인한 계정에 저장됐어요.</DemoNotice>
    <div className="detail-layout"><div><div className="detail-photo"><button className="photo-open" onClick={() => setViewerOpen(true)} aria-label={`${selected.name} · ${valuablePhotoViewLabel(selected)} 크게 보기`}><PhotoImage photo={selected} /><span className="photo-open__view">{valuablePhotoViewLabel(selected)}</span><span>크게 보기</span></button></div>{item.photos.length > 1 && <div className="photo-thumbnails">{item.photos.map((photo, index) => <div className="photo-thumbnail-item" key={photo.id}><button className="photo-thumbnail" aria-label={`${photo.name} · ${valuablePhotoViewLabel(photo)} 방향 사진 보기`} aria-pressed={photoIndex === index} onClick={() => setPhotoIndex(index)}><PhotoImage photo={photo} /></button><span>{valuablePhotoViewLabel(photo)}</span></div>)}</div>}</div>
      <div><span className="status-badge">{valuableStatusLabels[item.status]}</span><dl className="detail-facts"><div><dt>분류</dt><dd>{item.category}</dd></div><div><dt>사진</dt><dd>{item.photos.length}장</dd></div><div><dt>생성 시간</dt><dd>{formatValuableDateTime(valuableCreatedAt(item))}</dd></div><div><dt>최신 수정 시간</dt><dd>{formatValuableDateTime(item.updatedAt)}</dd></div><div><dt>최신 조회 시간</dt><dd>{formatValuableDateTime(item.viewedAt, '아직 조회 기록이 없어요')}</dd></div>{item.notes && <div><dt>특징</dt><dd className="preserve-whitespace">{item.notes}</dd></div>}</dl>
        <div className="detail-actions"><button className="button button--primary" onClick={() => setTransferOpen(true)}>이 사진으로 분실물 찾기</button><button className="button button--secondary" onClick={() => { setError(''); setDeleteConfirmation(''); setDeleteOpen(true) }}><Trash2 aria-hidden="true" />임시 항목 삭제</button></div></div></div>
    <TransferDialog photos={item.photos} initialPhotoId={selected.id} open={transferOpen} onClose={() => setTransferOpen(false)} onTransfer={onTransfer} />
    <PhotoViewer photo={selected} open={viewerOpen} onClose={() => setViewerOpen(false)} />
    <Modal open={deleteOpen} title="임시 항목을 삭제할까요?" focusKey="delete-valuable" initialFocus={deleteConfirmationInput} onClose={() => { setDeleteOpen(false); setDeleteConfirmation('') }}><p>이 항목의 사진과 입력 정보를 지워요. 기기 원본은 그대로예요.</p>{error && <p role="alert" className="form-error">{error}</p>}<label className="field history-delete-confirmation"><span>삭제하려면 ‘삭제’를 입력해 주세요.</span><input ref={deleteConfirmationInput} autoComplete="off" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label><div className="button-row"><button className="button button--secondary" onClick={() => { setDeleteOpen(false); setDeleteConfirmation('') }}>취소</button><button className="button button--primary" disabled={deleteConfirmation !== '삭제'} onClick={() => { if (deleteConfirmation !== '삭제') return; if (params.get('state') === 'delete-error') { setError('삭제하지 못했어요. 다시 시도해 주세요.'); return } onDelete(item.id); setDeleteOpen(false); setDeleteConfirmation(''); navigate('/valuables') }}>삭제</button></div></Modal>
  </main>
}

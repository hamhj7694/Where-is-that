import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ImagePlus, LockKeyhole, Plus, Trash2, X } from 'lucide-react'
import Modal from '../../components/Modal'
import { assertImageReadable } from '../search/model'
import { registrationComplete, type RegistrationProgress } from '../search/catalog-model'
import { DemoNotice, EmptyState, PageHeading, PhotoImage, PhotoViewer, TransferDialog } from './components'
import { photoFromFile, samplePhotos, valuableStatusLabels, type AppPhoto, type Valuable, type ValuableStatus } from './data'

export interface ValuableProps {
  session: boolean
  items: Valuable[]
  onSave: (item: Valuable) => void
  onDelete: (id: string) => void
  onTransfer: (photo: AppPhoto) => Promise<void>
}

export function AuthGate({ returnTo = '/valuables' }: { returnTo?: string }) {
  return <main id="main-content" className="content-workspace"><div className="login-panel"><LockKeyhole aria-hidden="true" /><PageHeading title="소중한 것들을 내 계정에" description="사진 원본과 사진별 검색정보를 보관해요." />
    <Link className="button button--primary" to={'/auth/login?returnTo=' + encodeURIComponent(returnTo)}>로그인하고 시작하기</Link><Link className="button button--secondary" to="/">검색으로 돌아가기</Link>
    <p className="field__help">갤러리·분실물 검색은 로그인 없이 이용해요.</p></div></main>
}

export function ValuablesList({ session, items }: ValuableProps) {
  const [params] = useSearchParams()
  if (!session || params.get('state') === 'expired') return <AuthGate />
  const shown = params.get('state') === 'empty' ? [] : items
  return <main id="main-content" className="content-workspace"><PageHeading title="소중한 것들" action={<Link className="button button--primary" to="/valuables/new"><Plus aria-hidden="true" />물건 추가</Link>} /><DemoNotice>임시 목록 · 계정 서버에 저장하지 않아요.</DemoNotice>
    {shown.length ? <div className="item-grid">{shown.map(item => <Link className="valuable-card" key={item.id} to={'/valuables/' + item.id}><div className="photo-card__image"><PhotoImage photo={item.photos[0]} /></div><div className="photo-card__caption"><h2>{item.name}</h2><p>{item.category} · 사진 {item.photos.length}장</p><span className="status-badge">{valuableStatusLabels[item.status]}</span></div></Link>)}</div>
      : <EmptyState title="아직 등록한 물건이 없어요" description="오래 간직할 물건을 사진으로 남겨보세요."><Link className="button button--primary" to="/valuables/new">첫 물건 추가</Link></EmptyState>}
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
  const [agreed, setAgreed] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const photoButton = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  const readingRef = useRef(false)
  useEffect(() => () => { sequence.current++; readingRef.current = false }, [])
  async function addPhotos(files: FileList | null) {
    if (!files?.length) return
    const id = ++sequence.current; readingRef.current = true; setReading(true); setError('')
    const added: AppPhoto[] = []; const failures: string[] = []
    for (const file of Array.from(files)) {
      try { await assertImageReadable(file); added.push(photoFromFile(file, crypto.randomUUID())) } catch { failures.push(file.name) }
    }
    if (id !== sequence.current) return
    setPhotos(previous => [...previous, ...added]); readingRef.current = false; setReading(false)
    if (failures.length) setError('일부 사진을 읽지 못했어요. 다른 이미지로 다시 선택해 주세요.')
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (readingRef.current) return
    if (!name.trim()) { setError('물건 이름을 적어 주세요.'); nameInput.current?.focus(); return }
    if (!photos.length) { setError('사진을 한 장 이상 추가해 주세요.'); photoButton.current?.focus(); return }
    setError(''); setAgreed(false); setReviewOpen(true)
  }
  function saveDraft() {
    if (!agreed || readingRef.current) return
    const value: Valuable = { id: item?.id ?? crypto.randomUUID(), name: name.trim(), category, status, notes: notes.trim(), photos, updatedAt: Date.now() }
    onSave(value); setReviewOpen(false); navigate('/valuables/' + value.id)
  }
  return <main id="main-content" className="content-workspace"><PageHeading title={item ? '물건 수정' : '소중한 물건 남기기'} back={{ to: item ? '/valuables/' + item.id : '/valuables', label: item ? '수정 취소' : '목록으로' }} /><DemoNotice>임시 항목 · 새로고침하면 사라져요.</DemoNotice>
    <RegistrationState state={params.get('state') ?? ''} />
    <form className="form-layout" onSubmit={submit}><div><div className="section-heading"><h2>물건 사진 <span>{photos.length}장</span></h2><button ref={photoButton} type="button" className="button button--secondary" onClick={() => input.current?.click()} disabled={reading}><ImagePlus aria-hidden="true" />{reading ? '사진 확인 중' : '사진 추가'}</button></div>
      <input type="file" accept="image/*" multiple hidden tabIndex={-1} ref={input} aria-label="물건 원본 사진 선택" onChange={event => { void addPhotos(event.target.files); event.target.value = '' }} />
      {photos.length ? <div className="upload-list">{photos.map(photo => <div className="upload-list__item" key={photo.id}><PhotoImage photo={photo} /><span>{photo.name}</span><button type="button" className="icon-button" aria-label={photo.name + ' 빼기'} onClick={() => setPhotos(previous => previous.filter(value => value.id !== photo.id))}><X /></button></div>)}</div>
        : <div className="empty-state photo-empty"><p>물건 전체와 특징을 담아 주세요.</p></div>}
      <button type="button" className="text-button" onClick={() => { setPhotos(previous => [...previous, { ...samplePhotos[1], id: crypto.randomUUID() }]); setError('') }}>샘플 사진 사용</button>
    </div><div><div className="field"><label htmlFor="valuable-name">물건 이름</label><input ref={nameInput} id="valuable-name" value={name} maxLength={60} onChange={e => { setName(e.target.value); setError('') }} placeholder="예: 매일 쓰는 지갑" /></div>
      <div className="form-pair"><div className="field"><label htmlFor="valuable-category">분류</label><select id="valuable-category" value={category} onChange={e => setCategory(e.target.value)}>{['지갑', '가방', '열쇠', '전자기기', '기타'].map(value => <option key={value}>{value}</option>)}</select></div><div className="field"><label htmlFor="valuable-status">물건 상태</label><select id="valuable-status" value={status} onChange={e => setStatus(e.target.value as ValuableStatus)}>{(Object.keys(valuableStatusLabels) as ValuableStatus[]).map(value => <option value={value} key={value}>{valuableStatusLabels[value]}</option>)}</select></div></div>
      <div className="field"><label htmlFor="valuable-notes">기억할 특징 <span>선택</span></label><textarea id="valuable-notes" value={notes} maxLength={600} rows={3} onChange={e => setNotes(e.target.value)} placeholder="색상, 흠집, 각인처럼 구별되는 특징" /></div>
      <p className="storage-note">정식 등록 시 사진 원본 전체와 사진별 검색정보를 계정에 저장해요.</p>
      <details className="storage-note"><summary>저장 범위 자세히</summary><p>사진별 검색용 임베딩을 원본과 함께 계정 서버에 저장해요. 갤러리 전체는 자동 등록하지 않아요.</p><p>현재 체험에서는 서버 저장 없이 브라우저 메모리에만 임시 보관해요. 목록·상세에서 확인하고 삭제할 수 있어요.</p></details>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="button-row"><Link className="button button--secondary" to={item ? '/valuables/' + item.id : '/valuables'}>취소</Link><button className="button button--primary" type="submit" disabled={reading}>{item ? '변경 내용 확인' : '등록 내용 확인'}</button></div>
    </div></form>
    <Modal open={reviewOpen} title={item ? '변경 내용 확인' : '등록 내용 확인'} focusKey="review-valuable" onClose={() => setReviewOpen(false)} footer={<div className="button-row"><button type="button" className="button button--secondary" onClick={() => setReviewOpen(false)}>취소</button><button type="button" className="button button--primary" disabled={!agreed} onClick={saveDraft}>{item ? '변경 적용' : '임시로 추가'}</button></div>}>
      <dl className="detail-facts"><div><dt>물건</dt><dd>{name.trim()}</dd></div><div><dt>사진</dt><dd>원본 {photos.length}장</dd></div><div><dt>분류·상태</dt><dd>{category} · {valuableStatusLabels[status]}</dd></div></dl>
      <p className="storage-note">체험용 임시 항목이에요. 계정 서버에 저장하지 않아요.</p><label className="checkbox-row"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />저장 범위를 확인했어요</label>
    </Modal>
  </main>
}

export function ValuableDetail({ session, items, onDelete, onTransfer }: ValuableProps) {
  const { id } = useParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [photoIndex, setPhotoIndex] = useState(0)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [error, setError] = useState('')
  if (!session) return <AuthGate returnTo={pathname} />
  const item = items.find(value => value.id === id)
  if (!item || params.get('state') === 'missing') return <main id="main-content" className="content-workspace"><PageHeading title="소중한 것들" /><EmptyState title="임시 항목을 찾을 수 없어요"><Link to="/valuables" className="button button--primary">목록으로</Link></EmptyState></main>
  const selected = item.photos[Math.min(photoIndex, item.photos.length - 1)]
  return <main id="main-content" className="content-workspace"><PageHeading title={item.name} back={{ to: '/valuables', label: '목록으로' }} action={<Link to={'/valuables/' + item.id + '/edit'} className="button button--secondary">수정</Link>} /><DemoNotice>임시 항목 · 서버에 저장되지 않았어요.</DemoNotice>
    <div className="detail-layout"><div><div className="detail-photo"><button className="photo-open" onClick={() => setViewerOpen(true)} aria-label={selected.name + ' 크게 보기'}><PhotoImage photo={selected} /><span>크게 보기</span></button></div>{item.photos.length > 1 && <div className="photo-thumbnails">{item.photos.map((photo, index) => <button className="photo-thumbnail" key={photo.id} aria-label={'사진 ' + (index + 1) + ' 보기'} aria-pressed={photoIndex === index} onClick={() => setPhotoIndex(index)}><PhotoImage photo={photo} /></button>)}</div>}</div>
      <div><span className="status-badge">{valuableStatusLabels[item.status]}</span><dl className="detail-facts"><div><dt>분류</dt><dd>{item.category}</dd></div><div><dt>사진</dt><dd>{item.photos.length}장</dd></div>{item.notes && <div><dt>특징</dt><dd className="preserve-whitespace">{item.notes}</dd></div>}</dl>
        <div className="detail-actions"><button className="button button--primary" onClick={() => setTransferOpen(true)}>이 사진으로 분실물 찾기</button><button className="button button--secondary" onClick={() => { setError(''); setDeleteOpen(true) }}><Trash2 aria-hidden="true" />임시 항목 삭제</button></div></div></div>
    <TransferDialog photo={selected} open={transferOpen} onClose={() => setTransferOpen(false)} onTransfer={onTransfer} />
    <PhotoViewer photo={selected} open={viewerOpen} onClose={() => setViewerOpen(false)} />
    <Modal open={deleteOpen} title="임시 항목을 삭제할까요?" focusKey="delete-valuable" onClose={() => setDeleteOpen(false)}><p>이 항목의 사진과 입력 정보를 지워요. 기기 원본은 그대로예요.</p>{error && <p role="alert" className="form-error">{error}</p>}<div className="button-row"><button className="button button--secondary" onClick={() => setDeleteOpen(false)}>취소</button><button className="button button--primary" onClick={() => { if (params.get('state') === 'delete-error') { setError('삭제하지 못했어요. 다시 시도해 주세요.'); return } onDelete(item.id); setDeleteOpen(false); navigate('/valuables') }}>삭제</button></div></Modal>
  </main>
}

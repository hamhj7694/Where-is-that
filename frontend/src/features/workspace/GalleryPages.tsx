import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight, FolderOpen, Plus } from 'lucide-react'
import { usePhotoPreview } from '../search/SearchComposer'
import GalleryAddDialog from '../search/GalleryAddDialog'
import type { GalleryImportHandler } from '../search/useGalleryImport'
import type { GallerySource, SearchDraft } from '../search/model'
import { DemoNotice, EmptyState, PageHeading, PhotoImage, PhotoViewer, QuerySummary, RetryButton, SearchEditAction, TransferDialog } from './components'
import CropDialog from './CropDialog'
import FileLocationDetails from './FileLocationDetails'
import { localPhotoId, photoFromFile, type AppPhoto } from './data'

interface Props { gallery: GallerySource | null; draft: SearchDraft; onOpenGallery: () => void; onTransfer: (photos: readonly AppPhoto[]) => Promise<void>; onEdit?: () => void; fromHistory?: boolean }

interface GalleryResultsProps extends Props { onAddGallery: GalleryImportHandler }

function GalleryToolbarAdd({ onAdd }: { onAdd: GalleryImportHandler }) {
  const [open, setOpen] = useState(false)
  return <><button type="button" className="button button--secondary gallery-toolbar__add" aria-haspopup="dialog" onClick={() => setOpen(true)}><Plus aria-hidden="true" />이미지 추가</button>
    <GalleryAddDialog open={open} onClose={() => setOpen(false)} onAdd={onAdd} />
  </>
}

export function GalleryResults({ gallery, draft, onOpenGallery, onAddGallery, onEdit, fromHistory }: GalleryResultsProps) {
  const [params, setParams] = useSearchParams()
  const browse = params.get('view') === 'all' && !fromHistory
  const [sort, setSort] = useState('selected')
  const state = params.get('state') ?? 'success'
  const kind = params.get('kind') ?? 'all'
  const photos = useMemo(() => gallery ? gallery.files.map(file => photoFromFile(file, localPhotoId(file))) : [], [gallery])
  const filtered = photos.filter(photo => kind === 'all' || photo.kind === kind)
  const sorted = [...filtered].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ko') : sort === 'recent' ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : 0)
  const page = Math.min(Math.max(1, Math.ceil(sorted.length / 12)), Math.max(1, Math.floor(Number(params.get('page')) || 1)))
  function update(name: string, value: string) { const next = new URLSearchParams(params); next.set(name, value); if (name !== 'page') next.delete('page'); setParams(next) }
  const resetState = () => { const next = new URLSearchParams(params); next.delete('state'); setParams(next) }
  const problems: Record<string, [string, string]> = {
    permission: ['갤러리에 접근할 수 없어요', '다시 연결하거나 사진을 직접 선택해 주세요.'],
    unsupported: ['사진을 직접 선택해 주세요', '이 환경에서는 폴더 연결을 사용할 수 없어요.'],
    'missing-source': ['갤러리를 다시 연결해 주세요', '새로고침하면 연결한 사진 정보가 사라져요.'],
    'index-error': ['검색 준비를 완료하지 못했어요', '원본과 접근 권한을 확인해 주세요.'],
    error: ['사진을 불러오지 못했어요', '갤러리를 다시 연결해 주세요.'],
  }
  if (!gallery) return <main id="main-content" className="content-workspace"><PageHeading title="갤러리에서 사진 찾기" /><EmptyState title="갤러리를 연결해 주세요" description="내 사진이나 폴더를 연결하면 여기에서 확인할 수 있어요."><button className="button button--primary" onClick={onOpenGallery}>갤러리 연결</button></EmptyState></main>
  return <main id="main-content" className="content-workspace">
    <PageHeading title={browse ? '연결한 이미지' : '찾은 이미지'} back={browse ? { to: '/gallery', label: '갤러리 검색으로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} action={browse ? <button className="button button--secondary" onClick={onOpenGallery}><FolderOpen aria-hidden="true" />갤러리 관리</button> : undefined} />
    <DemoNotice>{browse ? (gallery.files.some(file => file.webkitRelativePath) ? '선택한 폴더와 하위 폴더의 이미지예요.' : '이 기기에서 연결한 이미지예요.') : '파일 미리보기 · AI 검색 미연결'}</DemoNotice>
    {!browse && <QuerySummary query={draft.query} photo={draft.photo} editTo="/gallery" onEdit={onEdit} />}
    {problems[state] ? <EmptyState title={problems[state][0]} description={problems[state][1]} error><button className="button button--primary" onClick={onOpenGallery}>갤러리 연결</button><RetryButton onClick={resetState} /></EmptyState>
      : state === 'loading' || state === 'indexing' ? <><p className="status-badge">검색 준비 상태 예시</p><div className="photo-grid" aria-busy="true" aria-label="사진 준비 중">{[0, 1, 2, 3].map(i => <div className="state-skeleton" key={i} />)}</div><RetryButton onClick={resetState} /></>
      : <>
        <div className="filter-bar gallery-toolbar">
          {browse && <GalleryToolbarAdd onAdd={onAddGallery} />}
          <label className="compact-field"><span className="visually-hidden">사진 정렬</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="selected">선택순</option><option value="name">파일명순</option><option value="recent">최근 수정순</option></select></label>
        </div>
        {state === 'empty' || sorted.length === 0 ? <EmptyState title="맞는 사진을 찾지 못했어요" description="검색어나 연결한 갤러리를 확인해 주세요."><SearchEditAction to="/gallery" onEdit={onEdit} primary /></EmptyState>
          : <><div className="section-heading"><h2>{browse ? '연결한 이미지' : '이미지'} <span>{sorted.length}장</span></h2></div>
            <div className="photo-grid">{sorted.slice((page - 1) * 12, page * 12).map(photo => <Link className="photo-card" key={photo.id} to={'/gallery/photo/' + photo.id + '?' + (params.get('record') ? 'record=' + encodeURIComponent(params.get('record')!) + '&' : '') + 'back=' + encodeURIComponent('/gallery/results?' + params.toString())}>
              <div className="photo-card__image"><PhotoImage photo={photo} /></div><div className="photo-card__caption"><strong>{photo.name}</strong><span>{photo.kind === 'screenshot' ? '스크린샷' : '사진'}{!photo.file && ' · 샘플'}</span></div></Link>)}</div>
            {sorted.length > 12 && <div className="pagination"><button className="button button--secondary" disabled={page <= 1} onClick={() => update('page', String(page - 1))}>이전</button><span>{page} / {Math.ceil(sorted.length / 12)}</span><button className="button button--secondary" disabled={page * 12 >= sorted.length} onClick={() => update('page', String(page + 1))}>다음</button></div>}
          </>}
      </>}
  </main>
}

export function GalleryPhoto({ gallery, onOpenGallery, onTransfer }: Props) {
  const { localId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [transferOpen, setTransferOpen] = useState(false)
  const [cropOpen, setCropOpen] = useState(false)
  const [cropPhoto, setCropPhoto] = useState<AppPhoto | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const actual = gallery?.files.map(file => photoFromFile(file, localPhotoId(file))) ?? []
  const photo = actual.find(item => item.id === localId)
  const url = usePhotoPreview(photo?.file ?? null)
  const source = url ?? photo?.sampleUrl
  const back = params.get('back')?.startsWith('/gallery/results') ? params.get('back')! : '/gallery/results'
  if (!photo || params.get('state') === 'missing') return <main id="main-content" className="content-workspace"><PageHeading title="이미지 보기" back={{ to: back, label: '돌아가기' }} /><EmptyState title="원본 이미지를 열 수 없어요" description="원본이 있는 갤러리를 다시 연결해 주세요." error><button className="button button--primary" onClick={onOpenGallery}>갤러리 다시 연결</button></EmptyState></main>
  return <main id="main-content" className="content-workspace"><PageHeading title={photo.name} back={{ to: back, label: '돌아가기' }} />
    {!photo.file && <DemoNotice>샘플 이미지 · 개인 갤러리 사진이 아니에요.</DemoNotice>}
    <div className="detail-layout"><div className="detail-photo"><button type="button" className="photo-open" onClick={() => setViewerOpen(true)} aria-label={photo.name + ' 크게 보기'}><PhotoImage photo={cropPhoto ?? photo} /><span>크게 보기</span></button></div><div>
      {cropPhoto && <p className="status-badge">선택 영역 사용 중</p>}
      <FileLocationDetails key={photo.id} photo={photo} copied={copied} onCopied={setCopied} beforeCopy={source && <a className="button button--secondary" href={source} target="_blank" rel="noreferrer">원본 열기<ArrowRight aria-hidden="true" /></a>}
        afterCopy={(photo.file || photo.sampleUrl) && <><button type="button" className="button button--secondary" onClick={() => setCropOpen(true)}>사진 일부 선택</button>{cropPhoto && <button type="button" className="button button--secondary" onClick={() => setCropPhoto(null)}>전체 사진으로</button>}<button className="button button--primary" onClick={() => setTransferOpen(true)}>{cropPhoto ? '선택 영역으로 분실물 찾기' : '이 사진으로 분실물 찾기'}</button></>} />
    </div></div>
    <TransferDialog photos={[cropPhoto ?? photo]} initialPhotoId={(cropPhoto ?? photo).id} open={transferOpen || location.pathname.endsWith('/transfer')} onClose={() => { setTransferOpen(false); if (location.pathname.endsWith('/transfer')) navigate('/gallery/photo/' + photo.id + location.search, { replace: true }) }} onTransfer={onTransfer} />
    <CropDialog photo={photo} open={cropOpen} onClose={() => setCropOpen(false)} onCrop={setCropPhoto} />
    <PhotoViewer photo={cropPhoto ?? photo} open={viewerOpen} onClose={() => setViewerOpen(false)} />
  </main>
}

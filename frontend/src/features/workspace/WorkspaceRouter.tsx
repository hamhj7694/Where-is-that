import { Link, Route, Routes, useLocation } from 'react-router-dom'
import type { GallerySource, SearchDraft } from '../search/model'
import type { GalleryImportHandler } from '../search/useGalleryImport'
import type { GalleryAssistantState } from '../search/gallery-search-model'
import { findSearchRecord, resolveGalleryAssistant, resolveLostAssistant, type SearchRecord } from '../search/history'
import HistoryPage from './HistoryPage'
import { GalleryPhoto, GalleryResults } from './GalleryPages'
import GallerySearchResults, { type GallerySearchActions } from './GallerySearchResults'
import { FoundDetail, LostResults } from './LostFoundPages'
import DirectSearchPage from './DirectSearchPage'
import type { LostSearchActions } from './LostSearchResults'
import { ValuableDetail, ValuableEditor, ValuablesList, type ValuableProps } from './ValuablesPages'
import { AccountPage, FindAccountPage, InfoPage, LoginPage, PreviewIndex, SettingsPage, SignupPage } from './AccountPages'
import KakaoCallbackPage from '../auth/KakaoCallbackPage'
import { EmptyState, PageHeading, RetryButton } from './components'

interface Props extends ValuableProps {
  gallery: GallerySource | null
  galleryReady: boolean
  historyReady: boolean
  authReady: boolean
  accountLoading: boolean
  accountLoadError: string
  onRetryAccountLoad: () => void
  drafts: { gallery: SearchDraft; lost: SearchDraft }
  records: SearchRecord[]
  autoRankRecordId: string | null
  galleryRankSeed: number
  onConsumeAiRankConsent: (recordId: string) => void
  onDeleteRecord: (id: string) => void
  onEditRecord: (record: SearchRecord) => void
  onAssistantChange: (id: string, patch: Partial<GalleryAssistantState>) => void
  onRefineRecord: (parent: SearchRecord, assistant: GalleryAssistantState) => void
  onCommitGallerySearch: (id: string | null, draft: SearchDraft) => void
  onCommitLostSearch: (id: string | null, draft: SearchDraft, autoRankConsent?: boolean) => void
  onOpenGallery: () => void
  onAddGallery: GalleryImportHandler
  onDisconnect: () => void
  onLogout: () => void
}

export default function WorkspaceRouter(props: Props) {
  const { pathname, search } = useLocation()
  const isValuables = pathname === '/valuables' || pathname.startsWith('/valuables/')
  if (isValuables || pathname === '/account') {
    const title = isValuables ? '소중한 물건 사진 보관함' : '내 계정'
    if (!props.authReady || props.accountLoading) {
      return <main id="main-content" className="content-workspace"><PageHeading title={title} /><p role="status">계정에 저장된 내용을 불러오고 있어요.</p></main>
    }
    if (props.session && props.accountLoadError) {
      return <main id="main-content" className="content-workspace"><PageHeading title={title} /><EmptyState error title="계정에 저장된 내용을 불러오지 못했어요" description={props.accountLoadError}><RetryButton onClick={props.onRetryAccountLoad} label="다시 불러오기" /></EmptyState></main>
    }
  }
  const recordId = new URLSearchParams(search).get('record')
  const mode = pathname.startsWith('/lost-found') ? 'lost' : 'gallery'
  const record = findSearchRecord(props.records, recordId, mode)
  const needsRecord = !!recordId && (pathname.startsWith('/gallery/') || pathname.startsWith('/lost-found/'))
  if (!props.historyReady && (pathname === '/history' || (needsRecord && !record))) {
    return <main id="main-content" className="content-workspace"><p role="status">검색 기록을 불러오고 있어요.</p></main>
  }
  if (needsRecord && !record) {
    if (props.session && props.accountLoadError) {
      return <main id="main-content" className="content-workspace"><PageHeading title="찾은 기록" /><EmptyState error title="계정 기록을 불러오지 못했어요"><RetryButton onClick={props.onRetryAccountLoad} label="다시 불러오기" /></EmptyState></main>
    }
    return <main id="main-content" className="content-workspace"><PageHeading title="기록을 다시 확인해 주세요" /><EmptyState title="이 검색 기록이 없어요" description="찾은 기록에서 저장된 검색을 열어 주세요."><Link to="/history" className="button button--primary">찾은 기록으로</Link></EmptyState></main>
  }
  if (!record && !props.galleryReady && pathname.startsWith('/gallery/')) {
    return <main id="main-content" className="content-workspace"><p role="status">연결한 갤러리를 불러오고 있어요.</p></main>
  }
  const onEdit = record ? () => props.onEditRecord(record) : undefined
  const gallery = { gallery: record ? record.gallery : props.gallery, draft: record?.draft ?? props.drafts.gallery, onOpenGallery: props.onOpenGallery, onTransfer: props.onTransfer, onEdit, fromHistory: !!record }
  const resolvedAssistant = record?.mode === 'gallery' ? resolveGalleryAssistant(props.records, record) : undefined
  const galleryActions: GallerySearchActions = {
    assistant: resolvedAssistant?.assistant,
    onAssistantChange: record?.mode === 'gallery' ? patch => props.onAssistantChange(record.id, patch) : undefined,
    onRefine: record?.mode === 'gallery' ? assistant => props.onRefineRecord(record, assistant) : undefined,
    onCommitSearch: draft => props.onCommitGallerySearch(record?.mode === 'gallery' ? record.id : null, draft),
    rankSeed: props.galleryRankSeed,
  }
  const browse = new URLSearchParams(search).get('view') === 'all' && !record
  const lost = { draft: record?.draft ?? props.drafts.lost, onEdit, fromHistory: !!record }
  const lostActions: LostSearchActions = {
    autoRankContext: !!record && props.autoRankRecordId === record.id,
    onConsumeAutoRankConsent: () => { if (record) props.onConsumeAiRankConsent(record.id) },
    assistant: record?.mode === 'lost' ? resolveLostAssistant(props.records, record).assistant : undefined,
    onAssistantChange: record?.mode === 'lost' ? patch => props.onAssistantChange(record.id, patch) : undefined,
    onRefine: record?.mode === 'lost' ? assistant => props.onRefineRecord(record, assistant) : undefined,
    onCommitSearch: (draft, autoRankConsent) => props.onCommitLostSearch(record?.mode === 'lost' ? record.id : null, draft, autoRankConsent),
  }
  return <Routes>
    <Route path="/direct-search" element={<DirectSearchPage />} />
    <Route path="/history" element={<HistoryPage records={props.records} onDeleteRecord={props.onDeleteRecord} session={props.session} onRetryAccountLoad={props.accountLoadError ? props.onRetryAccountLoad : undefined} />} />
    <Route path="/gallery/results" element={browse ? <GalleryResults {...gallery} onAddGallery={props.onAddGallery} /> : <GallerySearchResults key={record?.id ?? 'gallery-draft'} {...gallery} {...galleryActions} />} />
    <Route path="/gallery/results/combined" element={<GallerySearchResults key={record?.id ?? 'gallery-draft'} {...gallery} {...galleryActions} channel="combined" />} />
    <Route path="/gallery/results/image" element={<GallerySearchResults key={record?.id ?? 'gallery-draft'} {...gallery} {...galleryActions} channel="image" />} />
    <Route path="/gallery/results/context" element={<GallerySearchResults key={record?.id ?? 'gallery-draft'} {...gallery} {...galleryActions} channel="context" />} />
    <Route path="/gallery/photo/:localId" element={<GalleryPhoto key={pathname} {...gallery} />} />
    <Route path="/gallery/photo/:localId/transfer" element={<GalleryPhoto key={pathname} {...gallery} />} />
    <Route path="/lost-found/results" element={<LostResults key={record?.id ?? 'lost-draft'} {...lost} {...lostActions} />} />
    <Route path="/lost-found/results/combined" element={<LostResults key={record?.id ?? 'lost-draft'} {...lost} {...lostActions} channel="combined" />} />
    <Route path="/lost-found/results/image" element={<LostResults key={record?.id ?? 'lost-draft'} {...lost} {...lostActions} channel="image" />} />
    <Route path="/lost-found/results/context" element={<LostResults key={record?.id ?? 'lost-draft'} {...lost} {...lostActions} channel="context" />} />
    <Route path="/lost-found/item/:source/:id" element={<FoundDetail key={pathname} />} />
    <Route path="/valuables" element={<ValuablesList {...props} />} />
    <Route path="/valuables/new" element={<ValuableEditor {...props} />} />
    <Route path="/valuables/:id" element={<ValuableDetail key={pathname} {...props} />} />
    <Route path="/valuables/:id/edit" element={<ValuableEditor {...props} />} />
    <Route path="/auth/login" element={<LoginPage {...props} />} />
    <Route path="/auth/signup" element={<SignupPage />} />
    <Route path="/auth/find" element={<FindAccountPage mode={new URLSearchParams(search).get('mode') === 'password' ? 'password' : 'email'} />} />
    <Route path="/auth/kakao/callback" element={<KakaoCallbackPage />} />
    <Route path="/account" element={<AccountPage {...props} />} />
    <Route path="/settings" element={<SettingsPage {...props} />} />
    <Route path="/privacy" element={<InfoPage page="privacy" />} />
    <Route path="/about" element={<InfoPage page="about" />} />
    <Route path="/preview" element={<PreviewIndex />} />
    <Route path="*" element={<main id="main-content" className="content-workspace"><PageHeading title="페이지를 찾을 수 없어요" /><EmptyState title="검색에서 다시 시작해 주세요"><Link to="/" className="button button--primary">검색으로</Link></EmptyState></main>} />
  </Routes>
}

import { Link, Route, Routes, useLocation } from 'react-router-dom'
import type { GallerySource, SearchDraft } from '../search/model'
import type { GalleryImportHandler } from '../search/useGalleryImport'
import type { GalleryAssistantState } from '../search/gallery-search-model'
import { findSearchRecord, resolveGalleryAssistant, resolveLostAssistant, type SearchRecord } from '../search/history'
import HistoryPage from './HistoryPage'
import { GalleryPhoto, GalleryResults } from './GalleryPages'
import GallerySearchResults, { type GallerySearchActions } from './GallerySearchResults'
import { FoundDetail, LostResults } from './LostFoundPages'
import type { LostSearchActions } from './LostSearchResults'
import { ValuableDetail, ValuableEditor, ValuablesList, type ValuableProps } from './ValuablesPages'
import { AccountPage, InfoPage, LoginPage, PreviewIndex, SettingsPage } from './AccountPages'
import { EmptyState, PageHeading } from './components'

interface Props extends ValuableProps {
  gallery: GallerySource | null
  drafts: { gallery: SearchDraft; lost: SearchDraft }
  records: SearchRecord[]
  onDeleteRecord: (id: string) => void
  onEditRecord: (record: SearchRecord) => void
  onAssistantChange: (id: string, patch: Partial<GalleryAssistantState>) => void
  onRefineRecord: (parent: SearchRecord, assistant: GalleryAssistantState) => void
  onCommitGallerySearch: (id: string | null, draft: SearchDraft) => void
  onCommitLostSearch: (id: string | null, draft: SearchDraft) => void
  onOpenGallery: () => void
  onAddGallery: GalleryImportHandler
  onDisconnect: () => void
  onDemoLogin: () => void
  onLogout: () => void
}

export default function WorkspaceRouter(props: Props) {
  const { pathname, search } = useLocation()
  const recordId = new URLSearchParams(search).get('record')
  const mode = pathname.startsWith('/lost-found') ? 'lost' : 'gallery'
  const record = findSearchRecord(props.records, recordId, mode)
  if (recordId && !record && (pathname.startsWith('/gallery/') || pathname.startsWith('/lost-found/'))) {
    return <main id="main-content" className="content-workspace"><PageHeading title="기록을 다시 확인해 주세요" /><EmptyState title="이 검색 기록이 없어요" description="삭제되었거나 현재 탭에 남아 있지 않은 기록이에요."><Link to="/history" className="button button--primary">찾은 기록으로</Link></EmptyState></main>
  }
  const onEdit = record ? () => props.onEditRecord(record) : undefined
  const gallery = { gallery: record ? record.gallery : props.gallery, draft: record?.draft ?? props.drafts.gallery, onOpenGallery: props.onOpenGallery, onTransfer: props.onTransfer, onEdit, fromHistory: !!record }
  const resolvedAssistant = record?.mode === 'gallery' ? resolveGalleryAssistant(props.records, record) : undefined
  const galleryActions: GallerySearchActions = {
    assistant: resolvedAssistant?.assistant,
    onAssistantChange: record?.mode === 'gallery' ? patch => props.onAssistantChange(record.id, patch) : undefined,
    onRefine: record?.mode === 'gallery' ? assistant => props.onRefineRecord(record, assistant) : undefined,
    onCommitSearch: draft => props.onCommitGallerySearch(record?.mode === 'gallery' ? record.id : null, draft),
  }
  const browse = new URLSearchParams(search).get('view') === 'all' && !record
  const lost = { draft: record?.draft ?? props.drafts.lost, onEdit, fromHistory: !!record }
  const lostActions: LostSearchActions = {
    assistant: record?.mode === 'lost' ? resolveLostAssistant(props.records, record).assistant : undefined,
    onAssistantChange: record?.mode === 'lost' ? patch => props.onAssistantChange(record.id, patch) : undefined,
    onRefine: record?.mode === 'lost' ? assistant => props.onRefineRecord(record, assistant) : undefined,
    onCommitSearch: draft => props.onCommitLostSearch(record?.mode === 'lost' ? record.id : null, draft),
  }
  return <Routes>
    <Route path="/history" element={<HistoryPage records={props.records} onDeleteRecord={props.onDeleteRecord} />} />
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
    <Route path="/account" element={<AccountPage {...props} />} />
    <Route path="/settings" element={<SettingsPage {...props} />} />
    <Route path="/privacy" element={<InfoPage page="privacy" />} />
    <Route path="/about" element={<InfoPage page="about" />} />
    <Route path="/preview" element={<PreviewIndex />} />
    <Route path="*" element={<main id="main-content" className="content-workspace"><PageHeading title="페이지를 찾을 수 없어요" /><EmptyState title="검색에서 다시 시작해 주세요"><Link to="/" className="button button--primary">검색으로</Link></EmptyState></main>} />
  </Routes>
}

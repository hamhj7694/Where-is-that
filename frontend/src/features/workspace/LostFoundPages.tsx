import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { CandidateLocation } from '../search/catalog-model'
import { DemoNotice, EmptyState, LocationCard, NoPhoto, PageHeading } from './components'
import { safeReturn, sampleCandidates } from './data'
export { default as LostResults } from './LostSearchResults'
export function FoundDetail() {
  const { source, id } = useParams()
  const [params] = useSearchParams()
  const [imageError, setImageError] = useState(false)
  const item = source === 'demo' ? sampleCandidates.find(candidate => candidate.id === id) : undefined
  const back = safeReturn(params.get('back'), '/lost-found/results')
  if (!item || params.get('state') === 'removed') return <main id="main-content" className="content-workspace"><PageHeading title="후보 상세" back={{ to: back, label: '검색 결과로' }} /><EmptyState title="이 기록을 확인할 수 없어요" description="검색 결과에서 다른 후보를 확인해 주세요." error><Link to={back} className="button button--primary">검색 결과로</Link></EmptyState></main>
  const mapState = params.get('location')
  const validMapStates = ['verified', 'address_only', 'ambiguous', 'missing', 'provider_error']
  const customLocation: CandidateLocation = mapState && validMapStates.includes(mapState) ? { status: mapState as CandidateLocation['status'], address: ['verified', 'address_only', 'provider_error'].includes(mapState) ? '샘플 주소 · 실제 주소가 아니에요' : null, ...(mapState === 'verified' ? { latitude: 0, longitude: 0 } : {}) } : item.location
  const hasPhoto = !!item.image && item.photoStatus === 'verified_photo' && params.get('state') !== 'no-photo' && !imageError
  return <main id="main-content" className="content-workspace"><PageHeading title={item.title} back={{ to: back, label: '검색 결과로' }} /><DemoNotice>샘플 기록 · 물품·기관·날짜는 예시예요.</DemoNotice>
    <div className="detail-layout"><div className="detail-photo">{hasPhoto ? <img src={item.image!} alt={item.title + ' 샘플 사진'} onError={() => setImageError(true)} /> : <NoPhoto message={imageError ? '사진을 불러오지 못했어요' : undefined} />}</div>
      <div><span className="status-badge">유사 후보</span><dl className="detail-facts">{[['물품 분류', item.category], ['색상', item.color], ['습득일', item.foundAt], ['습득 장소', item.foundPlace]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="field__help">{item.description}</p><p className="storage-note">같은 물건인지는 아직 확인되지 않았어요.</p></div></div>
    <LocationCard item={item} location={customLocation} />
  </main>
}

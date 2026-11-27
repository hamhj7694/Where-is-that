import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { Candidate, CandidateLocation } from '../search/catalog-model'
import { fetchLostFoundDetail, formatDescription, formatFoundDateTime, toCandidate, type LostFoundSource } from '../search/lostfound-api'
import BookmarkButton from './BookmarkButton'
import { currentDetailPath } from './bookmarks'
import { DemoNotice, EmptyState, LocationCard, NoPhoto, PageHeading, RetryButton } from './components'
import KakaoMapPanel from './KakaoMapPanel'
import { OFFICIAL_SEARCH_URL, safeReturn, sampleCandidates } from './data'
import '../../styles/kakao-map.css'
export { default as LostResults } from './LostSearchResults'

export function FoundDetail() {
  const { source, id } = useParams()
  const [params] = useSearchParams()
  const [imageError, setImageError] = useState(false)
  const [detail, setDetail] = useState<Candidate | null>(null)
  const [loading, setLoading] = useState(source !== 'demo')
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const back = safeReturn(params.get('back'), '/lost-found/results')
  const isDemo = source === 'demo'

  // 실제 소스는 목록이 준 source/(atcId:fdSn)으로 상세 1건만 호출한다.
  useEffect(() => {
    if (isDemo || !source || !id) return
    const split = id.lastIndexOf(':')
    if (split < 0) { setError('상세 정보를 찾을 수 없어요.'); setLoading(false); return }
    const atcId = id.slice(0, split)
    const fdSn = id.slice(split + 1)
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchLostFoundDetail(source as LostFoundSource, atcId, fdSn)
      .then(payload => { if (!cancelled) { setDetail(toCandidate(payload, true)); setLoading(false) } })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error && cause.message ? cause.message : '상세 정보를 불러오지 못했어요.')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [isDemo, source, id, reloadToken])

  if (isDemo) {
    const item = sampleCandidates.find(candidate => candidate.id === id)
    if (!item || params.get('state') === 'removed') return <main id="main-content" className="content-workspace"><PageHeading title="후보 상세" back={{ to: back, label: '검색 결과로' }} /><EmptyState title="이 기록을 확인할 수 없어요" description="검색 결과에서 다른 후보를 확인해 주세요." error><Link to={back} className="button button--primary">검색 결과로</Link></EmptyState></main>
    const mapState = params.get('location')
    const validMapStates = ['verified', 'address_only', 'ambiguous', 'missing', 'provider_error']
    const customLocation: CandidateLocation = mapState && validMapStates.includes(mapState) ? { status: mapState as CandidateLocation['status'], address: ['verified', 'address_only', 'provider_error'].includes(mapState) ? '샘플 주소 · 실제 주소가 아니에요' : null, ...(mapState === 'verified' ? { latitude: 0, longitude: 0 } : {}) } : item.location
    const hasPhoto = !!item.image && item.photoStatus === 'verified_photo' && params.get('state') !== 'no-photo' && !imageError
    const bookmark = { id: 'lost:demo:' + item.id, kind: 'lost' as const, title: item.title, subtitle: item.category ? '샘플 분실물 · ' + item.category : '샘플 분실물', image: item.image ?? null, path: currentDetailPath() }
    return <main id="main-content" className="content-workspace"><PageHeading title={item.title} back={{ to: back, label: '검색 결과로' }} action={<BookmarkButton entry={bookmark} />} /><DemoNotice>샘플 기록 · 물품·기관·날짜는 예시예요.</DemoNotice>
      <div className="detail-layout"><div className="detail-photo">{hasPhoto ? <img src={item.image!} alt={item.title + ' 샘플 사진'} onError={() => setImageError(true)} /> : <NoPhoto message={imageError ? '사진을 불러오지 못했어요' : undefined} category={item.category} />}</div>
        <div><dl className="detail-facts">{[['물품 분류', item.category], ['색상', item.color], ['습득일', item.foundAt], ['습득 장소', item.foundPlace]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="field__help">{item.description}</p><p className="storage-note">이 물건이 본인의 물건이 맞는지는 보관기관에 직접 연락하거나 방문해서 확인해 주세요.</p></div></div>
      <LocationCard item={item} location={customLocation} />
    </main>
  }

  const heading = <PageHeading title="후보 상세" back={{ to: back, label: '검색 결과로' }} />
  if (loading) return <main id="main-content" className="content-workspace">{heading}<div className="gallery-result-grid" aria-busy="true" aria-label="상세 정보 로딩 상태"><div className="gallery-result-skeleton" /></div></main>
  if (error || !detail) return <main id="main-content" className="content-workspace">{heading}<EmptyState title={error ?? '상세 정보를 찾을 수 없어요'} description="검색 결과에서 다른 후보를 확인해 주세요." error><RetryButton onClick={() => setReloadToken(token => token + 1)} /></EmptyState><Link to={back} className="button button--secondary">검색 결과로</Link></main>

  const item = detail
  const hasPhoto = !!item.image && item.photoStatus === 'verified_photo' && !imageError
  const bookmark = { id: 'lost:' + source + ':' + id, kind: 'lost' as const, title: item.title, subtitle: item.atcId ? '습득물 · ' + item.atcId : '습득물', image: item.image ?? null, path: currentDetailPath() }
  return <main id="main-content" className="content-workspace"><PageHeading title={item.title} back={{ to: back, label: '검색 결과로' }} action={<BookmarkButton entry={bookmark} />} />
    <div className="detail-layout"><div className="detail-photo">{hasPhoto ? <img src={item.image!} alt={item.title + ' 사진'} onError={() => setImageError(true)} /> : <NoPhoto message={imageError ? '사진을 불러오지 못했어요' : undefined} category={item.category} />}</div>
      <div><dl className="detail-facts">{[['물품 분류', item.category], ['색상', item.color], ['습득일시', formatFoundDateTime(item.foundAt, item.foundTime)], ['습득 장소', item.foundPlace], ['보관상태', item.custodyStatus], ['관리번호', item.atcId], ['연락처', item.tel]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="field__help detail-description">{formatDescription(item.description)}</p><p className="storage-note">이 물건이 본인의 물건이 맞는지는 보관기관에 직접 연락하거나 방문해서 확인해 주세요.</p></div></div>
    <KakaoMapPanel item={item} />
    <div className="institution-note">
      <p>실제 보관 여부는 연락처로 문의 부탁드립니다.</p>
      <div className="institution-note__links">
        {item.mapUrl && <a href={item.mapUrl} target="_blank" rel="noreferrer">카카오맵에서 보기</a>}
        <a href={item.officialUrl ?? OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">{item.officialUrl ? '공식 정보 확인' : '공식 검색 안내'}</a>
      </div>
    </div>
  </main>
}

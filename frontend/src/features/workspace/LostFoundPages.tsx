import { useState, type FormEvent } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight, SlidersHorizontal, X } from 'lucide-react'
import Modal from '../../components/Modal'
import { getReferencePhotos, type SearchDraft } from '../search/model'
import { selectSummary, type Candidate, type CandidateLocation, type ResultChannel } from '../search/catalog-model'
import { DemoNotice, EmptyState, FoundCard, LocationCard, NoPhoto, PageHeading, QuerySummary, RetryButton, SearchEditAction } from './components'
import { OFFICIAL_SEARCH_URL, safeReturn, sampleCandidates } from './data'

const channelNames = { image: '사진 특징', context: '설명·조건' }
const filterNames = { category: '물품 분류', color: '색상', region: '습득지역', from: '시작일', to: '종료일' }
type FilterName = keyof typeof filterNames

function ResultFilters() {
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<FilterName, string>>({ category: '', color: '', region: '', from: '', to: '' })
  const active = (Object.keys(filterNames) as FilterName[]).filter(key => params.get(key))
  const [error, setError] = useState('')
  function show() { setValues(Object.fromEntries(Object.keys(filterNames).map(key => [key, params.get(key) || ''])) as Record<FilterName, string>); setError(''); setOpen(true) }
  function remove(key: string) { const next = new URLSearchParams(params); next.delete(key); next.delete('page'); setParams(next) }
  function apply(event: FormEvent) {
    event.preventDefault()
    if (values.from && values.to && values.from > values.to) { setError('종료일을 시작일 이후로 선택해 주세요.'); return }
    const next = new URLSearchParams(params)
    for (const key of Object.keys(filterNames) as FilterName[]) { if (values[key]) next.set(key, values[key]); else next.delete(key) }
    next.delete('page'); setParams(next); setOpen(false)
  }
  return <><div className="filter-bar"><button type="button" className="filter-chip" onClick={show}><SlidersHorizontal aria-hidden="true" />검색 조건{active.length > 0 && <span>{active.length}</span>}</button>
    {active.map(key => <button className="filter-chip" key={key} onClick={() => remove(key)} aria-label={filterNames[key] + ' ' + params.get(key) + ' 해제'}>{params.get(key)}<X aria-hidden="true" /></button>)}</div>
    <Modal open={open} title="검색 조건" focusKey="filters" onClose={() => setOpen(false)}><form onSubmit={apply}>
      <div className="field"><label htmlFor="filter-category">물품 분류</label><select id="filter-category" value={values.category} onChange={e => setValues({ ...values, category: e.target.value })}><option value="">전체 분류</option>{['지갑', '가방', '열쇠'].map(value => <option key={value}>{value}</option>)}</select></div>
      <div className="field"><label htmlFor="filter-color">색상</label><select id="filter-color" value={values.color} onChange={e => setValues({ ...values, color: e.target.value })}><option value="">모든 색상</option>{['검정', '남색', '노랑', '은색'].map(value => <option key={value}>{value}</option>)}</select></div>
      <div className="field"><label htmlFor="filter-region">습득지역</label><select id="filter-region" value={values.region} onChange={e => setValues({ ...values, region: e.target.value })}><option value="">전체 지역</option><option>서울</option><option>경기</option></select></div>
      <div className="form-pair">{(['from', 'to'] as const).map(key => <div className="field" key={key}><label htmlFor={'filter-' + key}>{filterNames[key]}</label><input id={'filter-' + key} type="date" value={values[key]} onChange={e => setValues({ ...values, [key]: e.target.value })} /></div>)}</div>
      {error && <p role="alert" className="form-error">{error}</p>}<p className="field__help">샘플 기록에 적용돼요.</p><div className="button-row"><button type="button" className="button button--secondary" onClick={() => { setValues({ category: '', color: '', region: '', from: '', to: '' }); setError('') }}>초기화</button><button type="submit" className="button button--primary">조건 적용</button></div>
    </form></Modal></>
}

function filterRecords(items: Candidate[], params: URLSearchParams) {
  return items.filter(item => (!params.get('category') || item.category === params.get('category'))
    && (!params.get('color') || item.color === params.get('color'))
    && (!params.get('region') || item.foundPlace?.startsWith(params.get('region')!))
    && (!params.get('from') || !!item.foundAt && item.foundAt >= params.get('from')!)
    && (!params.get('to') || !!item.foundAt && item.foundAt <= params.get('to')!))
}

function channelState(state: string, channel: ResultChannel): 'success' | 'empty' | 'error' | 'loading' | 'confirmation' {
  if (state === 'loading' || state === channel + '-loading') return 'loading'
  if (state === 'empty' || state === channel + '-empty') return 'empty'
  if (['error', 'timeout'].includes(state) || state === channel + '-error' || state === 'partial-' + channel || state === 'model-error' && channel === 'image') return 'error'
  if (['interpretation-error', 'needs-confirmation', 'consent-required'].includes(state)) return 'confirmation'
  return 'success'
}

export function LostResults({ draft, channel, onEdit, fromHistory }: { draft: SearchDraft; channel?: ResultChannel; onEdit?: () => void; fromHistory?: boolean }) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const state = params.get('state') ?? 'success'
  const imageSource = filterRecords(sampleCandidates.filter(item => item.photoStatus === 'verified_photo'), params)
  const contextSource = filterRecords([...sampleCandidates.slice(4), ...sampleCandidates.slice(0, 4)], params)
  const statusFor = (which: ResultChannel): ReturnType<typeof channelState> => {
    const override = params.get(which + 'State')
    return override && ['success', 'empty', 'error', 'loading', 'confirmation'].includes(override) ? override as ReturnType<typeof channelState> : channelState(state, which)
  }
  const summary = selectSummary(statusFor('image') === 'success' ? imageSource : [], contextSource)
  const source = channel === 'image' ? imageSource : contextSource
  const perPage = channel === 'image' ? 10 : 6
  const totalPages = Math.max(1, Math.ceil(source.length / perPage))
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(params.get('page')) || 1)))
  const suffix = params.toString() ? '?' + params.toString() : ''
  const moreParams = new URLSearchParams(params); moreParams.delete('page')
  function retry(which: ResultChannel) { const next = new URLSearchParams(params); next.set(which + 'State', 'success'); setParams(next) }
  function renderSection(which: ResultChannel, items: Candidate[], full: boolean) {
    const status = statusFor(which)
    const records = full ? items.slice((page - 1) * perPage, page * perPage) : items
    const title = channelNames[which] + '이 비슷한 후보'
    return <section className="results-section" aria-label={title} key={which}><div className="section-heading"><h2>{title}{status === 'success' && <span>{items.length}건</span>}</h2>{!full && status === 'success' && items.length > 0 && <Link className="result-more" aria-label={channelNames[which] + ' 후보 전체 보기'} to={'/lost-found/results/' + which + (moreParams.size ? '?' + moreParams.toString() : '')}>전체 보기<ArrowRight aria-hidden="true" /></Link>}</div>
      {status === 'loading' ? <><p className="field__help">로딩 상태 샘플</p><div className={which === 'image' ? 'found-grid' : 'context-list'} aria-busy="true" aria-label={channelNames[which] + '으로 찾는 중'}>{[0, 1, 2].map(i => <div key={i} className="state-skeleton" />)}</div><RetryButton onClick={() => retry(which)} /></>
        : status === 'error' ? <EmptyState title={channelNames[which] + ' 검색을 완료하지 못했어요'} description="잠시 후 다시 시도해 주세요." error><RetryButton onClick={() => retry(which)} /></EmptyState>
          : status === 'confirmation' ? <EmptyState title={state === 'consent-required' ? '사진 이용 안내를 확인해 주세요' : '사진의 특징을 확인해 주세요'} description={state === 'interpretation-error' ? '사진에서 검색 특징을 읽지 못한 상태 예시예요.' : '확인 필요 상태의 화면 예시예요.'}><SearchEditAction to="/lost-found" onEdit={onEdit} primary>입력 확인</SearchEditAction><RetryButton onClick={() => retry(which)} /></EmptyState>
            : status === 'empty' || items.length === 0 ? <EmptyState title={channelNames[which] + '에 맞는 후보가 없어요'} description="공개되지 않은 기록이 있을 수 있어요."><SearchEditAction to="/lost-found" onEdit={onEdit} /><a className="button button--secondary" href={OFFICIAL_SEARCH_URL} target="_blank" rel="noreferrer">공식 검색 안내</a></EmptyState>
              : <div className={which === 'image' ? 'found-grid' : 'context-list'}>{records.map(item => <FoundCard key={item.id} item={item} context={which === 'context'} to={'/lost-found/item/demo/' + item.id + '?back=' + encodeURIComponent(location.pathname + suffix)} />)}</div>}
    </section>
  }
  return <main id="main-content" className="content-workspace"><PageHeading title={channel ? channelNames[channel] + ' 후보' : '비슷한 물건 후보'} back={channel ? { to: '/lost-found/results' + (moreParams.size ? '?' + moreParams.toString() : ''), label: '결과 요약으로' } : fromHistory ? { to: '/history', label: '찾은 기록으로' } : undefined} />
    <DemoNotice>{state === 'success' ? '샘플 후보 · 실제 검색 결과가 아니에요.' : '상태 샘플 · 실제 처리 상태가 아니에요.'}</DemoNotice>
    <QuerySummary query={draft.query} photo={draft.photo} photos={getReferencePhotos(draft)} editTo="/lost-found" onEdit={onEdit} /><ResultFilters />
    {state === 'stale' && <p className="inline-error">공식 기록이 변경된 상태 예시예요.</p>}
    {channel ? renderSection(channel, source, true) : <>{renderSection('image', summary.image, false)}{renderSection('context', summary.context, false)}</>}
    {channel && statusFor(channel) === 'success' && source.length > perPage && <div className="pagination"><button className="button button--secondary" disabled={page <= 1} onClick={() => { const next = new URLSearchParams(params); next.set('page', String(page - 1)); setParams(next) }}>이전</button><span>{page} / {totalPages}</span><button className="button button--secondary" disabled={page >= totalPages} onClick={() => { const next = new URLSearchParams(params); next.set('page', String(page + 1)); setParams(next) }}>다음</button></div>}
    <p className="field__help result-disclaimer">같은 물건인지는 보관기관에 확인해 주세요. AI가 잘못 찾거나 놓칠 수 있어요.</p>
  </main>
}

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

import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Clock, Crosshair, MapPin, Phone } from 'lucide-react'
import type { Candidate } from '../search/catalog-model'
import { fetchMapConfig, fetchRoute, geocodeOrigin, type RouteResult } from '../search/lostfound-api'
import { formatRouteDistance, formatRouteDuration } from '../search/route-format'

interface KakaoLatLng { getLat: () => number; getLng: () => number }
interface KakaoMapInstance { destroy?: () => void; relayout?: () => void }
interface KakaoOverlay { setMap: (map: KakaoMapInstance | null) => void }
interface KakaoMapsStatic {
  load: (callback: () => void) => void
  LatLng: new (lat: number, lng: number) => KakaoLatLng
  Map: new (container: HTMLElement, options: { center: KakaoLatLng; level?: number }) => KakaoMapInstance
  Marker: new (options: { map: KakaoMapInstance; position: KakaoLatLng; title?: string }) => KakaoOverlay
  Polyline: new (options: { map: KakaoMapInstance; path: KakaoLatLng[]; strokeWeight?: number; strokeColor?: string; strokeOpacity?: number }) => KakaoOverlay
}

interface Origin {
  lat: number
  lng: number
  label: string
}

declare global {
  interface Window { kakao?: { maps: KakaoMapsStatic } }
}

let sdkPromise: Promise<void> | null = null

function loadKakaoMaps(key: string): Promise<void> {
  const maps = window.kakao?.maps
  // SDK 스크립트만 남아 있고 load()가 안 끝난 상태에서는 LatLng이 아직 없다.
  if (maps?.LatLng) return Promise.resolve()
  if (maps) return new Promise<void>(resolve => { maps.load(() => resolve()) })
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`
      // 127.0.0.1:5173은 도메인 등록이 없어 Referer 검사에서 막힌다.
      // 공개 JS 키 요청이므로 Referer를 보내지 않으면 정상 로드된다.
      script.referrerPolicy = 'no-referrer'
      script.async = true
      script.onload = () => {
        if (window.kakao?.maps) window.kakao.maps.load(resolve)
        else { sdkPromise = null; reject(new Error('지도 SDK를 불러오지 못했어요.')) }
      }
      script.onerror = () => { sdkPromise = null; reject(new Error('지도 SDK를 불러오지 못했어요.')) }
      document.head.appendChild(script)
    })
  }
  return sdkPromise
}

export default function KakaoMapPanel({ item }: { item: Candidate }) {
  const destination = item.location.latitude != null && item.location.longitude != null
    ? { lat: item.location.latitude, lng: item.location.longitude }
    : null
  const destinationName = item.place?.name || item.custodyName || item.title
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<KakaoMapInstance | null>(null)
  const [sdkReady, setSdkReady] = useState(false)
  const [sdkError, setSdkError] = useState('')
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [originInput, setOriginInput] = useState('')
  const [originBusy, setOriginBusy] = useState(false)
  const [originError, setOriginError] = useState('')
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [routeError, setRouteError] = useState('')
  const [locating, setLocating] = useState(false)
  const [gpsError, setGpsError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchMapConfig()
      .then(config => {
        if (!config.available || !config.javascriptKey) throw new Error('지도 설정이 없어요.')
        return loadKakaoMaps(config.javascriptKey)
      })
      .then(() => { if (!cancelled) setSdkReady(true) })
      .catch(() => { if (!cancelled) setSdkError('지도를 불러오지 못했어요. 아래 링크에서 위치를 확인해 주세요.') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const maps = window.kakao?.maps
    const container = containerRef.current
    if (!sdkReady || !maps?.LatLng || !container || !destination) return
    while (container.firstChild) container.removeChild(container.firstChild)
    const center = new maps.LatLng(destination.lat, destination.lng)
    const map = new maps.Map(container, { center, level: 3 })
    const marker = new maps.Marker({ map, position: center, title: destinationName })
    mapRef.current = map
    // 정보 패널 높이에 맞춰 지도 컨테이너가 늘어난 뒤 내부 캔버스를 다시 계산한다.
    const relayout = () => map.relayout?.()
    const timer = window.setTimeout(relayout, 0)
    window.addEventListener('resize', relayout)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', relayout)
      marker.setMap(null)
      map.destroy?.()
      mapRef.current = null
      while (container.firstChild) container.removeChild(container.firstChild)
    }
  }, [sdkReady, destination?.lat, destination?.lng, destinationName])

  // 거리·시간은 지도 SDK와 무관하게 서버 REST 키로 계산한다(SDK 실패 시에도 표시).
  useEffect(() => {
    if (!origin || !destination) { setRoute(null); return }
    let cancelled = false
    setRoute(null)
    setRouteError('')
    fetchRoute(origin.lat, origin.lng, destination.lat, destination.lng, destinationName, origin.label)
      .then(result => { if (!cancelled) setRoute(result) })
      .catch(() => { if (!cancelled) setRouteError('길안내 정보를 불러오지 못했어요.') })
    return () => { cancelled = true }
  }, [origin?.lat, origin?.lng, origin?.label, destination?.lat, destination?.lng, destinationName])

  useEffect(() => {
    const maps = window.kakao?.maps
    const map = mapRef.current
    if (!maps || !map || !origin || !route?.path.length) return
    const path = route.path.map(([lat, lng]) => new maps.LatLng(lat, lng))
    const line = new maps.Polyline({ map, path, strokeWeight: 4, strokeColor: '#2f6fed', strokeOpacity: 0.85 })
    const from = new maps.Marker({ map, position: new maps.LatLng(origin.lat, origin.lng), title: origin.label })
    return () => { line.setMap(null); from.setMap(null) }
  }, [route, sdkReady, origin?.lat, origin?.lng, origin?.label])

  async function applyOrigin() {
    const query = originInput.trim()
    if (!query || originBusy) return
    setOriginBusy(true)
    setOriginError('')
    try {
      const result = await geocodeOrigin(query)
      setOrigin({ lat: result.lat, lng: result.lng, label: result.name })
      setGpsError('')
    } catch (cause) {
      setOriginError(cause instanceof Error && cause.message ? cause.message : '출발지를 찾지 못했어요.')
    } finally {
      setOriginBusy(false)
    }
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) { setGpsError('이 브라우저는 위치 기능을 지원하지 않아요.'); return }
    setLocating(true)
    setGpsError('')
    setOriginError('')
    navigator.geolocation.getCurrentPosition(
      position => {
        const lat = position.coords.latitude
        const lng = position.coords.longitude
        setOrigin({ lat, lng, label: '현재 위치 (GPS)' })
        setOriginInput(`${lat.toFixed(6)}, ${lng.toFixed(6)}`)
        setLocating(false)
      },
      () => { setLocating(false); setGpsError('위치 권한을 허용해 주세요.') },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    )
  }

  const place = item.place
  const address = place?.roadAddress || place?.address || item.location.address || '주소 정보 없음'
  const phone = place?.phone || item.tel || ''
  const summary = route
    ? <><strong>{formatRouteDistance(route.distance)}</strong> · <strong>{formatRouteDuration(route.duration)}</strong> 예상</>
    : origin ? routeError || '거리와 예상 시간을 계산하고 있어요.'
      : '출발지를 입력하거나 현재 위치를 사용해 주세요.'
  const directions = route
    ? <a className="button button--primary" href={route.mapUrl} target="_blank" rel="noreferrer">카카오맵 길안내</a>
    : <button type="button" className="button button--primary" disabled>출발지 설정 후 길안내</button>

  return <section className="map-panel" aria-labelledby="map-panel-heading">
    <div className="section-heading"><h2 id="map-panel-heading">보관 장소 지도와 길안내</h2><MapPin aria-hidden="true" /></div>
    <div className="map-panel__grid">
      <div className="map-panel__map">
        <div className="map-panel__canvas" ref={containerRef} role="img" aria-label={`${destinationName} 위치 지도`} data-unavailable={sdkError || !destination ? 'true' : undefined} />
        {!destination && <p className="map-panel__overlay">확인된 좌표가 없어 지도를 표시하지 못했어요.</p>}
        {sdkError && <p className="map-panel__overlay">{sdkError}</p>}
        {sdkReady && destination && !sdkError && <p className="map-panel__caption">지도 위 검정 마커가 보관 장소입니다.</p>}
      </div>
      <div className="map-panel__info">
        <h3>{destinationName}</h3>
        <dl className="map-panel__facts">
          <div><dt><MapPin aria-hidden="true" /> 장소</dt><dd>{destinationName}</dd></div>
          <div><dt><MapPin aria-hidden="true" /> 주소</dt><dd>{address}</dd></div>
          <div><dt><Phone aria-hidden="true" /> 연락처</dt><dd>{phone ? <a href={`tel:${phone.replace(/[^0-9+]/g, '')}`}>{phone}</a> : '정보 없음'}</dd></div>
          <div><dt><Clock aria-hidden="true" /> 영업시간</dt><dd>{place?.openingHours || '카카오에서 제공하지 않아요'}</dd></div>
          {place?.category && <div><dt>분류</dt><dd>{place.category}</dd></div>}
        </dl>
        <div className="map-panel__route" aria-live="polite">
          <div className="map-panel__route-path">
            <span><small>출발</small><strong>{origin?.label ?? '출발지 미설정'}</strong></span>
            <ArrowRight aria-hidden="true" />
            <span><small>도착</small><strong>{destinationName}</strong></span>
          </div>
          <div className="map-panel__origin">
            <div className="map-panel__origin-head">
              <label htmlFor="origin-input">출발지 입력</label>
              <button type="button" className="map-panel__gps" onClick={useCurrentLocation} disabled={locating || !destination}>
                <Crosshair aria-hidden="true" /> {locating ? '위치 확인 중…' : '현재 위치 사용'}
              </button>
            </div>
            <div className="map-panel__origin-row">
              <input id="origin-input" value={originInput} onChange={event => setOriginInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyOrigin() }} placeholder="장소명·주소 또는 위도,경도" disabled={!destination} />
              <button type="button" className="button button--secondary" onClick={applyOrigin} disabled={!originInput.trim() || originBusy || !destination}>{originBusy ? '찾는 중…' : '출발지 설정'}</button>
            </div>
            {(originError || gpsError) && <p className="field__help" role="status">{originError || gpsError}</p>}
          </div>
          <p className="map-panel__route-summary">{summary}</p>
          <div className="button-row">
            {directions}
            {place?.placeUrl && <a className="button button--secondary" href={place.placeUrl} target="_blank" rel="noreferrer">장소 정보 보기</a>}
          </div>
        </div>
      </div>
    </div>
  </section>
}

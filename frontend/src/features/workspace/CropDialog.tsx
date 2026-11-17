import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import Modal from '../../components/Modal'
import { usePhotoPreview } from '../search/usePhotoPreview'
import { photoFromFile, type AppPhoto } from './data'
import { INITIAL_CROP, clampRect, moveRect, pointInImage, rectFromPoints, toPixelRect, type NormalizedPoint, type NormalizedRect } from './crop-model'

interface Props { photo: AppPhoto; open: boolean; onClose: () => void; onCrop: (photo: AppPhoto) => void; inline?: boolean; actionHost?: HTMLElement | null }
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Drag = { pointerId: number; kind: 'draw' | 'move' | Corner; start: NormalizedPoint; initial: NormalizedRect }
const corners: { corner: Corner; label: string }[] = [
  { corner: 'nw', label: '왼쪽 위 모서리' }, { corner: 'ne', label: '오른쪽 위 모서리' },
  { corner: 'sw', label: '왼쪽 아래 모서리' }, { corner: 'se', label: '오른쪽 아래 모서리' },
]

function sameOriginSample(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value, window.location.href)
    return url.origin === window.location.origin && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null
  } catch { return null }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('사진을 만들지 못했어요. 영역을 조정하고 다시 시도해 주세요.')), 'image/png')
  })
}

export default function CropDialog({ photo, open, onClose, onCrop, inline = false, actionHost }: Props) {
  const preview = usePhotoPreview(photo.file)
  const source = preview ?? (!photo.file ? sameOriginSample(photo.sampleUrl) : null)
  const [rect, setRect] = useState<NormalizedRect>({ ...INITIAL_CROP })
  const [loaded, setLoaded] = useState<{ source: string; width: number; height: number } | null>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const image = useRef<HTMLImageElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const operation = useRef(0)
  const active = useRef(open)
  const currentSource = useRef(source)
  const controlsId = useId()
  const guideId = useId()
  active.current = open
  currentSource.current = source
  const ready = !!source && loaded?.source === source && failedSource !== source

  useEffect(() => {
    operation.current++
    active.current = open
    drag.current = null
    setRect({ ...INITIAL_CROP })
    setError('')
    setBusy(false)
  }, [open, photo.id, source])

  useEffect(() => () => { active.current = false; operation.current++ }, [])
  useEffect(() => {
    if (inline && open) requestAnimationFrame(() => surface.current?.focus())
  }, [inline, open])

  function cancel() {
    operation.current++
    active.current = false
    drag.current = null
    setBusy(false)
    onClose()
  }

  function pointer(event: ReactPointerEvent): NormalizedPoint | null {
    const node = image.current
    if (!ready || !node) return null
    const bounds = node.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null
    return pointInImage({ x: event.clientX, y: event.clientY }, bounds)
  }

  function startDrag(event: ReactPointerEvent, kind: Drag['kind']) {
    if (busy || event.button !== 0 || !event.isPrimary || drag.current) return
    const start = pointer(event)
    if (!start) return
    event.preventDefault()
    event.stopPropagation()
    drag.current = { pointerId: event.pointerId, kind, start, initial: rect }
    surface.current?.setPointerCapture(event.pointerId)
    if (kind === 'draw') setRect(rectFromPoints(start, start))
  }

  function updateDrag(event: ReactPointerEvent) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId || busy) return
    const end = pointer(event)
    if (!end) return
    event.preventDefault()
    if (current.kind === 'move') {
      setRect(moveRect(current.initial, { x: end.x - current.start.x, y: end.y - current.start.y }))
    } else if (current.kind === 'draw') {
      setRect(rectFromPoints(current.start, end))
    } else {
      const origin = current.initial
      const anchor = {
        x: current.kind.endsWith('w') ? origin.x + origin.width : origin.x,
        y: current.kind.startsWith('n') ? origin.y + origin.height : origin.y,
      }
      const corner = {
        x: (current.kind.endsWith('w') ? origin.x : origin.x + origin.width) + end.x - current.start.x,
        y: (current.kind.startsWith('n') ? origin.y : origin.y + origin.height) + end.y - current.start.y,
      }
      setRect(rectFromPoints(anchor, corner))
    }
  }

  function endDrag(event: ReactPointerEvent) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (surface.current?.hasPointerCapture(event.pointerId)) surface.current.releasePointerCapture(event.pointerId)
  }

  async function confirm() {
    const original = image.current
    if (busy || !ready || !original || !source || !original.complete) return
    const token = ++operation.current
    const selectedSource = source
    setBusy(true)
    setError('')
    try {
      const pixels = toPixelRect(rect, original.naturalWidth, original.naturalHeight)
      const canvas = document.createElement('canvas')
      canvas.width = pixels.width
      canvas.height = pixels.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('이 브라우저에서 사진 영역을 준비하지 못했어요.')
      context.drawImage(original, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height)
      const blob = await canvasBlob(canvas)
      if (token !== operation.current || !active.current || selectedSource !== currentSource.current) return
      const name = photo.name.replace(/\.[^.]+$/, '') + '-영역.png'
      const file = new File([blob], name, { type: 'image/png', lastModified: Date.now() })
      const cropped = photoFromFile(file, `${photo.id}-crop-${crypto.randomUUID()}`)
      onCrop({ ...cropped, kind: photo.kind })
      onClose()
    } catch (reason) {
      if (token === operation.current && active.current) setError(reason instanceof Error ? reason.message : '사진을 만들지 못했어요. 다시 시도해 주세요.')
    } finally {
      if (token === operation.current && active.current) setBusy(false)
    }
  }

  const adjust = (key: keyof NormalizedRect, value: number) => setRect(current => clampRect({ ...current, [key]: value / 100 }))
  const unavailable = !photo.file && !source
  const failed = !!source && failedSource === source
  const actions = <div className="button-row crop-actions"><button type="button" className="button button--secondary" onClick={cancel}>{inline ? '영역 선택 취소' : '취소'}</button>
    <button type="button" className="button button--primary" disabled={!ready || busy} onClick={() => { void confirm() }}>{busy ? '영역 준비 중' : inline ? '선택 영역 적용' : '선택 영역 사용'}</button></div>
  const content = <>
    <p id={guideId} className="crop-help">{inline ? '사각형을 그려 선택하고, 모서리를 끌어 조정해 주세요.' : '물건이 보이도록 영역을 조정해 주세요. 원본은 바뀌지 않아요.'}</p>
    {(unavailable || failed) ? <p className="form-error" role="alert">영역을 선택할 사진을 열 수 없어요. 다른 사진을 선택해 주세요.</p>
      : !ready && <p className="crop-status" role="status">사진을 준비하고 있어요.</p>}
    {source && <div ref={surface} className="crop-surface" role="group" tabIndex={inline ? -1 : undefined} aria-label="사진에서 물건 영역 선택" aria-describedby={guideId}
      aria-busy={busy} onPointerDown={event => startDrag(event, 'draw')} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
      onLostPointerCapture={() => { drag.current = null }} style={{ position: 'relative', width: ready && loaded ? `min(100%, calc(48svh * ${loaded.width / loaded.height}))` : '100%', marginInline: 'auto', touchAction: 'none', userSelect: 'none' }}>
      <img key={source} ref={image} src={source} alt={photo.name} draggable={false}
        style={{ display: 'block', width: '100%', height: 'auto' }}
        onLoad={event => {
          const node = event.currentTarget
          if (node.naturalWidth > 0 && node.naturalHeight > 0) {
            setLoaded({ source, width: node.naturalWidth, height: node.naturalHeight })
            setFailedSource(null)
          } else setFailedSource(source)
        }} onError={() => setFailedSource(source)} />
      {ready && <div className="crop-selection" onPointerDown={event => startDrag(event, 'move')}
        style={{ position: 'absolute', left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
        {corners.map(({ corner, label }) => <button key={corner} type="button" className="crop-handle" data-corner={corner}
          aria-label={`${label} 조정. 아래 정밀 조정으로도 변경할 수 있어요.`} disabled={busy}
          onPointerDown={event => startDrag(event, corner)} onClick={event => {
            if (event.detail !== 0) return
            const details = document.getElementById(controlsId) as HTMLDetailsElement | null
            if (details) { details.open = true; details.querySelector<HTMLInputElement>('input')?.focus() }
          }} />)}
      </div>}
    </div>}
    <details id={controlsId} className="crop-controls"><summary>정밀 조정</summary><div className="crop-controls__grid">
      {([
        { key: 'x', label: '가로 위치', min: 0, max: (1 - rect.width) * 100 },
        { key: 'y', label: '세로 위치', min: 0, max: (1 - rect.height) * 100 },
        { key: 'width', label: '너비', min: 1, max: (1 - rect.x) * 100 },
        { key: 'height', label: '높이', min: 1, max: (1 - rect.y) * 100 },
      ] as const).map(({ key, label, min, max }) => <label key={key}><span>{label}</span><input type="range" min={min} max={max} step="0.1" value={rect[key] * 100}
        aria-valuetext={`${Math.round(rect[key] * 100)}퍼센트`} disabled={!ready || busy} onChange={event => adjust(key, Number(event.target.value))} /></label>)}
    </div></details>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="field__help crop-local-note">선택한 부분만 새 사진으로 만들어요. 서버로 보내지 않아요.</p>
  </>
  return inline ? <section className="inline-crop-editor" aria-label="참고 사진 영역 선택">{content}{actionHost ? createPortal(actions, actionHost) : <div className="inline-crop-editor__actions">{actions}</div>}</section>
    : <Modal open={open} title="물건 영역 선택" focusKey={photo.id} className="crop-dialog" onClose={cancel} footer={actions}>{content}</Modal>
}

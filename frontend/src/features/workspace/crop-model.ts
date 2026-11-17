export interface NormalizedPoint { x: number; y: number }
export interface NormalizedRect extends NormalizedPoint { width: number; height: number }
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface ImageBounds { left: number; top: number; width: number; height: number }

export const INITIAL_CROP: Readonly<NormalizedRect> = Object.freeze({ x: 0.15, y: 0.15, width: 0.7, height: 0.7 })

function finite(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback }
function unit(value: number): number { return Math.max(0, Math.min(1, finite(value, 0))) }

/** Keep a nonempty selection entirely within the image, never in screen pixels. */
export function clampRect(rect: NormalizedRect): NormalizedRect {
  const width = Math.max(0.01, Math.min(1, finite(rect.width, 0.01)))
  const height = Math.max(0.01, Math.min(1, finite(rect.height, 0.01)))
  return {
    x: Math.max(0, Math.min(1 - width, finite(rect.x, 0))),
    y: Math.max(0, Math.min(1 - height, finite(rect.y, 0))),
    width, height,
  }
}

export function pointInImage(client: NormalizedPoint, bounds: ImageBounds): NormalizedPoint {
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
    throw new RangeError('Image bounds must be positive and finite')
  }
  return { x: unit((client.x - bounds.left) / bounds.width), y: unit((client.y - bounds.top) / bounds.height) }
}

export function rectFromPoints(first: NormalizedPoint, second: NormalizedPoint): NormalizedRect {
  const a = { x: unit(first.x), y: unit(first.y) }
  const b = { x: unit(second.x), y: unit(second.y) }
  return clampRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
}

export function moveRect(rect: NormalizedRect, delta: NormalizedPoint): NormalizedRect {
  const current = clampRect(rect)
  return clampRect({ ...current, x: current.x + finite(delta.x, 0), y: current.y + finite(delta.y, 0) })
}

/** Use natural image dimensions, not CSS size or devicePixelRatio. */
export function toPixelRect(rect: NormalizedRect, naturalWidth: number, naturalHeight: number): PixelRect {
  if (!Number.isInteger(naturalWidth) || !Number.isInteger(naturalHeight) || naturalWidth < 1 || naturalHeight < 1) {
    throw new RangeError('Natural image dimensions must be positive integers')
  }
  const selected = clampRect(rect)
  const x = Math.min(naturalWidth - 1, Math.floor(selected.x * naturalWidth))
  const y = Math.min(naturalHeight - 1, Math.floor(selected.y * naturalHeight))
  const right = Math.min(naturalWidth, Math.ceil((selected.x + selected.width) * naturalWidth))
  const bottom = Math.min(naturalHeight, Math.ceil((selected.y + selected.height) * naturalHeight))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

import { describe, expect, it } from 'vitest'
import { localPhotoId, safeReturn } from './data'

describe('local photo identity across reconnection', () => {
  it('keeps the same File identity while the source is alive', () => {
    const file = new File(['a'], 'photo.jpg', { type: 'image/jpeg' })
    expect(localPhotoId(file)).toBe(localPhotoId(file))
  })
  it('does not let an old URL refer to another File with the same filename', () => {
    const first = new File(['a'], 'photo.jpg', { type: 'image/jpeg', lastModified: 1 })
    const replacement = new File(['b'], 'photo.jpg', { type: 'image/jpeg', lastModified: 1 })
    expect(localPhotoId(first)).not.toBe(localPhotoId(replacement))
  })
})

describe('login return destination', () => {
  it.each(['https://example.com', '//example.com', '/valuables-redirect', 'javascript:alert(1)'])('rejects unsafe or unsupported return %s', value => {
    expect(safeReturn(value, '/valuables')).toBe('/valuables')
  })
  it('keeps the intended internal editor and query', () => {
    expect(safeReturn('/valuables/new?state=vector-error', '/valuables')).toBe('/valuables/new?state=vector-error')
    expect(safeReturn('/account', '/valuables')).toBe('/account')
  })
})

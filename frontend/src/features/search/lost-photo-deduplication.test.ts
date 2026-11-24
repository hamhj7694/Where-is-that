import { afterEach, expect, it, vi } from 'vitest'
import { checkLostPhotos, uniqueLostPhotos } from './lost-photo-deduplication'

const base = 'https://minwon24.police.go.kr/images/'
const imageOf = (item: { image: string | null }) => item.image

afterEach(() => vi.unstubAllGlobals())

it('keeps the highest-ranked record when different photo URLs have identical content', async () => {
  const original = base + 'portal-wallet.jpg'
  const duplicate = base + 'police-wallet.jpg'
  const different = base + 'different-wallet.jpg'
  const rows = [
    { id: 'rank-one', name: '지갑', image: original },
    { id: 'same-photo', name: '다른 제목', image: duplicate },
    { id: 'same-name', name: '지갑', image: different },
  ]
  const same = 'pixels:' + '1'.repeat(64)
  const request = vi.fn(async () => Response.json({
    fingerprints: { [original]: same, [duplicate]: same, [different]: 'pixels:' + '2'.repeat(64) },
  }))
  vi.stubGlobal('fetch', request)

  const checked = await checkLostPhotos(rows.map(imageOf))
  expect(uniqueLostPhotos(rows, imageOf, checked).map(item => item.id)).toEqual(['rank-one', 'same-name'])
  await checkLostPhotos(rows.map(imageOf))
  expect(request).toHaveBeenCalledTimes(1)
})

it('preserves records with no photo or a failed image check and groups normalized photo URLs', async () => {
  const rows = [
    { id: 'first', image: base + 'known.jpg' },
    { id: 'alias', image: base + 'known.jpg?utm_source=portal' },
    { id: 'unavailable', image: base + 'unavailable.jpg' },
    { id: 'without-photo-a', image: null },
    { id: 'without-photo-b', image: base + 'no_img.png' },
  ]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  const checked = await checkLostPhotos(rows.map(imageOf))
  expect(uniqueLostPhotos(rows, imageOf, checked).map(item => item.id))
    .toEqual(['first', 'unavailable', 'without-photo-a', 'without-photo-b'])
})

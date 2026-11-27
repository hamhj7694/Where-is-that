import { afterEach, expect, it, vi } from 'vitest'
import { rankConnectedGallery } from './gallery-local-rank'
import { GALLERY_CHANNELS, sortGalleryByRank } from './gallery-search-model'

afterEach(() => vi.unstubAllGlobals())

it('ranks a candidate beyond the first batch and skips an unreadable image', async () => {
  const files = Array.from({ length: 19 }, (_, index) => ({
    id: 'img-' + index,
    file: new File(['image'], index === 17 ? 'unreadable.jpg' : `photo-${index}.jpg`),
  }))
  vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } })
  vi.stubGlobal('createImageBitmap', async (file: File) => {
    if (file.name === 'unreadable.jpg') throw new Error('Invalid image')
    return { width: 600, height: 300, close: vi.fn() }
  })
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({ fillRect: vi.fn(), drawImage: vi.fn() }),
      toDataURL: () => 'data:image/jpeg;base64,AAAA',
    }),
  })
  const sizes: number[] = []
  const request = vi.fn(async (path: string, input: RequestInit) => {
    if (path.endsWith('gallery-intent')) {
      expect(input.body).toBe(JSON.stringify({ query: '너트' }))
      return Response.json({ prompt: 'a hex nut' })
    }
    const { candidates } = JSON.parse(input.body as string) as { candidates: { id: string; image: string }[] }
    sizes.push(candidates.length)
    return Response.json({ results: candidates.map(({ id }) => {
      const score = id === 'img-18' ? 80 : 5
      return { id, score, imageSimilarity: score, contextRelevance: score }
    }) })
  })
  vi.stubGlobal('fetch', request)
  const progress = vi.fn()
  const ranks = await rankConnectedGallery('너트', null, files, new AbortController().signal, progress)
  expect(sizes).toEqual([16, 2])
  expect(progress.mock.calls).toEqual([[16], [19]])
  expect(Object.keys(ranks)).toHaveLength(18)
  expect(ranks['img-17']).toBeUndefined()
  for (const channel of GALLERY_CHANNELS) {
    expect(sortGalleryByRank(files, ranks, channel)[0].id).toBe('img-18')
  }
})

it('keeps connected photos from being sent to a remote web host', async () => {
  vi.stubGlobal('window', { location: { hostname: 'example.com' } })
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(rankConnectedGallery('지갑', null, [], new AbortController().signal, vi.fn()))
    .rejects.toThrow('로컬 주소')
  expect(request).not.toHaveBeenCalled()
})

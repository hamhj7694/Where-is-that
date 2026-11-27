import { describe, expect, it } from 'vitest'
import { bookmarkLink, bookmarkPath } from './bookmarks'

describe('bookmarkPath', () => {
  it('keeps detail paths with their query strings', () => {
    expect(bookmarkPath('/gallery/photo/local-1?back=%2Fgallery%2Fresults&record=abc'))
      .toBe('/gallery/photo/local-1?back=%2Fgallery%2Fresults&record=abc')
    expect(bookmarkPath('/lost-found/item/police/F1%3A1?back=%2Fdirect-search'))
      .toBe('/lost-found/item/police/F1%3A1?back=%2Fdirect-search')
  })

  it('opens the photo detail instead of the transfer dialog', () => {
    expect(bookmarkPath('/gallery/photo/local-1/transfer?back=%2Fgallery%2Fresults'))
      .toBe('/gallery/photo/local-1?back=%2Fgallery%2Fresults')
  })

  it('does not store unrelated paths', () => {
    expect(bookmarkPath('/gallery/results?record=abc')).toBe('/history')
    expect(bookmarkPath('https://example.com/lost-found/item/police/F1%3A1')).toBe('/history')
  })
})

describe('bookmarkLink', () => {
  it('adds the photo name for gallery bookmarks with an old id', () => {
    expect(bookmarkLink('/gallery/photo/local-old?back=%2Fgallery%2Fresults', 'gallery', 'bag.jpg'))
      .toBe('/gallery/photo/local-old?back=%2Fgallery%2Fresults&photo=bag.jpg')
  })
  it('keeps an existing photo name and leaves lost items untouched', () => {
    const path = '/gallery/photo/local-1?photo=bag.jpg'
    expect(bookmarkLink(path, 'gallery', 'other.jpg')).toBe(path)
    expect(bookmarkLink('/lost-found/item/police/F1%3A1', 'lost', 'card')).toBe('/lost-found/item/police/F1%3A1')
  })
})

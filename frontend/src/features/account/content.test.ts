import { describe, expect, it } from 'vitest'
import { initialValuables } from '../workspace/data'
import { dataUrlToFile, deserializeContent, isInitialValuable, mergeContent, type AccountContent, type WireValuable } from './content'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function wireValuable(id: string): WireValuable {
  return {
    id,
    name: '검정 지갑',
    notes: '',
    category: '지갑',
    status: 'kept',
    photos: [{ id: 'p-' + id, name: 'wallet.png', dataUrl: PNG, sampleUrl: null, kind: 'photo' }],
    updatedAt: 1,
  }
}

describe('mergeContent', () => {
  it('keeps saved items and puts local-only work first', () => {
    const account: AccountContent = { valuables: [wireValuable('saved')], records: [] }
    const local: AccountContent = { valuables: [wireValuable('local')], records: [] }
    const merged = mergeContent(account, local)
    expect(merged.valuables.map(item => item.id)).toEqual(['local', 'saved'])
  })

  it('does not duplicate the same id', () => {
    const content: AccountContent = { valuables: [wireValuable('same')], records: [] }
    expect(mergeContent(content, content).valuables).toHaveLength(1)
  })
})

describe('isInitialValuable', () => {
  it('recognizes the untouched sample items', () => {
    expect(isInitialValuable(initialValuables[0])).toBe(true)
    expect(isInitialValuable({ ...initialValuables[0], updatedAt: Date.now() })).toBe(false)
  })
})

describe('deserializeContent', () => {
  it('restores photo files from stored data URLs', () => {
    const content: AccountContent = { valuables: [wireValuable('restored')], records: [] }
    const { items, records } = deserializeContent(content)
    expect(records).toEqual([])
    expect(items[0].photos[0].file).toBeInstanceOf(File)
    expect(items[0].photos[0].file?.name).toBe('wallet.png')
    expect(items[0].photos[0].file?.type).toBe('image/png')
  })
})

describe('dataUrlToFile', () => {
  it('rejects values that are not image data URLs', () => {
    expect(() => dataUrlToFile('javascript:alert(1)', 'x.png')).toThrow()
    expect(() => dataUrlToFile('data:image/png;base64,%%%', 'x.png')).toThrow()
  })
})

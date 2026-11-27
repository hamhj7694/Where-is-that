import { describe, expect, it } from 'vitest'
import { loadGallery, saveGallery } from './gallery-store'

describe('갤러리 연결 저장', () => {
  it('IndexedDB를 쓸 수 없으면 저장된 갤러리가 없다', async () => {
    await expect(loadGallery('guest')).resolves.toBeUndefined()
  })
  it('IndexedDB를 쓸 수 없어도 저장 호출은 조용히 끝난다', async () => {
    await expect(saveGallery('guest', null)).resolves.toBeUndefined()
    await expect(saveGallery('account:1', { name: '여행', files: [] })).resolves.toBeUndefined()
  })
})

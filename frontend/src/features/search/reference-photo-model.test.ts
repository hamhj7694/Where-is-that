import { describe, expect, it } from 'vitest'
import { createSearchRecord } from './history'
import { originalReferencePhoto, rememberReferenceCrop } from './reference-photo-model'

const file = (name: string, content: string) => new File([content], name, { type: 'image/png' })

describe('참고 사진의 원본과 잘라낸 사진 관계', () => {
  it('새 사진과 빈 입력은 다른 사진의 원본을 가져오지 않는다', () => {
    const source = file('photo.png', 'source')
    expect(originalReferencePhoto(source)).toBe(source)
    expect(originalReferencePhoto(null)).toBeNull()
  })

  it('여러 번 잘라도 최초 원본으로 돌아간다', () => {
    const source = file('source.png', 'original')
    const first = file('crop.png', 'first area')
    const second = file('crop.png', 'second area')
    rememberReferenceCrop(first, source)
    rememberReferenceCrop(second, first)
    expect(originalReferencePhoto(first)).toBe(source)
    expect(originalReferencePhoto(second)).toBe(source)
    expect(source.name).toBe('source.png')
    expect(source.size).toBe(8)
  })

  it('다른 화면을 거쳐 검색 기록의 File을 다시 열어도 원본을 복원한다', () => {
    const source = file('gallery-photo.png', 'original source')
    const cropped = file('gallery-photo-영역.png', 'selected area')
    rememberReferenceCrop(cropped, source)
    const record = createSearchRecord('gallery', { query: '검정 지갑', photo: cropped }, { name: '갤러리', files: [source] })
    expect(originalReferencePhoto(record.draft.photo)).toBe(source)
    expect(record.gallery?.files[0]).toBe(source)
  })

  it('같은 파일명인 별도 사진에는 원본 관계를 공유하지 않는다', () => {
    const source = file('source.png', 'first source')
    const first = file('crop.png', 'first crop')
    const unrelated = file('crop.png', 'another photo')
    rememberReferenceCrop(first, source)
    expect(originalReferencePhoto(unrelated)).toBe(unrelated)
  })
})

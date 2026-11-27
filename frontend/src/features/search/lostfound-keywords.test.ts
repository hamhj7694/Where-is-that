import { describe, expect, it } from 'vitest'
import type { FoundItem } from './lostfound-api'
import { lostFoundKeywordFallback, rankLostFoundKeywordMatches } from './lostfound-keywords'

describe('분실물 일반 검색 키워드', () => {
  it.each([
    ['파란색 하치와레 카드를 찾아주세요', '카드'],
    ['짱구 그림이 있는 가방을 찾고 싶어요', '가방'],
    ['지갑을 지하철에서 잃어버렸어요', '지갑'],
    ['지난달에 잃어버린 노란 풍선', '풍선'],
    ['흰 책을 잃어버렸어요', '책'],
    ['우산', ''],
    ['파란색 물건 찾아주세요', ''],
  ])('%s에서 키워드 %s를 고른다', (query, keyword) => {
    expect(lostFoundKeywordFallback(query).keyword).toBe(keyword)
  })

  it('공개 텍스트에서 더 많은 특징이 일치하는 후보를 먼저 보여준다', () => {
    const blue = { id: 'blue', name: '신한카드', color: '다크블루(어두운파랑)' } as FoundItem
    const blueAndCharacter = { id: 'both', name: '신한카드', color: '블루', notes: '하치와레' } as FoundItem
    const noMatch = { id: 'black', name: '신한카드', color: '검정' } as FoundItem
    const { features } = lostFoundKeywordFallback('파란색 하치와레 카드를 찾아주세요')
    expect(rankLostFoundKeywordMatches([noMatch, blue, blueAndCharacter], features).map(item => item.id))
      .toEqual(['both', 'blue', 'black'])
  })
})

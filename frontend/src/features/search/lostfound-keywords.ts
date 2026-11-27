import type { FoundItem } from './lostfound-api'

const filler = /^(혹시|제가|나는|저는|제|내|같은|같아요|같습니다|있나요|있으면|부탁해\S*|해주세요|해줘\S*|찾아\S*|찾고|싶어요|알려\S*|검색해\S*|잃어\S*|잃었\S*|분실했\S*|분실하\S*|분실한|놓고|두고|두었\S*|물건|분실물|지난\S*|이번\S*|어제|그제|오늘|며칠|최근|주말|근처|인근|있는|있던|없는|달린|붙은|그려진|찍힌|작은|큰|얇은|두꺼운)$/
const particle = /(?:으로|이나|에는|랑|을|를|은|는|이|가|에|와|과|도)$/
const colorGroups = [
  ['파란', '파랑', '푸른', '청색', '블루', '남색'],
  ['빨간', '빨강', '붉은', '적색', '레드'],
  ['노란', '노랑', '황색', '옐로우'],
  ['검은', '검정', '까만', '흑색', '블랙'],
  ['하얀', '하양', '흰', '백색', '화이트'],
  ['초록', '녹색', '그린'],
  ['회색', '그레이'],
  ['분홍', '핑크'],
  ['보라', '바이올렛'],
  ['주황', '오렌지'],
  ['갈색', '브라운'],
] as const

function colorAliases(term: string): readonly string[] {
  return colorGroups.find(group => group.some(color => term === color || term === color + '색')) ?? []
}

/** 문장이 일치하지 않을 때 공지·물품명에서 찾을 수 있는 짧은 검색어를 뽑는다. */
export function lostFoundKeywordFallback(query: string) {
  const normalized = query.normalize('NFKC').toLowerCase().trim()
  const words = normalized.match(/[\p{L}\p{N}]+(?:[*●○×][\p{L}\p{N}]+)*/gu) ?? []
  const terms = words.flatMap(word => {
    if (filler.test(word) || /^\d+(?:년|월|일|시|주|개월|쯤)?$/.test(word)) return []
    const place = /(?:에서|근처|인근)$/.test(word)
    const base = word.replace(/(?:에서|근처|인근)$/, '')
    const stem = colorAliases(base).length ? base : base.replace(particle, '')
    return [{ text: stem.length >= 2 || stem === '책' ? stem : base, place }]
  })
  // 장소·색상은 공개 설명에서 순위를 정하는 단서로 쓴다.
  const keyword = [...terms].reverse().find(({ text, place }) => !place && !colorAliases(text).length && !text.endsWith('색')
    && (text.length >= 2 || text === '책'))?.text
  return {
    keyword: keyword && keyword !== normalized ? keyword : '',
    features: [...new Set(terms.map(({ text }) => text).filter(term => term !== keyword && (term.length >= 2 || colorAliases(term).length)))],
  }
}

/** 단서가 공개 제목·설명·색상에 보이는 후보를 앞으로 올린다. */
export function rankLostFoundKeywordMatches(items: readonly FoundItem[], features: readonly string[]): FoundItem[] {
  return items.map(item => {
    const text = [item.name, item.subject, item.notes, item.color, item.category, item.foundPlace, item.storagePlace]
      .join(' ').normalize('NFKC').toLowerCase()
    const score = features.reduce((count, term) =>
      count + Number([term, ...colorAliases(term)].some(value => text.includes(value))), 0)
    return { item, score }
  }).sort((a, b) => b.score - a.score).map(({ item }) => item)
}

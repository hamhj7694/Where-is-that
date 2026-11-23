import type { AiSearchPlan } from './ai-search-api'

/**
 * AI가 자연어·참고 사진에서 뽑은 맞춤 검색 조건.
 * - apiKeywords: 경찰청 PRDT_NM에 넣는 넓은 탐색어(OR). 자연어 문장 전체를 넣으면 0건이 나기 때문에
 *   핵심 명사만 분리해 후보를 먼저 넓게 가져온다.
 * - include(AND) / any(OR) / exclude(NOT): 공개 API 응답 JSON의 모든 텍스트 필드에 적용한다.
 * - imageFeatures: 참고 사진 분석에서 읽은 특징. any와 같은 OR 그룹으로 취급한다.
 */
export interface AiSearchCriteria {
  apiKeywords: string[]
  include: string[]
  any: string[]
  exclude: string[]
  imageFeatures: string[]
}

export const EMPTY_SEARCH_CRITERIA: AiSearchCriteria = {
  apiKeywords: [], include: [], any: [], exclude: [], imageFeatures: [],
}

const MAX_API_KEYWORDS = 3
const MAX_TERMS = 8
const MAX_TERM_LENGTH = 40
// 색상·일반 명사는 탐색어 자리를 차지하지만 고유명사보다 뒤로 보낸다.
const GENERIC_KEYWORDS = new Set([
  '카드', '지갑', '가방', '모자', '인형', '열쇠', '현금', '휴대폰', '안경', '우산', '책', '옷', '신발',
  '검정', '검은색', '빨간색', '파란색', '하늘색', '노란색', '초록색', '흰색', '회색', '갈색', '분홍색', '보라색', '주황색',
])
const isSpecificKeyword = (term: string) => term.length >= 2 && !GENERIC_KEYWORDS.has(term)

// 사람 이름처럼 보이는 짧은 한글어는 공개 원문 텍스트 단서다. 사진 특징으로 넘기면
// 무관한 공개 사진이 이름과 90점으로 맞는 오매칭이 난다.
const KOREAN_NAME = /^[가-힣]{2,3}$/
const SURNAMES = new Set('김이박최정강조윤장임한오서신권황안송전홍류유고문양손배백허남심노하곽성차주우구나지엄채원천방공현함변염여추도소석선설마길연위표명기반라사')
const NON_PERSON_TERMS = new Set([
  '안경', '이불', '신발', '유리', '고무', '문구', '장난감', '박스', '김치',
  '오리', '고양이', '호랑이', '박쥐', '우산', '우표', '연필', '노트',
  '하트', '하늘', '남색', '백색', '유니콘', '이모지', '이모', '진주',
  '민트', '홍삼', '유아', '오락', '기관', '차량', '주머니', '우주',
  '지갑', '지우개', '지폐', '지도', '장갑', '반지',
])
const isPersonName = (term: string) =>
  KOREAN_NAME.test(term) && SURNAMES.has(term[0]) && !NON_PERSON_TERMS.has(term)

function cleanTerms(value: readonly unknown[] | undefined, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const term = entry.trim().replace(/\s+/g, ' ').slice(0, MAX_TERM_LENGTH)
    if (!term || seen.has(term)) continue
    seen.add(term)
    result.push(term)
    if (result.length >= limit) break
  }
  return result
}

function normalizeCriteria(value: unknown): AiSearchCriteria {
  if (!value || typeof value !== 'object') return EMPTY_SEARCH_CRITERIA
  const raw = value as Partial<AiSearchCriteria>
  return {
    apiKeywords: cleanTerms(raw.apiKeywords, MAX_API_KEYWORDS),
    include: cleanTerms(raw.include, MAX_TERMS),
    any: cleanTerms(raw.any, MAX_TERMS),
    exclude: cleanTerms(raw.exclude, MAX_TERMS),
    imageFeatures: cleanTerms(raw.imageFeatures, MAX_TERMS).filter(term => !isPersonName(term)),
  }
}

/**
 * 서버가 criteria를 주지 않는 이전 기록도 검색되도록 채널 계획에서 조건을 유도한다.
 * 사진 분석 문장은 길어서 토큰으로 쓰지 않고, 명사 Keyword와 채널 질의만 탐색어로 사용한다.
 */
export function criteriaFromPlan(plan: AiSearchPlan | null | undefined, fallbackQuery = ''): AiSearchCriteria {
  if (!plan) return EMPTY_SEARCH_CRITERIA
  const provided = normalizeCriteria(plan.criteria)
  const hasProvided = Object.values(provided).some(list => list.length > 0)
  if (hasProvided) {
    if (!provided.apiKeywords.length) {
      const fallback = [plan.channels.combined.query, plan.channels.image.query, ...plan.channels.combined.keywords, fallbackQuery]
      provided.apiKeywords = cleanTerms(fallback, MAX_API_KEYWORDS)
    } else {
      // "치이카와 카드"처럼 AI가 카드만 탐색어로 고르면 제목에 치이카와가 있는 물건을 놓친다.
      // include·imageFeatures의 고유어를 먼저 넣되, 원래 있던 탐색어도 끝에서 밀려나지 않게 보존한다.
      const missing = [...provided.include, ...provided.imageFeatures].filter(
        term => term.length >= 2 && term.length <= 12 && isSpecificKeyword(term)
          && !provided.apiKeywords.includes(term),
      )
      if (missing.length) {
        const specific = provided.apiKeywords.filter(isSpecificKeyword)
        const generic = provided.apiKeywords.filter(term => !isSpecificKeyword(term))
        provided.apiKeywords = cleanTerms([...specific, ...missing, ...generic], MAX_API_KEYWORDS)
      }
    }
    return provided
  }
  const fallback = [
    plan.channels.combined.query,
    plan.channels.image.query,
    ...plan.channels.combined.keywords,
    fallbackQuery,
  ]
  return {
    apiKeywords: cleanTerms(fallback, MAX_API_KEYWORDS),
    include: cleanTerms(plan.channels.combined.keywords, MAX_TERMS),
    any: [],
    exclude: [],
    imageFeatures: [],
  }
}

/** 경찰청에 처음 보낼 단일 PRDT_NM. 여러 탐색어는 서버가 OR로 병합 조회한다. */
export function resolveApiKeyword(criteria: AiSearchCriteria, fallback: string): string {
  return criteria.apiKeywords[0] || fallback.trim()
}

export function hasSearchCriteria(criteria: AiSearchCriteria): boolean {
  return criteria.apiKeywords.length + criteria.include.length + criteria.any.length
    + criteria.exclude.length + criteria.imageFeatures.length > 0
}

export function criteriaToHints(criteria: AiSearchCriteria): Record<string, string[]> {
  return {
    apiKeywords: criteria.apiKeywords,
    include: criteria.include,
    any: criteria.any,
    exclude: criteria.exclude,
    imageFeatures: criteria.imageFeatures,
  }
}

export interface TextSource {
  name?: string | null
  subject?: string | null
  notes?: string | null
  category?: string | null
  color?: string | null
  foundPlace?: string | null
  storagePlace?: string | null
  orgName?: string | null
  address?: string | null
  status?: string | null
}

const TEXT_KEYS: (keyof TextSource)[] = [
  'name', 'subject', 'notes', 'category', 'color', 'foundPlace',
  'storagePlace', 'orgName', 'address', 'status',
]

export function publicItemText(item: TextSource): string {
  return TEXT_KEYS
    .map(key => item[key] ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ko-KR')
}

const MASK_CHARS = '*?●○×'
const MASKED_SPAN = /[^\s()[\],·|]+[*?●○×][^\s()[\],·|]+/g
const WORD = /[^\s()[\],·|]+/g

function maskPattern(token: string): RegExp | null {
  if (![...token].some(char => MASK_CHARS.includes(char))) return null
  // 가려진 글자는 0글자 이상일 수 있다(공개값 '류*진' ↔ 원문 '류진'·'류영진').
  const body = [...token].map(char => MASK_CHARS.includes(char) ? '.{0,3}' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp('^' + body + '$')
}

function maskedNameMatch(needle: string, text: string): boolean {
  const queryPattern = maskPattern(needle)
  if (queryPattern) return (text.match(WORD) ?? []).some(token => queryPattern.test(token))
  for (const span of text.match(MASKED_SPAN) ?? []) {
    const pattern = maskPattern(span)
    if (pattern && needle.split(' ').some(token => pattern.test(token))) return true
  }
  return false
}

function termMatches(term: string, text: string): boolean {
  const needle = term.trim().toLocaleLowerCase('ko-KR')
  if (!needle || !text) return false
  if (text.includes(needle)) return true
  // '가죽 지갑'처럼 띄어쓰기가 섞인 표현은 각 어절이 모두 있으면 일치로 본다.
  const tokens = needle.split(' ').filter(Boolean)
  if (tokens.length > 1 && tokens.every(token => text.includes(token))) return true
  // 공개값이 '류*진'처럼 가려져 있어도 '류영진' 검색을 찾아낸다.
  return maskedNameMatch(needle, text)
}

export interface CriteriaMatch {
  /** NOT 조건에 걸려 제외된 표현. null이면 통과. */
  excludedBy: string | null
  /** AND 조건을 모두 만족했는지. */
  allInclude: boolean
  /** 공개 정보에서 실제로 발견한 조건. */
  hits: string[]
  /** 0~100. 조건이 없으면 0. */
  score: number
}

/** 공개 API JSON 전체 텍스트에 AND/OR/NOT과 사진 특징을 적용한다. */
export function matchPublicItem(item: TextSource, criteria: AiSearchCriteria): CriteriaMatch {
  const empty: CriteriaMatch = { excludedBy: null, allInclude: false, hits: [], score: 0 }
  if (!hasSearchCriteria(criteria)) return empty
  const text = publicItemText(item)
  const excludedBy = criteria.exclude.find(term => termMatches(term, text)) ?? null
  const include = criteria.include.filter(term => termMatches(term, text))
  const varied = [...criteria.any, ...criteria.imageFeatures].filter(term => termMatches(term, text))
  const allInclude = criteria.include.length > 0 && include.length === criteria.include.length
  const hits = [...include, ...varied]
  const weight = criteria.include.length * 3 + criteria.any.length + criteria.imageFeatures.length
  const achieved = include.length * 3 + varied.length
  const score = weight ? Math.min(100, Math.round(achieved / weight * 90 + (allInclude ? 10 : 0))) : 0
  return { excludedBy, allInclude, hits, score }
}

export const criteriaLabels = {
  apiKeywords: '경찰청 탐색어',
  include: 'AND · 모두 포함',
  any: 'OR · 하나 포함',
  exclude: 'NOT · 제외',
  imageFeatures: '사진 특징',
} as const

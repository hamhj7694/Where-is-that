import { describe, expect, it } from 'vitest'
import { browseSearchKey, canResumeBrowseJob, priorScoresForSearch } from './DirectSearchPage'
import type { LostBrowseFilters, LostSearchHints } from '../search/lostfound-api'

type StoredJob = Parameters<typeof priorScoresForSearch>[0]
type LiveState = Parameters<typeof priorScoresForSearch>[1]

function liveWith(raw: Array<{ id: string; visualScore?: number }>, visualScores: Record<string, number> = {}): LiveState {
  return { raw, visualScores } as unknown as LiveState
}

describe('직접 찾기 사진 점수 이어받기', () => {
  const oldJob = { jobId: 'old', keyword: '류영진', reloadToken: 0, skipVisual: 0, priorVisualScores: { 'police:old': 90 } } as StoredJob

  it('검색어를 바꾸면 이전 검색의 사진 점수를 넘기지 않는다', () => {
    const live = liveWith([{ id: 'police:card', visualScore: 90 }], { 'police:card': 90 })
    expect(priorScoresForSearch(oldJob, live, false)).toEqual({})
  })

  it('같은 검색을 이어볼 때만 저장된 점수와 화면 점수를 합친다', () => {
    const live = liveWith([{ id: 'police:card', visualScore: 85 }], { 'police:another': 70 })
    expect(priorScoresForSearch(oldJob, live, true)).toEqual({
      'police:old': 90,
      'police:another': 70,
      'police:card': 85,
    })
  })

  it('저장된 작업이 없어도 이어보기에서는 현재 화면 점수를 유지한다', () => {
    expect(priorScoresForSearch(null, liveWith([{ id: 'police:card', visualScore: 80 }]), true)).toEqual({ 'police:card': 80 })
  })
})

describe('AI 조건 반영을 위한 작업 재사용', () => {
  const filters: LostBrowseFilters = { category: '', color: '', region: '', from: '', to: '' }
  const rawHints: LostSearchHints = { apiKeywords: [], include: [], any: [], exclude: [], prefer: [], imageFeatures: [] }
  const walletHints: LostSearchHints = {
    apiKeywords: ['지갑'], include: ['지갑'], any: ['검은색'], exclude: [], prefer: ['지하철'], imageFeatures: [],
  }
  const rawKey = browseSearchKey(rawHints, filters)
  const walletKey = browseSearchKey(walletHints, filters)

  it('AI가 조건을 찾기 전후의 조회 키는 다르다', () => {
    expect(walletKey).not.toBe(rawKey)
  })

  it('검색어가 같아도 조건이 바뀌면 이전 작업을 재사용하지 않는다', () => {
    const stored = { jobId: 'raw', keyword: '지갑', reloadToken: 0, skipVisual: 0, searchKey: rawKey } as StoredJob
    expect(canResumeBrowseJob(stored, rawKey, '지갑', 'ai', 0, 0)).toBe(true)
    expect(canResumeBrowseJob(stored, walletKey, '지갑', 'ai', 0, 0)).toBe(false)
  })

  it('필터만 바뀌어도 새로 조회한다', () => {
    const datedKey = browseSearchKey(walletHints, { ...filters, from: '2026-11-22' })
    expect(canResumeBrowseJob(
      { jobId: 'old', keyword: '지갑', reloadToken: 0, skipVisual: 0, searchKey: walletKey } as StoredJob,
      datedKey, '지갑', 'ai', 0, 0,
    )).toBe(false)
  })

  it('조건을 모르던 이전 저장 작업은 재사용하지 않는다', () => {
    const stored = { jobId: 'old', keyword: '지갑', reloadToken: 0, skipVisual: 0 } as StoredJob
    expect(canResumeBrowseJob(stored, rawKey, '지갑', 'ai', 0, 0)).toBe(false)
  })
})

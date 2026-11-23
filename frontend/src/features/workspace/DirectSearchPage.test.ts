import { describe, expect, it } from 'vitest'
import { priorScoresForSearch } from './DirectSearchPage'

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

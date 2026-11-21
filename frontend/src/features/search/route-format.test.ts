import { describe, expect, it } from 'vitest'
import { formatRouteDistance, formatRouteDuration } from './route-format'

describe('길 안내 표시', () => {
  it('거리는 1km 이상이면 소수점 한 자리 km로 표시한다', () => {
    expect(formatRouteDistance(11263)).toBe('11.3 km')
    expect(formatRouteDistance(950)).toBe('950 m')
    expect(formatRouteDistance(0)).toBe('거리 정보 없음')
  })

  it('예상 시간은 분과 시간으로 표시한다', () => {
    expect(formatRouteDuration(2521)).toBe('약 42분')
    expect(formatRouteDuration(3720)).toBe('약 1시간 2분')
    expect(formatRouteDuration(3600)).toBe('약 1시간')
    expect(formatRouteDuration(-1)).toBe('시간 정보 없음')
  })
})

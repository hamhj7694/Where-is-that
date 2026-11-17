import { describe, expect, it } from 'vitest'
import { INITIAL_CROP, clampRect, moveRect, pointInImage, rectFromPoints, toPixelRect } from './crop-model'

describe('이미지 안의 영역 선택', () => {
  it('처음에는 가로·세로 각각 중앙 70%를 제안한다', () => {
    expect(toPixelRect(INITIAL_CROP, 1000, 600)).toEqual({ x: 150, y: 90, width: 700, height: 420 })
  })

  it('범위를 벗어난 선택을 이미지 안에 보존하고 입력을 바꾸지 않는다', () => {
    const source = { x: -0.3, y: 0.95, width: 0.4, height: 0.3 }
    expect(clampRect(source)).toEqual({ x: 0, y: 0.7, width: 0.4, height: 0.3 })
    expect(source).toEqual({ x: -0.3, y: 0.95, width: 0.4, height: 0.3 })
    expect(clampRect({ x: 0.5, y: 0.4, width: 2, height: 3 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('반대 방향 드래그도 같은 영역을 만든다', () => {
    const forward = rectFromPoints({ x: 0.2, y: 0.25 }, { x: 0.8, y: 0.75 })
    const reverse = rectFromPoints({ x: 0.8, y: 0.75 }, { x: 0.2, y: 0.25 })
    expect(toPixelRect(forward, 1000, 800)).toEqual({ x: 200, y: 200, width: 600, height: 400 })
    expect(reverse).toEqual(forward)
  })

  it('이동할 때 크기를 유지하고 네 변 밖으로 나가지 않는다', () => {
    const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    expect(moveRect(rect, { x: 1, y: -1 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 })
  })

  it('드래그를 이미지 밖에서 끝내도 이미지 경계로 제한한다', () => {
    expect(rectFromPoints({ x: -2, y: -1 }, { x: 4, y: 3 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('점 선택·잘못된 숫자도 빈 캔버스나 NaN 좌표를 만들지 않는다', () => {
    const rect = clampRect({ x: NaN, y: Infinity, width: -1, height: 0 })
    expect(toPixelRect(rect, 1, 1)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(toPixelRect(rectFromPoints({ x: 1, y: 1 }, { x: 1, y: 1 }), 100, 100)).toEqual({ x: 99, y: 99, width: 1, height: 1 })
  })
})

describe('화면 좌표와 원본 픽셀의 분리', () => {
  it('화면 위치·축소 비율이 달라도 원본의 같은 영역을 만든다', () => {
    const first = pointInImage({ x: 180, y: 160 }, { left: 100, top: 100, width: 400, height: 300 })
    const second = pointInImage({ x: 420, y: 340 }, { left: 100, top: 100, width: 400, height: 300 })
    expect(toPixelRect(rectFromPoints(first, second), 4000, 3000)).toEqual({ x: 800, y: 600, width: 2400, height: 1800 })
  })

  it('가로 사진·세로 사진의 서로 다른 종횡비를 그대로 사용한다', () => {
    const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    expect(toPixelRect(rect, 4000, 2000)).toEqual({ x: 1000, y: 500, width: 2000, height: 1000 })
    expect(toPixelRect(rect, 2000, 4000)).toEqual({ x: 500, y: 1000, width: 1000, height: 2000 })
  })

  it('부분 픽셀을 포함하되 마지막 경계 밖을 읽지 않는다', () => {
    expect(toPixelRect({ x: 0.6, y: 0.6, width: 0.4, height: 0.4 }, 3, 3)).toEqual({ x: 1, y: 1, width: 2, height: 2 })
    expect(pointInImage({ x: -20, y: 500 }, { left: 10, top: 20, width: 100, height: 100 })).toEqual({ x: 0, y: 1 })
  })

  it.each([0, -1, NaN, Infinity, 1.5])('원본 크기 %s를 유효한 이미지로 간주하지 않는다', size => {
    expect(() => toPixelRect(INITIAL_CROP, size, 100)).toThrow(RangeError)
    expect(() => toPixelRect(INITIAL_CROP, 100, size)).toThrow(RangeError)
  })

  it('아직 레이아웃되지 않은 이미지는 좌표 변환을 시작하지 않는다', () => {
    expect(() => pointInImage({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 100 })).toThrow(RangeError)
  })
})

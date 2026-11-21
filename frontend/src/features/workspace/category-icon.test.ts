import { describe, expect, it } from 'vitest'
import { Backpack, Banknote, CreditCard, Headphones, ImageOff, KeyRound, Package, Wallet, Watch } from 'lucide-react'
import { categoryIcon } from './category-icon'

describe('사진 없는 물건의 분류 아이콘', () => {
  it('사용자가 예시로 든 분류에 맞는 아이콘을 고른다', () => {
    expect(categoryIcon('전자기기 > 무선이어폰')).toBe(Headphones)
    expect(categoryIcon('가방 > 남성용가방')).toBe(Backpack)
    expect(categoryIcon('현금 > 현금')).toBe(Banknote)
  })
  it('공백이 있는 분류 문자열도 같은 아이콘으로 처리한다', () => {
    expect(categoryIcon('가방 > 남성용 가방')).toBe(Backpack)
    expect(categoryIcon('전자기기 > 무선 이어폰')).toBe(Headphones)
  })
  it('다른 주요 분류도 구분한다', () => {
    expect(categoryIcon('지갑 > 여성용 지갑')).toBe(Wallet)
    expect(categoryIcon('카드 > 신용(체크)카드')).toBe(CreditCard)
    expect(categoryIcon('귀금속 > 시계')).toBe(Watch)
    expect(categoryIcon('자동차 > 자동차열쇠')).toBe(KeyRound)
  })
  it('분류가 없거나 알 수 없으면 기본 아이콘을 쓴다', () => {
    expect(categoryIcon(null)).toBe(ImageOff)
    expect(categoryIcon('')).toBe(ImageOff)
    expect(categoryIcon('기타물품 > 기타')).toBe(Package)
  })
})

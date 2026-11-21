import { Backpack, Banknote, BookOpen, Car, CreditCard, Dumbbell, FileText, Gem, Glasses, Guitar, Headphones, IdCard, ImageOff, KeyRound, Laptop, Package, Shirt, ShoppingBag, Smartphone, Tablet, Ticket, Wallet, Watch, type LucideIcon } from 'lucide-react'

/**
 * 사진이 없는 물건 카드에 보여줄 분류 아이콘.
 * 경찰청 공개 분류('대분류 > 소분류')를 공백 제거 후 앞에서부터 매칭한다.
 */
export function categoryIcon(category: string | null | undefined): LucideIcon {
  const text = (category ?? '').replace(/\s+/g, '')
  if (!text) return ImageOff

  if (/무선이어폰|이어폰|헤드폰/.test(text)) return Headphones
  if (/스마트워치|시계/.test(text)) return Watch
  if (/태블릿/.test(text)) return Tablet
  if (/아이폰|삼성휴대폰|휴대폰|통신기기/.test(text)) return Smartphone
  if (/노트북|컴퓨터/.test(text)) return Laptop
  if (/전자기기/.test(text)) return Headphones

  if (/현금|유가증권/.test(text)) return Banknote
  if (/카드/.test(text)) return CreditCard
  if (/지갑/.test(text)) return Wallet

  if (/남성용가방|백팩/.test(text)) return Backpack
  if (/여성용가방|쇼핑백/.test(text)) return ShoppingBag
  if (/가방/.test(text)) return Backpack

  if (/반지|목걸이|귀걸이|귀금속/.test(text)) return Gem
  if (/선글라스|안경/.test(text)) return Glasses
  if (/도서|서적/.test(text)) return BookOpen
  if (/신분증|면허증|여권/.test(text)) return IdCard
  if (/증명서|서류/.test(text)) return FileText
  if (/의류|모자|신발/.test(text)) return Shirt
  if (/열쇠/.test(text)) return KeyRound
  if (/자동차/.test(text)) return Car
  if (/악기/.test(text)) return Guitar
  if (/스포츠/.test(text)) return Dumbbell
  if (/티켓|이용권|승차권/.test(text)) return Ticket

  return Package
}

export interface AuthUser {
  id: number
  email: string
  nickname: string
  provider: 'local' | 'kakao'
  createdAt: string
  profileImage: string
  lastVisitAt: string | null
}

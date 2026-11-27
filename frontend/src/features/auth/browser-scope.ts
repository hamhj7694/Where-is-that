import { useAuth } from './AuthContext'

export type BrowserScope = 'guest' | `account:${number}`

export function browserScope(userId: number | null): BrowserScope {
  return userId === null ? 'guest' : `account:${userId}`
}
export function useBrowserScope(): BrowserScope | null {
  const { user, ready } = useAuth()
  return ready ? browserScope(user?.id ?? null) : null
}

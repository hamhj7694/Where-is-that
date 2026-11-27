import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  completeKakaoLogin as completeKakaoRequest,
  deleteAccount as deleteAccountRequest,
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  signup as signupRequest,
  startKakaoLogin,
  updateProfile as updateProfileRequest,
  type SignupInput,
} from './api'
import type { AuthUser } from './types'

interface AuthValue {
  user: AuthUser | null
  authenticated: boolean
  ready: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (input: SignupInput) => Promise<void>
  signOut: () => Promise<void>
  beginKakaoLogin: (returnTo: string) => Promise<void>
  finishKakaoLogin: (code: string, state: string) => Promise<string>
  updateProfile: (nickname: string, profileImage: string) => Promise<void>
  deleteAccount: (confirmation: string) => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)
const SESSION_CHANGED_KEY = 'geugeo-eodi:session-changed'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [ready, setReady] = useState(false)
  const revision = useRef(0)

  useEffect(() => {
    let active = true
    const sync = () => {
      const current = ++revision.current
      const isCurrent = () => active && current === revision.current
      void fetchMe().then(next => { if (isCurrent()) setUser(next) })
        .catch(() => { if (isCurrent()) setUser(null) })
        .finally(() => { if (isCurrent()) setReady(true) })
    }
    const onSessionChange = (event: StorageEvent) => {
      if (event.key !== SESSION_CHANGED_KEY) return
      setUser(null)
      setReady(false)
      sync()
    }
    sync()
    window.addEventListener('storage', onSessionChange)
    return () => { active = false; window.removeEventListener('storage', onSessionChange) }
  }, [])

  const setSession = useCallback((next: AuthUser | null) => {
    revision.current++
    setUser(next)
    setReady(true)
    // The signal lets other tabs recheck the session without storing user data.
    try { window.localStorage.setItem(SESSION_CHANGED_KEY, `${Date.now()}:${Math.random()}`) } catch { /* Storage is optional. */ }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setSession(await loginRequest(email, password))
  }, [setSession])

  const signUp = useCallback(async (input: SignupInput) => {
    setSession(await signupRequest(input))
  }, [setSession])

  const signOut = useCallback(async () => {
    await logoutRequest()
    setSession(null)
  }, [setSession])

  const beginKakaoLogin = useCallback(async (returnTo: string) => {
    window.location.assign(await startKakaoLogin(returnTo))
  }, [])

  const finishKakaoLogin = useCallback(async (code: string, state: string) => {
    const result = await completeKakaoRequest(code, state)
    setSession(result.user)
    return result.returnTo
  }, [setSession])

  const updateProfile = useCallback(async (nickname: string, profileImage: string) => {
    const current = revision.current
    const next = await updateProfileRequest(nickname, profileImage)
    if (current === revision.current) setUser(next)
  }, [])

  const deleteAccount = useCallback(async (confirmation: string) => {
    await deleteAccountRequest(confirmation)
    setSession(null)
  }, [setSession])

  const value = useMemo<AuthValue>(() => ({
    user,
    authenticated: user !== null,
    ready,
    signIn,
    signUp,
    signOut,
    beginKakaoLogin,
    finishKakaoLogin,
    updateProfile,
    deleteAccount,
  }), [user, ready, signIn, signUp, signOut, beginKakaoLogin, finishKakaoLogin, updateProfile, deleteAccount])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth는 AuthProvider 안에서만 사용할 수 있어요.')
  return context
}

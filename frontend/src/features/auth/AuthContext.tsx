import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    void fetchMe().then(next => { if (active) setUser(next) })
      .catch(() => { if (active) setUser(null) })
      .finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setUser(await loginRequest(email, password))
  }, [])

  const signUp = useCallback(async (input: SignupInput) => {
    setUser(await signupRequest(input))
  }, [])

  const signOut = useCallback(async () => {
    await logoutRequest()
    setUser(null)
  }, [])

  const beginKakaoLogin = useCallback(async (returnTo: string) => {
    window.location.assign(await startKakaoLogin(returnTo))
  }, [])

  const finishKakaoLogin = useCallback(async (code: string, state: string) => {
    const result = await completeKakaoRequest(code, state)
    setUser(result.user)
    return result.returnTo
  }, [])

  const updateProfile = useCallback(async (nickname: string, profileImage: string) => {
    setUser(await updateProfileRequest(nickname, profileImage))
  }, [])

  const deleteAccount = useCallback(async (confirmation: string) => {
    await deleteAccountRequest(confirmation)
    setUser(null)
  }, [])

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

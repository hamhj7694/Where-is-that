import type { AuthUser } from './types'

interface UserPayload {
  id: number
  email: string
  nickname: string
  provider: 'local' | 'kakao'
  created_at: string
  profile_image?: string
  last_visit_at?: string | null
}

interface ApiErrorPayload {
  code?: string
  message?: string
}

export interface SignupInput {
  email: string
  password: string
  nickname?: string
  recoveryQuestion: string
  recoveryAnswer: string
}

export class AuthApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'AuthApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new AuthApiError('network', '서버에 연결하지 못했어요.', 0)
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (!body || typeof body !== 'object') {
      if (response.status >= 500) throw new AuthApiError('network', '서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.', response.status)
      throw new AuthApiError('unknown', '요청을 처리하지 못했어요.', response.status)
    }
    const error = body as ApiErrorPayload
    throw new AuthApiError(error.code ?? 'unknown', error.message ?? '요청을 처리하지 못했어요.', response.status)
  }
  return body as T
}

function toUser(payload: UserPayload): AuthUser {
  return {
    id: payload.id,
    email: payload.email,
    nickname: payload.nickname,
    provider: payload.provider,
    createdAt: payload.created_at,
    profileImage: payload.profile_image ?? '',
    lastVisitAt: payload.last_visit_at ?? null,
  }
}

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    return toUser(await request<UserPayload>('/auth/me'))
  } catch (reason) {
    if (reason instanceof AuthApiError && reason.status === 401) return null
    throw reason
  }
}

export async function signup(input: SignupInput): Promise<AuthUser> {
  return toUser(await request<UserPayload>('/auth/signup', {
    method: 'POST',
    body: JSON.stringify(input),
  }))
}

export async function login(email: string, password: string): Promise<AuthUser> {
  return toUser(await request<UserPayload>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }))
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>('/auth/logout', { method: 'POST' })
}

export async function fetchRecoveryQuestions(): Promise<string[]> {
  const result = await request<{ questions: string[] }>('/auth/recovery-questions')
  return result.questions
}

export async function findEmail(nickname: string, recoveryQuestion: string, recoveryAnswer: string): Promise<string[]> {
  const result = await request<{ emails: string[] }>('/auth/find-email', {
    method: 'POST',
    body: JSON.stringify({ nickname, recoveryQuestion, recoveryAnswer }),
  })
  return result.emails
}

export async function resetPassword(email: string, recoveryQuestion: string, recoveryAnswer: string, newPassword: string): Promise<void> {
  await request<{ ok: boolean }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, recoveryQuestion, recoveryAnswer, newPassword }),
  })
}

export async function startKakaoLogin(returnTo: string): Promise<string> {
  const result = await request<{ authorizeUrl: string }>('/auth/kakao/start', {
    method: 'POST',
    body: JSON.stringify({ returnTo }),
  })
  return result.authorizeUrl
}

export async function completeKakaoLogin(code: string, state: string): Promise<{ user: AuthUser; returnTo: string }> {
  const result = await request<{ user: UserPayload; returnTo: string }>('/auth/kakao/callback', {
    method: 'POST',
    body: JSON.stringify({ code, state }),
  })
  return { user: toUser(result.user), returnTo: result.returnTo }
}

export async function updateProfile(nickname: string, profileImage: string): Promise<AuthUser> {
  return toUser(await request<UserPayload>('/me/profile', {
    method: 'PATCH',
    body: JSON.stringify({ nickname, profileImage }),
  }))
}

export async function deleteAccount(confirmation: string): Promise<void> {
  await request<{ ok: boolean }>('/me', {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  })
}

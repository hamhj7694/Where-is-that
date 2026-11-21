import type { AccountContent } from './content'

interface ApiErrorPayload {
  code?: string
  message?: string
}

export class ContentApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'ContentApiError'
  }
}

async function request(path: string, init?: RequestInit): Promise<AccountContent> {
  let response: Response
  try {
    response = await fetch('/api' + path, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new ContentApiError('network', '서버에 연결하지 못했어요.', 0)
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (!body || typeof body !== 'object') {
      if (response.status >= 500) throw new ContentApiError('network', '서버에 연결하지 못했어요. 백엔드가 실행 중인지 확인해 주세요.', response.status)
      throw new ContentApiError('unknown', '요청을 처리하지 못했어요.', response.status)
    }
    const error = body as ApiErrorPayload
    throw new ContentApiError(error.code ?? 'unknown', error.message ?? '요청을 처리하지 못했어요.', response.status)
  }
  return body as AccountContent
}

export function fetchContent(): Promise<AccountContent> {
  return request('/me/content')
}

export function saveContent(content: AccountContent): Promise<AccountContent> {
  return request('/me/content', { method: 'PUT', body: JSON.stringify(content) })
}

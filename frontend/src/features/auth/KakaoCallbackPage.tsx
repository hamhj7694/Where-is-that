import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { AuthApiError } from './api'
import { useAuth } from './AuthContext'
import { authErrorMessage } from './messages'
import { PageHeading } from '../workspace/components'
import { safeReturn } from '../workspace/data'

export default function KakaoCallbackPage() {
  const { finishKakaoLogin } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const started = useRef(false)
  const search = params.toString()
  const [error, setError] = useState('')
  const returnTo = '/valuables'

  useEffect(() => {
    if (started.current) return
    started.current = true
    const query = new URLSearchParams(search)
    const providerError = query.get('error')
    const state = query.get('state')
    const code = query.get('code')
    if (providerError) { setError(authErrorMessage(providerError)); return }
    if (!state) { setError(authErrorMessage('invalid_state')); return }
    if (!code) { setError(authErrorMessage('missing_code')); return }
    void finishKakaoLogin(code, state).then(next => {
      navigate(safeReturn(next, '/valuables'), { replace: true })
    }).catch((reason: unknown) => {
      setError(reason instanceof AuthApiError ? reason.message : authErrorMessage('unknown'))
    })
    // One-shot callback: keep the result alive across StrictMode's dev-only effect replay.
  }, [search, finishKakaoLogin, navigate])

  return <main id="main-content" className="content-workspace"><div className="login-panel">
    <PageHeading title="카카오 로그인" description={error ? undefined : '카카오 로그인 정보를 확인하고 있어요.'} />
    {error ? <p className="inline-error" role="alert">{error}</p>
      : <p className="field__help" role="status">잠시만 기다려 주세요.</p>}
    <Link className="button button--primary" to={'/auth/login?returnTo=' + encodeURIComponent(returnTo)}>{error ? '다시 로그인하기' : '로그인 화면으로'}<ArrowRight aria-hidden="true" /></Link>
    <Link className="button button--secondary" to="/">검색으로 돌아가기</Link>
  </div></main>
}

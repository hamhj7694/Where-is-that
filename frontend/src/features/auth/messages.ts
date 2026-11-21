export function authErrorMessage(code: string | null, fallback = '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.'): string {
  switch (code) {
    case 'access_denied':
    case 'user_denied': return '카카오 로그인을 취소했어요.'
    case 'missing_code': return '카카오에서 인가 코드를 받지 못했어요.'
    case 'invalid_state': return '로그인 요청이 만료됐어요. 다시 시도해 주세요.'
    case 'kakao_not_configured': return '카카오 로그인 설정이 필요해요. 서버 .env를 확인해 주세요.'
    case 'kakao_token': return '카카오 토큰을 받지 못했어요.'
    case 'kakao_user': return '카카오 사용자 정보를 가져오지 못했어요.'
    case 'kakao_network': return '카카오 인증 서버에 연결하지 못했어요.'
    case 'network': return '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'
    case 'invalid_credentials': return '이메일 또는 비밀번호가 올바르지 않아요.'
    case 'email_taken': return '이미 가입된 이메일이에요.'
    case 'recovery_mismatch': return '입력한 정보가 올바르지 않아요.'
    case 'validation': return '입력값을 확인해 주세요.'
    default: return fallback
  }
}

export function messageFromError(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'code' in reason && 'message' in reason && typeof reason.message === 'string') return reason.message
  return authErrorMessage('unknown')
}

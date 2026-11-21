import { describe, expect, it } from 'vitest'
import { authErrorMessage, messageFromError } from './messages'

describe('인증 오류 안내', () => {
  it.each([
    ['invalid_credentials', '이메일'],
    ['email_taken', '가입된'],
    ['kakao_not_configured', '설정'],
    ['invalid_state', '만료'],
    ['access_denied', '취소'],
    ['network', '연결'],
    ['etc', '로그인하지 못했어요'],
  ])('%s 사유에 맞는 안내를 표시한다', (code, expected) => {
    expect(authErrorMessage(code)).toContain(expected)
  })

  it('서버가 준 메시지가 있으면 그대로 사용한다', () => {
    expect(messageFromError({ code: 'validation', message: '필수 항목을 입력해 주세요.' })).toBe('필수 항목을 입력해 주세요.')
  })

  it('알 수 없는 오류는 기본 안내를 사용한다', () => {
    expect(messageFromError(new Error('boom'))).toBe('로그인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  })
})

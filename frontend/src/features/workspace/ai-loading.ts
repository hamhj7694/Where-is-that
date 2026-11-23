/** AI 분석이 캐시 등으로 너무 빨리 끝나도 로봇 장면이 충분히 보이게 하는 최소 노출 시간. */
export const MIN_AI_SEARCH_VISIBLE_MS = 900

export function minimumWait(startedAt: number, minimumMs = MIN_AI_SEARCH_VISIBLE_MS): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt)
  return remaining > 0 ? new Promise(resolve => window.setTimeout(resolve, remaining)) : Promise.resolve()
}

/** 실제 분석 결과는 기다리되, 로봇 로딩이 최소 시간 동안은 화면에 남는다. */
export function withMinimumVisible<T>(startedAt: number, work: Promise<T>, minimumMs = MIN_AI_SEARCH_VISIBLE_MS): Promise<T> {
  return Promise.all([work, minimumWait(startedAt, minimumMs)]).then(([value]) => value)
}

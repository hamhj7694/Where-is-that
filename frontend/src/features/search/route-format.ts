export function formatRouteDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '거리 정보 없음'
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`
}

export function formatRouteDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '시간 정보 없음'
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `약 ${minutes}분`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `약 ${hours}시간 ${rest}분` : `약 ${hours}시간`
}

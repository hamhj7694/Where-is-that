import type { PublicSearchCoverage } from '../search/lostfound-api'

export default function PublicSearchScope({ coverage }: { coverage: PublicSearchCoverage }) {
  return <details className="lost-ai-criteria">
    <summary>{coverage.from} ~ {coverage.to} · {coverage.complete ? '공개 목록 확인 완료' : '공개 목록 일부 확인'}</summary>
    <p>경찰청 {coverage.sources.police.pagesRead}페이지 · 포털기관 {coverage.sources.portal.pagesRead}페이지 확인</p>
    <p>{coverage.basis === 'explicit' ? '선택한 기간' : coverage.basis === 'inferred' ? '입력에서 확인한 기간' : '기본 최근 2개월'}
      {coverage.clipped && ' · 최대 6개월 적용'} · 사진과 설명 비교 범위는 결과에서 확인할 수 있어요.</p>
    {coverage.basis === 'inferred' && coverage.dateBufferDays !== undefined &&
      <p>분실일과 습득일이 다를 수 있어, 말해 준 시점의 {coverage.dateBufferDays}일 전부터 {coverage.clipped ? '최대 조회일' : '오늘'}까지 살펴봐요.</p>}
  </details>
}

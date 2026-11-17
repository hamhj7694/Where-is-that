import type { SearchMode } from './model'

function SchedulePreview() {
  return <div className="schedule-preview" aria-label="글자를 읽을 수 있는 일정표 스크린샷 예시">
    <div className="schedule-preview__title"><span>이번 주 일정</span><span>주간</span></div>
    <div className="schedule-preview__days">{['월', '화', '수', '목', '금'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="schedule-preview__grid"><span>기획 검토</span><span>자료 공유</span><span>화면 정리</span></div>
  </div>
}

export default function PhotoGuide({ mode }: { mode: SearchMode }) {
  const items = mode === 'gallery' ? [
    { title: '장면이 보이게', detail: '기억나는 물건이나 장면을 담아요.', image: '/images/coast.jpg', alt: '해안의 전체 장면이 보이는 사진 예시', crop: false },
    { title: '특징이 선명하게', detail: '색상·모양이 잘 보이면 좋아요.', image: '/images/card.jpg', alt: '지갑의 색상과 형태가 보이는 사진 예시', crop: false },
    { title: '필요한 부분만', detail: '사진 앱에서 잘라 준비해 주세요.', image: '/images/wallet.jpg', alt: '지갑 부분에 잘라낼 영역을 표시한 예시', crop: true },
    { title: '스크린샷도 가능', detail: '글자를 읽을 수 있게 준비해요.', image: null, alt: '', crop: false },
  ] : [
    { title: '분실 전 사진', detail: '물건이 나온 예전 사진도 좋아요.', image: '/images/wallet.jpg', alt: '물건 전체가 담긴 참고 사진 예시', crop: false },
    { title: '특징이 선명하게', detail: '색상·모양·로고가 보이게 골라요.', image: '/images/card.jpg', alt: '지갑의 색상과 형태가 보이는 예시', crop: false },
    { title: '필요한 부분만', detail: '사진을 고른 뒤 영역을 선택해요.', image: '/images/wallet.jpg', alt: '검색할 지갑 부분에 잘라낼 영역을 표시한 예시', crop: true },
    { title: '물건이 잘 보이게', detail: '형태를 알아볼 수 있는 사진이 좋아요.', image: '/images/detail.jpg', alt: '열쇠고리 전체의 모양이 보이는 사진 예시', crop: false },
  ]
  return <section className="photo-guide" aria-labelledby="photo-guide-heading">
    <div className="photo-guide__heading"><h3 id="photo-guide-heading">이런 사진이 좋아요</h3></div>
    <div className="photo-guide__grid">{items.map(item => <figure key={item.title}>
      <div className={`photo-guide__image ${item.crop ? 'photo-guide__image--crop' : ''}`}>
        {item.image ? <img src={item.image} alt={item.alt} width="400" height="300" /> : <SchedulePreview />}
        {item.crop && <span className="crop-target" aria-hidden="true" />}
      </div>
      <figcaption><strong>{item.title}</strong><p>{item.detail}</p></figcaption>
    </figure>)}</div>
    <p className="photo-guide__note">준비를 돕는 샘플 · 검색 결과가 아니에요</p>
  </section>
}

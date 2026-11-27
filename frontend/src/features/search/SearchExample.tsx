import type { SearchMode } from './model'

const examples = {
  gallery: {
    image: '/images/coast.jpg',
    alt: '짙은 초록빛 절벽과 흰 파도가 보이는 해안',
    query: '파도가 부서지고 초록색 절벽이 보이는 바닷가',
  },
  lost: {
    image: '/brand/umbrella-detail.webp',
    alt: '주황색 손목 끈이 달린 남색 접이식 우산',
    query: '주황색 손목 끈이 달린 남색 접이식 우산',
    credit: 'AI로 만든 예시 사진',
  },
} as const

export default function SearchExample({ mode }: { mode: SearchMode }) {
  const example = examples[mode]
  return <figure className="search-example">
    <div className="search-example__photo"><img src={example.image} alt={example.alt} /></div>
    <figcaption className="search-example__caption">
      <span>입력 예시</span>
      <p>“{example.query}”</p>
      {'credit' in example && <small>{example.credit}</small>}
    </figcaption>
  </figure>
}

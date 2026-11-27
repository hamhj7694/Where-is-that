import { ArrowRight, Images, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { copy } from '../search/copy'
import '../../styles/home-cover.css'

export default function HomeCover() {
  return (
    <main id="main-content" className="home-cover" tabIndex={-1}>
      <div className="home-cover__inner">
        <section className="home-cover__intro" aria-labelledby="home-cover-title">
          <h1 id="home-cover-title">
            <span>기억나는 단서부터</span>
            <span>다시 찾아봐요</span>
          </h1>
          <p>내 사진은 연결한 갤러리에서, 분실물은 공개 습득물 목록에서 찾아봐요. 기억나는 특징을 적거나 사진을 첨부해 시작하세요.</p>
          <nav className="home-cover__actions" aria-label="검색 시작">
            <Link to="/lost-found" className="home-cover__action home-cover__action--primary">
              분실물 찾기<ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link to="/gallery" className="home-cover__action home-cover__action--secondary">
              <Images size={18} aria-hidden="true" />갤러리에서 사진 찾기
            </Link>
          </nav>
        </section>
        <figure className="home-cover__visual">
          <div className="cover-phone">
            <div className="cover-phone__screen">
              <div className="cover-phone__app-title"><Search size={16} aria-hidden="true" />분실물 찾기</div>
              <p className="cover-phone__question">{copy.lost.title}</p>
              <div className="cover-phone__photo">
                <img src="/brand/cover-umbrella.webp" alt="주황색 손목 끈이 달린 남색 접이식 우산과 그 옆의 열쇠" width={1536} height={1024} fetchPriority="high" />
              </div>
              <div className="cover-phone__query">
                <span>기억나는 특징</span>
                <p>주황색 끈이 달린<br />남색 접이식 우산</p>
              </div>
            </div>
          </div>
          <figcaption>분실물 검색 예시 · AI로 만든 참고 사진</figcaption>
        </figure>
      </div>
    </main>
  )
}

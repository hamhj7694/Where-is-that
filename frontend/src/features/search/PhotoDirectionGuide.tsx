import { useId } from 'react'
import type { ReferencePhotoView } from './model'

const views: { value: ReferencePhotoView; label: string }[] = [
  { value: 'front', label: '정면(앞)' }, { value: 'back', label: '뒤' }, { value: 'side', label: '옆' },
  { value: 'top', label: '위' }, { value: 'bottom', label: '아래' }, { value: 'diagonal', label: '대각선' },
]

/** Six views of one illustrated bag, not uploaded photos or AI predictions. */
function BagView({ view }: { view: ReferencePhotoView }) {
  return <svg viewBox="0 0 96 96" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {view === 'front' && <><path d="M38 26V19a10 10 0 0 1 20 0v7" /><rect x="24" y="24" width="48" height="58" rx="10" fill="var(--angle-bag)" /><path d="M31 35h34M64 35v7" /><rect x="32" y="52" width="32" height="20" rx="4" fill="var(--angle-panel)" /><path d="M34 57h28" /><rect x="52" y="40" width="8" height="5" rx="1" fill="var(--accent)" stroke="none" /></>}
    {view === 'back' && <><path d="M38 26V19a10 10 0 0 1 20 0v7" /><rect x="24" y="24" width="48" height="58" rx="10" fill="var(--angle-bag)" /><path d="M36 31c-9 12-8 30-3 42l7-2c-4-13-3-25 2-37ZM60 31c9 12 8 30 3 42l-7-2c4-13 3-25-2-37Z" fill="var(--angle-panel)" /><path d="M44 53h8" /></>}
    {view === 'side' && <><path d="M46 25V18c0-6 10-6 10 0v7" /><rect x="36" y="24" width="24" height="58" rx="8" fill="var(--angle-bag)" /><path d="M48 28v50M39 51h18v20H39" /><path d="M60 32c12 9 12 31 2 41" /><rect x="40" y="37" width="5" height="7" rx="1" fill="var(--accent)" stroke="none" /></>}
    {view === 'top' && <><rect x="20" y="34" width="56" height="30" rx="12" fill="var(--angle-bag)" /><path d="M28 49h40M65 49v7M38 36V27h20v9" /><rect x="54" y="58" width="9" height="4" rx="1" fill="var(--accent)" stroke="none" /></>}
    {view === 'bottom' && <><rect x="20" y="34" width="56" height="30" rx="12" fill="var(--angle-panel)" /><path d="M29 39h38M29 59h38M27 44v10M69 44v10" /><circle cx="32" cy="43" r="2" fill="currentColor" stroke="none" /><circle cx="64" cy="43" r="2" fill="currentColor" stroke="none" /><circle cx="32" cy="55" r="2" fill="currentColor" stroke="none" /><circle cx="64" cy="55" r="2" fill="currentColor" stroke="none" /></>}
    {view === 'diagonal' && <><path d="m27 34 17-12 32 12-18 13Z" fill="var(--angle-panel)" /><path d="m58 47 18-13v40L58 86Z" fill="var(--angle-side)" /><path d="m27 34 31 13v39L27 73Z" fill="var(--angle-bag)" /><path d="m38 31 13 5M40 29v-9c0-7 12-1 12 5v9M32 45l20 8" /><path d="m33 56 18 7v13l-18-7Z" fill="var(--angle-panel)" /><path d="m34 60 16 6" /><path d="m48 47 5 2v5l-5-2Z" fill="var(--accent)" stroke="none" /></>}
  </svg>
}

export default function PhotoDirectionGuide({ compact = false }: { compact?: boolean }) {
  const id = useId()
  return <section className={'photo-direction-guide' + (compact ? ' photo-direction-guide--compact' : '')} aria-labelledby={id}><div className="photo-direction-guide__heading"><h3 id={id}>어느 방향에서 찍었나요?</h3><span>같은 가방을 본 방향 · 그림 예시</span></div>
    <div className="photo-direction-guide__views">{views.map(view => <figure key={view.value}><BagView view={view.value} /><figcaption>{view.label}</figcaption></figure>)}</div>
    <p>{compact ? '사진 아래에서 방향을 골라 주세요. 모르면 미지정으로 두세요.' : '사진 아래에서 방향을 골라 주세요. 헷갈리면 미지정으로 두어도 괜찮아요.'}</p>
  </section>
}

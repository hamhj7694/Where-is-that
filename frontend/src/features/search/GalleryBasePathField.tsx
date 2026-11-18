import { useId } from 'react'

export default function GalleryBasePathField({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId()
  return <details className="gallery-base-path"><summary>전체 경로도 함께 연결하기 <span>(선택)</span></summary><div className="field"><label htmlFor={id}>선택할 폴더의 전체 경로</label><input id={id} type="text" value={value} disabled={disabled} autoComplete="off" spellCheck={false} placeholder={'예: C:\\Users\\사용자\\Pictures\\내 사진'} onChange={event => onChange(event.target.value)} aria-describedby={id + '-help'} /><p id={id + '-help'} className="field__help">탐색기 주소 표시줄의 폴더 위치를 붙여넣어 주세요. 하위 경로·파일명을 자동으로 붙여요. 개별 사진은 같은 폴더에서 골라 주세요. 이 탭에서만 사용해요.</p></div></details>
}

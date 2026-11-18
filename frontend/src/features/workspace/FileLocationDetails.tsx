import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import Modal from '../../components/Modal'
import { clearFileLocations, getFileLocation, prepareFileLocations, rememberFileLocations } from '../search/file-location-model'
import { formatFileSize } from '../search/model'
import type { AppPhoto } from './data'

export default function FileLocationDetails({ photo, beforeCopy, afterCopy, copied, onCopied }: { photo: AppPhoto; beforeCopy?: ReactNode; afterCopy?: ReactNode; copied: string; onCopied: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const [basePath, setBasePath] = useState('')
  const [error, setError] = useState('')
  const [, refresh] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const file = photo.file
  const location = file ? getFileLocation(file) : null
  const folderName = file?.webkitRelativePath.split('/')[0] || ''
  let preview = ''
  if (file && basePath.trim()) { try { preview = prepareFileLocations([file], basePath)[0]?.path ?? '' } catch { /* Validation is shown on submit. */ } }

  function show() {
    if (file && location?.source === 'user-provided') {
      const suffix = file.webkitRelativePath ? file.webkitRelativePath.split(/[\\/]/).slice(1).join('\\') : file.name
      const parent = location.path.slice(0, -suffix.length)
      setBasePath(/^[a-z]:\\$/i.test(parent) ? parent : parent.replace(/\\$/, ''))
    }
    setError(''); onCopied(''); setOpen(true)
  }
  async function copy(path: string) {
    try { await navigator.clipboard.writeText(path); onCopied('파일 위치를 복사했어요.') }
    catch { onCopied('복사하지 못했어요. 위 파일 위치를 직접 복사해 주세요.') }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!file) return
    try {
      const assignments = prepareFileLocations([file], basePath)
      rememberFileLocations(assignments); refresh(value => value + 1); setOpen(false)
      await copy(assignments[0].path)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '폴더 경로를 확인해 주세요.') }
  }
  function clear() { if (!file) return; clearFileLocations([file]); refresh(value => value + 1); setBasePath(''); setError(''); setOpen(false); onCopied('직접 입력한 경로를 지웠어요.') }

  return <><dl className="detail-facts"><div><dt>파일</dt><dd>{photo.name}</dd></div>{file && <><div><dt>파일 위치</dt><dd>{location?.path || '폴더 위치 설정 필요'}</dd></div><div><dt>크기</dt><dd>{formatFileSize(file.size)}</dd></div><div><dt>형식</dt><dd>{file.type || '이미지'}</dd></div>{photo.updatedAt ? <div><dt>파일 수정일</dt><dd>{new Date(photo.updatedAt).toLocaleDateString('ko-KR')}</dd></div> : null}</>}</dl>
    {file && <p id={id + '-help'} className="field__help">{location?.source === 'local-connector' ? '이 기기에서 연결할 때 확인한 전체 경로예요.' : location?.source === 'user-provided' ? '직접 지정한 위치예요. 실제 저장 위치와 맞는지 확인해 주세요.' : location ? '연결한 폴더 안의 상대 경로예요. 전체 경로는 별도로 설정할 수 있어요.' : '파일 위치 복사를 누르고 사진이 있는 폴더 경로를 한 번 지정해 주세요.'}</p>}
    <div className="detail-actions">{beforeCopy}{file && <><button type="button" className="button button--secondary file-location-copy" aria-describedby={id + '-help'} aria-haspopup={!location ? 'dialog' : undefined} onClick={() => { if (location) void copy(location.path); else show() }}><Copy aria-hidden="true" />파일 위치 복사</button>{location && location.source !== 'local-connector' && <button type="button" className="button button--secondary" aria-haspopup="dialog" onClick={show}>{location.source === 'user-provided' ? '경로 수정' : '전체 경로 설정'}</button>}</>}{afterCopy}</div>
    <p role="status" className="field__help">{copied}</p>
    {file && <Modal open={open} title="파일 위치 설정" focusKey={photo.id + '-location'} initialFocus={input} onClose={() => setOpen(false)} className="file-location-dialog"><form onSubmit={event => { void save(event) }}>
      <p className="field__help">브라우저가 전체 경로를 제공하지 않아, 폴더 위치를 직접 지정해요.</p>
      <div className="field"><label htmlFor={id + '-path'}>{folderName ? `선택한 폴더(${folderName})의 전체 경로` : '사진이 있는 폴더의 전체 경로'}</label><input id={id + '-path'} ref={input} type="text" autoComplete="off" spellCheck={false} value={basePath} placeholder={folderName ? `예: C:\\Pictures\\${folderName}` : '예: C:\\Users\\사용자\\Pictures'} onChange={event => { setBasePath(event.target.value); setError('') }} aria-describedby={id + '-note'} /></div>
      <p id={id + '-note'} className="field__help">탐색기 주소 표시줄에서 복사해 주세요. 파일명과 하위 폴더는 자동으로 붙여요. 이 탭에서만 보관해요.</p>
      {preview && <output className="file-location-preview" aria-label="복사할 파일 위치">{preview}</output>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="button-row"><button type="button" className="button button--secondary" onClick={() => setOpen(false)}>취소</button><button type="submit" className="button button--primary">저장하고 복사</button>{location?.source === 'user-provided' && <button type="button" className="button button--secondary" onClick={clear}>직접 입력한 경로 지우기</button>}</div>
    </form></Modal>}
  </>
}

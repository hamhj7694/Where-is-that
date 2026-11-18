import { useEffect, useRef, useState } from 'react'
import type { FileLocationAssignment } from './file-location-model'

export interface GalleryImportResult { added: number; duplicateCount: number; error?: string }
export interface GalleryImportOptions { basePath?: string; nativeLocations?: readonly FileLocationAssignment[] }
export type GalleryImportHandler = (files: readonly File[], signal: AbortSignal, options?: GalleryImportOptions) => Promise<GalleryImportResult>

export default function useGalleryImport(handler: GalleryImportHandler) {
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => () => { request.current?.abort() }, [])

  function cancel() {
    request.current?.abort()
    request.current = null
    setBusy(false); setError(''); setNotice('')
  }

  async function run(files: readonly File[], options?: GalleryImportOptions) {
    if (!files.length) return false
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await handler(files, controller.signal, options)
      if (controller.signal.aborted) return false
      if (result.error) setError(result.error)
      else if (result.added > 0) return true
      else if (result.duplicateCount > 0) setNotice('이미 연결한 이미지예요. 다른 사진이나 폴더를 골라 주세요.')
      else setError('선택한 항목에서 이미지를 찾지 못했어요. 다른 사진이나 폴더를 골라 주세요.')
      return false
    } catch {
      if (!controller.signal.aborted) setError('이미지를 확인하지 못했어요. 다시 선택해 주세요.')
      return false
    } finally {
      if (request.current === controller) {
        request.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }

  return { busy, error, notice, run, cancel }
}

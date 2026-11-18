import { useEffect, useRef, useState } from 'react'
import { getLocalGalleryStatus, localGalleryAllowed, LocalGalleryUnavailableError, pickLocalGallery, type LocalGalleryKind, type LocalGallerySelection } from './local-gallery-client'

export default function useLocalGalleryPicker() {
  const [available, setAvailable] = useState(false)
  const [checking, setChecking] = useState(localGalleryAllowed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const checkingRequest = useRef<AbortController | null>(null)
  const request = useRef<AbortController | null>(null)

  async function refresh() {
    checkingRequest.current?.abort()
    const controller = new AbortController()
    checkingRequest.current = controller
    if (mounted.current) setChecking(localGalleryAllowed())
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const capability = await getLocalGalleryStatus(controller.signal)
        if (controller.signal.aborted || !mounted.current) return
        if (capability || !localGalleryAllowed() || attempt === 2) {
          setAvailable(!!capability?.supported)
          return
        }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, 500)
          controller.signal.addEventListener('abort', finish, { once: true })
        })
        controller.signal.throwIfAborted()
      }
    } catch { /* Aborted capability checks must not change current availability. */ }
    finally {
      if (checkingRequest.current === controller) {
        checkingRequest.current = null
        if (mounted.current) setChecking(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false; checkingRequest.current?.abort(); request.current?.abort() }
    // Preserve the three mount probes and abort them during StrictMode cleanup.
  }, [])

  useEffect(() => {
    const retryWhenVisible = () => {
      if (mounted.current && !available && !request.current && !checkingRequest.current
        && document.visibilityState === 'visible' && localGalleryAllowed()) void refresh()
    }
    window.addEventListener('focus', retryWhenVisible)
    document.addEventListener('visibilitychange', retryWhenVisible)
    return () => {
      window.removeEventListener('focus', retryWhenVisible)
      document.removeEventListener('visibilitychange', retryWhenVisible)
    }
  }, [available])

  function cancel() {
    request.current?.abort()
    request.current = null
    setBusy(false); setError(''); setNotice('')
  }

  async function select(kind: LocalGalleryKind): Promise<LocalGallerySelection | null> {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setNotice('사진 선택 창을 열고 있어요.')
    try {
      const selection = await pickLocalGallery(kind, controller.signal, ({ completed, total }) => {
        if (mounted.current && request.current === controller && !controller.signal.aborted) setNotice(`사진을 읽고 있어요. ${completed}/${total}장`)
      })
      if (!mounted.current || request.current !== controller || controller.signal.aborted) return null
      setAvailable(true)
      setNotice(selection ? selection.files.length.toLocaleString('ko-KR') + '장의 사진을 읽었어요.' : '')
      return selection
    } catch (problem) {
      if (mounted.current && request.current === controller && !controller.signal.aborted) {
        if (problem instanceof LocalGalleryUnavailableError) setAvailable(false)
        setError(problem instanceof Error ? problem.message : '로컬 사진을 읽지 못했어요. 다시 선택해 주세요.')
        setNotice('')
      }
      return null
    } finally {
      if (mounted.current && request.current === controller) { request.current = null; setBusy(false) }
    }
  }

  return { available, checking, busy, error, notice, select, cancel, refresh }
}

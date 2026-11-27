import { useEffect, useRef, useState } from 'react'
import { loadGuestHistory, saveGuestHistory } from './guest-history-store'
import type { SearchRecord } from './history'

export default function useGuestHistory(enabled: boolean) {
  const [records, setRecords] = useState<SearchRecord[]>([])
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState(false)
  const saved = useRef<SearchRecord[]>([])
  const writes = useRef(Promise.resolve())

  useEffect(() => {
    if (!enabled) return
    let active = true
    void loadGuestHistory().then(restored => {
      if (!active) return
      saved.current = restored
      setRecords(current => {
        if (!current.length) return restored
        const ids = new Set(current.map(record => record.id))
        return [...current, ...restored.filter(record => !ids.has(record.id))]
      })
    }).catch(() => { if (active) setStorageError(true) }).finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !ready || records === saved.current) return
    writes.current = writes.current.then(async () => {
      // Each transaction receives only the changed records. Searches added in another tab are retained.
      try {
        await saveGuestHistory(saved.current, records)
        saved.current = records
        setStorageError(false)
      } catch {
        setStorageError(true)
      }
    })
  }, [enabled, ready, records])

  return { records, setRecords, ready, storageError }
}

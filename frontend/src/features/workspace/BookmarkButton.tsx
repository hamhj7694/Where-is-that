import { useState } from 'react'
import { Bookmark } from 'lucide-react'
import { useBrowserScope } from '../auth/browser-scope'
import { createThumbnail, toggleBookmark, useBookmark, type NewBookmark } from './bookmarks'

export default function BookmarkButton({ entry }: { entry: NewBookmark }) {
  const scope = useBrowserScope()
  const saved = useBookmark(scope, entry.id)
  const [busy, setBusy] = useState(false)
  return <button type="button" className={'icon-button bookmark-button' + (saved ? ' is-active' : '')}
    aria-label="북마크" aria-pressed={saved} disabled={!scope || busy} title={saved ? '북마크 해제' : '북마크'}
    onClick={async () => {
      if (!scope || busy) return
      setBusy(true)
      try {
        const image = entry.image?.startsWith('blob:') ? await createThumbnail(entry.image) : entry.image
        toggleBookmark(scope, { ...entry, image })
      } finally {
        setBusy(false)
      }
    }}>
    <Bookmark aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
  </button>
}

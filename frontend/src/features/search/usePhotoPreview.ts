import { useEffect, useState } from 'react'

export function usePhotoPreview(file: File | null) {
  const [value, setValue] = useState<{ file: File; url: string } | null>(null)
  useEffect(() => {
    if (!file) return
    const url = URL.createObjectURL(file)
    setValue({ file, url })
    return () => URL.revokeObjectURL(url)
  }, [file])
  return value && value.file === file ? value.url : null
}

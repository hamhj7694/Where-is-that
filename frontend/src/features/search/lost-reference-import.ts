import { assertImageReadable, MAX_LOST_REFERENCE_PHOTOS } from './model'

interface LostReferenceImportOptions {
  replace?: boolean
  signal?: AbortSignal
  read?: (file: File) => Promise<void>
}

/** Validate the complete selection before callers commit any photo changes. */
export async function prepareLostReferenceFiles(
  files: readonly File[],
  currentCount: number,
  options: LostReferenceImportOptions = {},
): Promise<File[]> {
  const { replace = false, signal, read = assertImageReadable } = options
  signal?.throwIfAborted()
  const selected = [...files]
  if (replace && selected.length > 1) throw new Error('사진을 바꿀 때는 한 장만 선택해 주세요.')
  if (!replace && currentCount + selected.length > MAX_LOST_REFERENCE_PHOTOS) {
    throw new Error(`참고 사진은 최대 ${MAX_LOST_REFERENCE_PHOTOS}장까지 추가할 수 있어요.`)
  }

  const prepared: File[] = []
  for (const file of selected) {
    signal?.throwIfAborted()
    await read(file)
    signal?.throwIfAborted()
    prepared.push(file)
  }
  signal?.throwIfAborted()
  return prepared
}

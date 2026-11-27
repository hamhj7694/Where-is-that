import { isImageFile } from './model'

export interface GallerySelection {
  files: File[]
  imageCount: number
  duplicateCount: number
}

const fingerprints = new WeakMap<File, Promise<string>>()
// Serialize reads across selections too: an aborted caller cannot cancel a
// Blob read that has already started, but the next read must wait for it.
let fingerprintQueue: Promise<void> = Promise.resolve()

function fingerprint(file: File): Promise<string> {
  const cached = fingerprints.get(file)
  if (cached) return cached

  const pending = fingerprintQueue.then(async () => {
    const bytes = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  })
  fingerprints.set(file, pending)
  fingerprintQueue = pending.then(() => undefined, () => undefined)
  // Failed reads must remain retryable; do not retain a rejected cache entry.
  void pending.catch(() => {
    if (fingerprints.get(file) === pending) fingerprints.delete(file)
  })
  return pending
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** An exact byte match is independent of a photo's filename and folder. */
export async function findIdenticalGalleryFiles(
  reference: File,
  files: readonly File[],
  signal?: AbortSignal,
): Promise<File[]> {
  signal?.throwIfAborted()
  if (!reference.size) return []
  const sameSize = files.filter(file => file.size === reference.size)
  if (!sameSize.length) return []

  const referenceHash = await abortable(fingerprint(reference), signal)
  const matches: File[] = []
  for (const file of sameSize) {
    signal?.throwIfAborted()
    try {
      if (await abortable(fingerprint(file), signal) === referenceHash) matches.push(file)
    } catch {
      // An unreadable photo shouldn't prevent checking the others.
      signal?.throwIfAborted()
    }
  }
  return matches
}

interface SizeGroup {
  files: Set<File>
  unread: File[]
  readCount: number
  hashes: Set<string>
}

/** Return only new images; callers commit after the complete operation succeeds. */
export async function prepareGallerySelection(
  existing: readonly File[],
  selected: readonly File[],
  signal?: AbortSignal,
): Promise<GallerySelection> {
  signal?.throwIfAborted()
  const images = selected.filter(isImageFile)
  const groups = new Map<number, SizeGroup>()
  for (const file of existing) {
    if (!isImageFile(file)) continue
    const group = groups.get(file.size)
    if (group) { group.files.add(file); group.unread.push(file) }
    else groups.set(file.size, { files: new Set([file]), unread: [file], readCount: 0, hashes: new Set() })
  }

  const files: File[] = []
  let duplicateCount = 0
  for (const file of images) {
    signal?.throwIfAborted()
    const group = groups.get(file.size)
    if (!group) {
      // Distinct byte lengths cannot be duplicates; defer reading until a
      // second candidate of this size actually requires a comparison.
      groups.set(file.size, { files: new Set([file]), unread: [file], readCount: 0, hashes: new Set() })
      files.push(file)
      continue
    }
    if (group.files.has(file)) { duplicateCount++; continue }

    const hash = await abortable(fingerprint(file), signal)
    signal?.throwIfAborted()
    let duplicate = group.hashes.has(hash)
    while (!duplicate && group.readCount < group.unread.length) {
      signal?.throwIfAborted()
      const candidateHash = await abortable(fingerprint(group.unread[group.readCount]), signal)
      signal?.throwIfAborted()
      group.readCount++
      group.hashes.add(candidateHash)
      duplicate = candidateHash === hash
    }
    if (duplicate) duplicateCount++
    else {
      group.files.add(file)
      group.hashes.add(hash)
      files.push(file)
    }
  }
  signal?.throwIfAborted()
  return { files, imageCount: images.length, duplicateCount }
}

export interface FileLocationAssignment { file: File; path: string }
export interface FileLocation { path: string; source: 'browser-relative' | 'user-provided' | 'local-connector' }

const locations = new WeakMap<File, string>()
const nativeLocations = new WeakMap<File, string>()
const invalidPath = 'Windows의 전체 폴더 경로를 입력해 주세요. 예: C:\\사진\\여행'
const invalidName = '폴더나 파일 이름에 사용할 수 없는 문자가 있어요. 경로를 확인해 주세요.'

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.codePointAt(0)!
    return code < 32 || code >= 127 && code <= 159
  })
}

function checkSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..' || hasControlCharacters(segment)
    || /[<>:"|?*\\/]/.test(segment) || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw new Error(invalidName)
  if (segment.toLowerCase() === 'fakepath') throw new Error('브라우저의 fakepath는 실제 위치가 아니에요. 실제 폴더 경로를 입력해 주세요.')
}

function trimOuterQuotes(value: string): string {
  const trimmed = value.trim()
  return trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1) : trimmed
}

function absolutePath(value: string): { path: string; last: string | null } {
  // Check before trimming, so pasted tabs/newlines never silently alter a path.
  if (hasControlCharacters(value)) throw new Error(invalidPath)
  const input = trimOuterQuotes(value).replaceAll('/', '\\')
  if (/^[a-z]:\\/i.test(input)) {
    const segments = input.slice(3).split(/\\+/).filter(Boolean)
    segments.forEach(checkSegment)
    return { path: input.slice(0, 2) + '\\' + segments.join('\\'), last: segments.at(-1) ?? null }
  }
  if (input.startsWith('\\\\')) {
    const segments = input.slice(2).split(/\\+/).filter(Boolean)
    if (segments.length < 2) throw new Error(invalidPath)
    segments.forEach(checkSegment)
    return { path: '\\\\' + segments.join('\\'), last: segments.at(-1)! }
  }
  throw new Error(invalidPath)
}

function relativeSegments(file: File): string[] | null {
  checkSegment(file.name)
  const relative = file.webkitRelativePath
  if (!relative) return null
  if (hasControlCharacters(relative) || relative.startsWith('/') || relative.startsWith('\\')) throw new Error(invalidName)
  const segments = relative.split(/[\\/]/)
  if (segments.length < 2) throw new Error('선택한 폴더의 상대 경로를 확인할 수 없어요. 폴더를 다시 연결해 주세요.')
  segments.forEach(checkSegment)
  if (segments.at(-1)!.toLowerCase() !== file.name.toLowerCase()) throw new Error('사진 이름과 폴더 경로가 맞지 않아요. 폴더를 다시 연결해 주세요.')
  return segments
}

function appendPath(base: string, segments: readonly string[]): string {
  return base + (base.endsWith('\\') ? '' : '\\') + segments.join('\\')
}

/** Pure preparation: no session location changes until the caller commits. */
export function prepareFileLocations(files: readonly File[], basePath: string): FileLocationAssignment[] {
  const base = absolutePath(basePath)
  return files.map(file => {
    const relative = relativeSegments(file)
    if (relative && (!base.last || relative[0].toLowerCase() !== base.last.toLowerCase())) {
      throw new Error(`선택한 폴더 이름 ‘${relative[0]}’과 입력한 경로의 마지막 폴더 이름이 같아야 해요.`)
    }
    return { file, path: appendPath(base.path, relative ? relative.slice(1) : [file.name]) }
  })
}

/** Store only after all assignments validate; never persist outside this session. */
function validatedLocations(assignments: readonly FileLocationAssignment[]): FileLocationAssignment[] {
  return assignments.map(({ file, path }) => {
    checkSegment(file.name)
    const absolute = absolutePath(path)
    if (absolute.last?.toLowerCase() !== file.name.toLowerCase()) throw new Error('파일 이름과 입력한 위치가 맞지 않아요.')
    return { file, path: absolute.path }
  })
}

export function rememberFileLocations(assignments: readonly FileLocationAssignment[]): void {
  validatedLocations(assignments).forEach(({ file, path }) => locations.set(file, path))
}

/** Only the local native picker supplies these paths; do not infer them from names. */
export function rememberNativeFileLocations(assignments: readonly FileLocationAssignment[]): void {
  validatedLocations(assignments).forEach(({ file, path }) => nativeLocations.set(file, path))
}

export function getFileLocation(file: File): FileLocation | null {
  const native = nativeLocations.get(file)
  if (native) return { path: native, source: 'local-connector' }
  const remembered = locations.get(file)
  if (remembered) return { path: remembered, source: 'user-provided' }
  try {
    const relative = relativeSegments(file)
    return relative ? { path: relative.join('/'), source: 'browser-relative' } : null
  } catch { return null }
}

export function clearFileLocations(files: readonly File[]): void {
  files.forEach(file => locations.delete(file))
}

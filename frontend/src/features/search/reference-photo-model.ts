// File identity survives route changes in the current tab's drafts/history.
// Weak keys release the original when its cropped reference is no longer retained.
const referenceOriginals = new WeakMap<File, File>()

export function originalReferencePhoto(photo: File | null): File | null {
  return photo ? referenceOriginals.get(photo) ?? photo : null
}

export function rememberReferenceCrop(photo: File, source: File) {
  const original = originalReferencePhoto(source)!
  if (photo !== original) referenceOriginals.set(photo, original)
}

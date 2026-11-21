/** Small shared predicates. Kept separate so the layers below never import each other. */

export function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function nonEmptyString (value) {
  return typeof value === 'string' && value.trim() !== ''
}

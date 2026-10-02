/**
 * Deterministic JSON serialisation (object keys sorted recursively, no
 * whitespace), in the spirit of RFC 8785. Used wherever bytes are hashed or
 * signed — raw evidence objects, normalised payloads, integrity manifests —
 * so that the same logical value always produces the same digest.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, new Set())
}

function serialise(value: unknown, seen: Set<object>): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers cannot be canonicalised")
      return JSON.stringify(value)
    case "object":
      break
    default:
      throw new TypeError(`Unsupported type for canonical JSON: ${typeof value}`)
  }
  const object = value as object
  if (seen.has(object)) throw new TypeError("Cyclic structures cannot be canonicalised")
  seen.add(object)
  try {
    if (object instanceof Date) return JSON.stringify(object.toISOString())
    if (Array.isArray(object)) {
      return `[${object.map((item) => (item === undefined ? "null" : serialise(item, seen))).join(",")}]`
    }
    const entries = Object.entries(object)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${serialise(inner, seen)}`)
    return `{${entries.join(",")}}`
  } finally {
    seen.delete(object)
  }
}

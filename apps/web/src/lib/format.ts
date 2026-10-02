/** Technical timestamps are always UTC, monospaced (§78). */
export function formatUtc(
  value: string | Date | null | undefined,
  options: { seconds?: boolean } = {},
): string {
  if (!value) return "—"
  const date = typeof value === "string" ? new Date(value) : value
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, options.seconds === false ? 16 : 19)} UTC`
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  return new Date(value).toISOString().slice(11, 19)
}

export function shortHash(hash: string, length = 12): string {
  return `${hash.slice(0, length)}…`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

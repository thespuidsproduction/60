/**
 * Structured JSON logger (dev bible §92, §132).
 *
 * Logs identifiers and correlation IDs, never secrets or evidence payloads.
 * Any field whose key looks sensitive is redacted before serialisation as a
 * last line of defence; callers should still not pass such values.
 */
export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFields = Record<string, unknown>

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|private[_-]?key|api[_-]?key|credential|payload|totp|backup[_-]?code/i

export const REDACTED = "[REDACTED]"

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]"
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1)
    }
    return out
  }
  return value
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  base?: LogFields
  write?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = levelOrder[options.level ?? "info"]
  const base = options.base ?? {}
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"))

  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    if (levelOrder[level] < threshold) return
    const record = redact({ ...base, ...fields }) as LogFields
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...record }))
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  }
}

import type { Severity, TrustLevel } from "@platform/db"

/**
 * Evidence Explorer query language (dev bible §19).
 *
 *   identity:alice source:fixture type:privilege_change between:02:00..04:00 on:2026-10-02
 *
 * `key:value` filters combine with AND; repeating a key ORs its values.
 * Bare words search the event description. Quote values containing spaces.
 */
export const integrityStates = ["verified", "failed", "sealed", "unsealed"] as const
export type IntegrityState = (typeof integrityStates)[number]

export interface EvidenceQuery {
  source: string[]
  type: string[]
  identity: string[]
  asset: string[]
  reference: string[]
  severity: Severity[]
  trust: TrustLevel[]
  integrity: IntegrityState[]
  between: { from: Date; to: Date } | null
  text: string[]
}

export interface ParsedQuery {
  query: EvidenceQuery
  errors: string[]
}

/** Filters from §19 that depend on later modules; recognised with a clear message. */
const laterFilters: Record<string, string> = {
  customer: "Customer filtering becomes available with customer mapping.",
  incident: "Incident filtering becomes available with Incident Command.",
  control: "Control filtering becomes available with Assurance controls.",
  framework: "Framework filtering becomes available with framework mapping.",
}

const severities = new Set(["info", "low", "medium", "high", "critical"])
const trustLevels = new Set(["A", "B", "C", "D", "E"])
const TOKEN = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}(:\d{2})?$/

function parseInstant(value: string, day: string, edge: "start" | "end"): Date | null {
  if (DATE.test(value)) {
    return new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`)
  }
  if (TIME.test(value)) {
    const time = value.length === 5 ? `${value}:00` : value
    return new Date(`${day}T${time}${edge === "end" && value.length === 5 ? ".999" : ".000"}Z`)
  }
  const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function emptyQuery(): EvidenceQuery {
  return {
    source: [],
    type: [],
    identity: [],
    asset: [],
    reference: [],
    severity: [],
    trust: [],
    integrity: [],
    between: null,
    text: [],
  }
}

export function parseEvidenceQuery(input: string, options: { today?: Date } = {}): ParsedQuery {
  const query = emptyQuery()
  const errors: string[] = []
  let between: string | null = null
  let on: string | null = null

  for (const match of input.slice(0, 2000).matchAll(TOKEN)) {
    const key = (match[1] ?? match[3])?.toLowerCase()
    const value = (match[2] ?? match[4] ?? match[5] ?? match[6] ?? "").trim()
    if (!key) {
      if (value) query.text.push(value)
      continue
    }
    if (!value) {
      errors.push(`"${key}:" needs a value.`)
      continue
    }
    switch (key) {
      case "source":
      case "type":
      case "identity":
      case "asset":
        query[key].push(value)
        break
      case "ref":
      case "reference":
      case "evidence":
        if (/^EV-\d{1,}$/i.test(value)) query.reference.push(value.toUpperCase())
        else errors.push(`"${value}" is not an evidence reference (EV-000123).`)
        break
      case "severity":
        if (severities.has(value.toLowerCase()))
          query.severity.push(value.toLowerCase() as Severity)
        else errors.push(`Unknown severity "${value}".`)
        break
      case "trust":
        if (trustLevels.has(value.toUpperCase()))
          query.trust.push(value.toUpperCase() as TrustLevel)
        else errors.push(`Trust level must be A–E.`)
        break
      case "integrity":
        if ((integrityStates as readonly string[]).includes(value.toLowerCase())) {
          query.integrity.push(value.toLowerCase() as IntegrityState)
        } else errors.push(`Integrity must be one of ${integrityStates.join(", ")}.`)
        break
      case "between":
        between = value
        break
      case "on":
        if (DATE.test(value)) on = value
        else errors.push(`"on:" expects a date (YYYY-MM-DD).`)
        break
      default:
        errors.push(laterFilters[key] ?? `Unknown filter "${key}:".`)
    }
  }

  if (between) {
    const [fromRaw, toRaw] = between.split("..")
    const day = on ?? (options.today ?? new Date()).toISOString().slice(0, 10)
    const from = fromRaw ? parseInstant(fromRaw, day, "start") : null
    const to = toRaw ? parseInstant(toRaw, day, "end") : null
    if (!from || !to) errors.push(`"between:" expects start..end (times, dates or ISO timestamps).`)
    else if (from > to) errors.push(`"between:" start is after its end.`)
    else query.between = { from, to }
  } else if (on) {
    query.between = { from: new Date(`${on}T00:00:00.000Z`), to: new Date(`${on}T23:59:59.999Z`) }
  }

  return { query, errors }
}

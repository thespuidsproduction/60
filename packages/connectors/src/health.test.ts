import { describe, expect, it } from "vitest"
import { deriveConnectorStatus } from "./health"

const now = new Date("2026-10-02T12:00:00Z")
const base = {
  current: "healthy" as const,
  consecutiveFailures: 0,
  lastSuccessAt: now,
  expectedFreshnessMs: 3_600_000,
  now,
}

describe("deriveConnectorStatus", () => {
  it("is healthy after a fresh successful sync", () => {
    expect(deriveConnectorStatus(base)).toBe("healthy")
  })
  it("degrades on any failure, partial run, or stale evidence", () => {
    expect(deriveConnectorStatus({ ...base, consecutiveFailures: 1 })).toBe("degraded")
    expect(deriveConnectorStatus({ ...base, lastRunPartial: true })).toBe("degraded")
    expect(
      deriveConnectorStatus({ ...base, lastSuccessAt: new Date(now.getTime() - 3 * 3_600_000) }),
    ).toBe("degraded")
  })
  it("fails on credential failure or repeated failures; stays disconnected", () => {
    expect(deriveConnectorStatus({ ...base, credentialFailure: true })).toBe("failed")
    expect(deriveConnectorStatus({ ...base, consecutiveFailures: 3 })).toBe("failed")
    expect(
      deriveConnectorStatus({ ...base, current: "disconnected", consecutiveFailures: 5 }),
    ).toBe("disconnected")
  })
  it("is pending before the first success", () => {
    expect(deriveConnectorStatus({ ...base, lastSuccessAt: null })).toBe("pending")
  })
})

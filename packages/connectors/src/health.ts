import type { ConnectorStatus } from "@platform/db"

export const FAILED_AFTER_CONSECUTIVE_FAILURES = 3

/**
 * Connector health (dev bible §60, §111). Silent collection failure is itself a
 * serious failure, so any failed or partial run degrades health, and stale
 * evidence (no successful sync within twice the expected cadence) does too.
 */
export function deriveConnectorStatus(input: {
  current: ConnectorStatus
  consecutiveFailures: number
  lastSuccessAt: Date | null
  expectedFreshnessMs: number
  lastRunPartial?: boolean
  credentialFailure?: boolean
  now: Date
}): ConnectorStatus {
  if (input.current === "disconnected") return "disconnected"
  if (input.credentialFailure) return "failed"
  if (input.consecutiveFailures >= FAILED_AFTER_CONSECUTIVE_FAILURES) return "failed"
  if (input.consecutiveFailures > 0 || input.lastRunPartial) return "degraded"
  if (!input.lastSuccessAt) return "pending"
  if (input.now.getTime() - input.lastSuccessAt.getTime() > input.expectedFreshnessMs * 2)
    return "degraded"
  return "healthy"
}

export const isUnhealthy = (status: ConnectorStatus) => status === "degraded" || status === "failed"

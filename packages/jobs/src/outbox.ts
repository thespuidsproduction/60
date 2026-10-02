import { randomUUID } from "node:crypto"
import type { Tx } from "@platform/db"

/** Domain events (dev bible §70). Extend as modules are built. */
export const domainEventTypes = [
  "EvidenceCaptured",
  "EvidenceNormalised",
  "EvidenceIntegrityVerified",
  "ControlEvidenceChanged",
  "ControlBecameStale",
  "IncidentCreated",
  "IncidentConfirmed",
  "IncidentAwarenessDetermined",
  "ReportingDeadlineCreated",
  "ReportingDeadlineApproaching",
  "ReportGenerated",
  "ReportApproved",
  "ConnectorDegraded",
  "ConnectorRecovered",
] as const

export type DomainEventType = (typeof domainEventTypes)[number]

export interface DomainEvent {
  type: DomainEventType
  tenantId: string | null
  aggregate: { type: string; id: string }
  payload?: Record<string, unknown>
  correlationId?: string
}

/**
 * Writes a domain event in the same transaction as the state change (§106).
 * The ID is generated here because tenant-scoped code may write, but not read,
 * the outbox (so the insert cannot use RETURNING under row-level security).
 */
export async function emitEvent(trx: Tx, event: DomainEvent): Promise<string> {
  const id = randomUUID()
  await trx
    .insertInto("outbox_events")
    .values({
      id,
      tenant_id: event.tenantId,
      event_type: event.type,
      aggregate_type: event.aggregate.type,
      aggregate_id: event.aggregate.id,
      payload: JSON.stringify(event.payload ?? {}),
      correlation_id: event.correlationId ?? randomUUID(),
    })
    .execute()
  return id
}

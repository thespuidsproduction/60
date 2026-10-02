import type { ActorType, Tx } from "@platform/db"

/**
 * Application audit log writer (dev bible §67).
 *
 * Audit entries record who did what, to what, when, from where, in which
 * session, the old and new state, and why. They are separate from imported
 * cyber evidence and the table is append-only at the database level.
 *
 * Write audit entries in the same transaction as the change they describe so
 * that a change can never commit without its audit record.
 */
export interface AuditActor {
  type: ActorType
  id?: string | null
  label: string
}

export interface AuditRequestContext {
  sessionId?: string | null
  ip?: string | null
  userAgent?: string | null
  correlationId?: string | null
}

export interface AuditEvent {
  tenantId: string | null
  actor: AuditActor
  action: string
  target?: { type: string; id: string }
  oldState?: unknown
  newState?: unknown
  reason?: string | null
  request?: AuditRequestContext
}

const ACTION = /^[a-z_]+(\.[a-z_]+)+$/

export async function recordAudit(trx: Tx, event: AuditEvent): Promise<string> {
  if (!ACTION.test(event.action)) throw new Error(`Invalid audit action "${event.action}"`)
  const row = await trx
    .insertInto("audit_entries")
    .values({
      tenant_id: event.tenantId,
      actor_type: event.actor.type,
      actor_id: event.actor.id ?? null,
      actor_label: event.actor.label,
      action: event.action,
      target_type: event.target?.type ?? null,
      target_id: event.target?.id ?? null,
      session_id: event.request?.sessionId ?? null,
      ip: event.request?.ip ?? null,
      user_agent: event.request?.userAgent?.slice(0, 512) ?? null,
      old_state: event.oldState === undefined ? null : JSON.stringify(event.oldState),
      new_state: event.newState === undefined ? null : JSON.stringify(event.newState),
      reason: event.reason ?? null,
      correlation_id: event.request?.correlationId ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id
}

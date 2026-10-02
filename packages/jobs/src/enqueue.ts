import { randomUUID } from "node:crypto"
import type { QueueName, Tx } from "@platform/db"

export interface EnqueueInput {
  queue: QueueName
  type: string
  tenantId: string | null
  /** Identifiers only — never secrets or evidence payloads (§132). */
  payload: Record<string, unknown>
  /** Deduplicates retries of the same logical request (§71). Defaults to a random key. */
  idempotencyKey?: string
  correlationId?: string
  maxAttempts?: number
  runAfter?: Date
}

/**
 * Records a job in PostgreSQL inside the caller's transaction (D-003). The job
 * only becomes visible to the dispatcher if the business change commits, and
 * it is never lost if Redis is.
 */
export async function enqueueJob(
  trx: Tx,
  input: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  const idempotencyKey = input.idempotencyKey ?? randomUUID()
  const inserted = await trx
    .insertInto("job_records")
    .values({
      tenant_id: input.tenantId,
      queue: input.queue,
      job_type: input.type,
      idempotency_key: idempotencyKey,
      correlation_id: input.correlationId ?? randomUUID(),
      payload: JSON.stringify(input.payload),
      ...(input.maxAttempts ? { max_attempts: input.maxAttempts } : {}),
      ...(input.runAfter ? { run_after: input.runAfter } : {}),
    })
    .onConflict((oc) => oc.columns(["queue", "idempotency_key"]).doNothing())
    .returning("id")
    .executeTakeFirst()
  if (inserted) return { id: inserted.id, created: true }
  const existing = await trx
    .selectFrom("job_records")
    .select("id")
    .where("queue", "=", input.queue)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirstOrThrow()
  return { id: existing.id, created: false }
}

import { sql, type Transaction } from "kysely"
import type { Db } from "./client"
import type { Database } from "./schema"

export type Tx = Transaction<Database>

export interface TenantContext {
  tenantId: string
  userId?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: string, label: string) {
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`)
}

/**
 * Runs `fn` in a transaction scoped to one tenant. Row-level security restricts
 * every statement to rows of that tenant (dev bible §63). The setting is
 * transaction-local, so it cannot leak to other pooled connections.
 */
export async function withTenant<T>(
  db: Db,
  context: TenantContext,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(context.tenantId, "tenantId")
  if (context.userId) assertUuid(context.userId, "userId")
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${context.tenantId}, true),
                     set_config('app.user_id', ${context.userId ?? ""}, true)`.execute(trx)
    return fn(trx)
  })
}

/**
 * Runs `fn` in a transaction with cross-tenant ("system") visibility.
 *
 * Only for server code with no single tenant: authentication before a tenant
 * is selected, worker orchestration, and the internal Control Plane. Callers
 * must have authorised the operation already; `purpose` is recorded in
 * `application_name` for database-side diagnostics.
 */
export async function withSystem<T>(
  db: Db,
  purpose: string,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  if (!/^[a-z0-9_.:-]{1,48}$/i.test(purpose)) throw new Error("invalid system purpose label")
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.scope', 'system', true),
                     set_config('application_name', ${"system:" + purpose}, true)`.execute(trx)
    return fn(trx)
  })
}

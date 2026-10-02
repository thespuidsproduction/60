import { recordAudit, type AuditActor, type AuditRequestContext } from "@platform/audit"
import type { Tx } from "@platform/db"
import type { SecretBox } from "@platform/shared"

/**
 * Connector credentials (dev bible §59). Secrets are encrypted with the data
 * key ring and bound to their connector via associated data; `connectors`
 * stores only `credential_ref`. Must run in system scope (the table is
 * invisible to tenant-scoped code).
 */
const aad = (connectorId: string) => `connector:${connectorId}`

export async function storeConnectorCredentials(
  trx: Tx,
  box: SecretBox,
  input: {
    tenantId: string
    connectorId: string
    credentials: unknown
    actor: AuditActor
    reason: string
    request?: AuditRequestContext
  },
): Promise<string> {
  const now = new Date()
  const revoked = await trx
    .updateTable("connector_credentials")
    .set({ revoked_at: now })
    .where("connector_id", "=", input.connectorId)
    .where("revoked_at", "is", null)
    .returning("id")
    .execute()
  const secretEnc = box.encrypt(JSON.stringify(input.credentials), aad(input.connectorId))
  const row = await trx
    .insertInto("connector_credentials")
    .values({
      tenant_id: input.tenantId,
      connector_id: input.connectorId,
      secret_enc: secretEnc,
      key_id: box.keyIdOf(secretEnc),
      created_by: input.actor.label,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  await trx
    .updateTable("connectors")
    .set({ credential_ref: row.id })
    .where("id", "=", input.connectorId)
    .execute()
  await recordAudit(trx, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: revoked.length ? "integration.credentials_rotated" : "integration.credentials_stored",
    target: { type: "connector", id: input.connectorId },
    // References only — never secret material.
    oldState: revoked.length ? { credentialRef: revoked.map((r) => r.id) } : undefined,
    newState: { credentialRef: row.id, keyId: box.keyIdOf(secretEnc) },
    reason: input.reason,
    ...(input.request ? { request: input.request } : {}),
  })
  return row.id
}

export async function loadConnectorCredentials(
  trx: Tx,
  box: SecretBox,
  connector: { id: string; credential_ref: string | null },
): Promise<unknown | null> {
  if (!connector.credential_ref) return null
  const row = await trx
    .selectFrom("connector_credentials")
    .select(["secret_enc", "revoked_at"])
    .where("id", "=", connector.credential_ref)
    .where("connector_id", "=", connector.id)
    .executeTakeFirst()
  if (!row || row.revoked_at) return null
  return JSON.parse(box.decrypt(row.secret_enc, aad(connector.id)))
}

export async function revokeConnectorCredentials(trx: Tx, connectorId: string): Promise<void> {
  await trx
    .updateTable("connector_credentials")
    .set({ revoked_at: new Date() })
    .where("connector_id", "=", connectorId)
    .where("revoked_at", "is", null)
    .execute()
  await trx
    .updateTable("connectors")
    .set({ credential_ref: null })
    .where("id", "=", connectorId)
    .execute()
}

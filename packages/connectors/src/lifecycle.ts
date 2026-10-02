import { recordAudit, type AuditActor, type AuditRequestContext } from "@platform/audit"
import { withSystem, type Db } from "@platform/db"
import { enqueueJob } from "@platform/jobs"
import type { Logger, SecretBox } from "@platform/shared"
import { revokeConnectorCredentials, storeConnectorCredentials } from "./credentials"
import { createHttpClient, type ConnectorHttpClient } from "./http"
import type { ConnectorRegistry } from "./registry"
import { buildConnectorContext } from "./sync"
import type { EvidenceSink } from "./sink"

export class ConnectorSetupError extends Error {
  constructor(
    message: string,
    readonly missingPermissions: string[] = [],
  ) {
    super(message)
    this.name = "ConnectorSetupError"
  }
}

export interface LifecycleDependencies {
  db: Db
  secretBox: SecretBox
  registry: ConnectorRegistry
  log: Logger
  httpClient?: (log: Logger) => ConnectorHttpClient
}

/**
 * Connects a new integration. The caller must already have authorised
 * `integration:manage` with step-up and checked the connector's feature state.
 *
 * Credentials and least-privilege permissions are verified against the source
 * before anything is stored; a baseline sync is enqueued in the same transaction.
 */
export async function connectIntegration(
  deps: LifecycleDependencies,
  input: {
    tenantId: string
    type: string
    displayName: string
    config: unknown
    credentials: unknown
    actor: AuditActor & { id?: string | null }
    request?: AuditRequestContext
  },
): Promise<{ connectorId: string; sourceTenant: string; baselineJobId: string }> {
  const adapter = deps.registry.get(input.type)
  const config = adapter.configSchema.safeParse(input.config)
  if (!config.success) throw new ConnectorSetupError("Connector configuration is invalid.")
  const credentials = adapter.credentialsSchema.safeParse(input.credentials)
  if (!credentials.success) throw new ConnectorSetupError("Connector credentials are incomplete.")

  const log = deps.log.child({ connectorType: adapter.type, tenantId: input.tenantId })
  const probe = {
    connectorId: "pending",
    tenantId: input.tenantId,
    sourceTenant: null,
    config: config.data,
    credentials: credentials.data,
    http: (deps.httpClient ?? ((l: Logger) => createHttpClient({ log: l })))(log),
    log,
    now: () => new Date(),
  }
  const { sourceTenant } = await adapter.connect(probe)
  const permissions = await adapter.validatePermissions({ ...probe, sourceTenant })
  if (permissions.missing.length) {
    throw new ConnectorSetupError("Required read permissions are missing.", permissions.missing)
  }
  const discovered = await adapter.discoverCapabilities({ ...probe, sourceTenant })

  return withSystem(deps.db, "connectors.connect", async (trx) => {
    const connector = await trx
      .insertInto("connectors")
      .values({
        tenant_id: input.tenantId,
        connector_type: adapter.type,
        display_name: input.displayName,
        source_tenant: sourceTenant,
        capabilities: discovered,
        granted_permissions: permissions.granted,
        connector_version: adapter.version,
        config: JSON.stringify(config.data),
        created_by: input.actor.type === "user" ? (input.actor.id ?? null) : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
    await storeConnectorCredentials(trx, deps.secretBox, {
      tenantId: input.tenantId,
      connectorId: connector.id,
      credentials: credentials.data,
      actor: input.actor,
      reason: "initial connection",
      ...(input.request ? { request: input.request } : {}),
    })
    await recordAudit(trx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: "integration.connected",
      target: { type: "connector", id: connector.id },
      newState: {
        type: adapter.type,
        version: adapter.version,
        sourceTenant,
        capabilities: discovered,
        grantedPermissions: permissions.granted,
      },
      ...(input.request ? { request: input.request } : {}),
    })
    const job = await enqueueJob(trx, {
      queue: "connector-sync",
      type: "connector.sync",
      tenantId: input.tenantId,
      payload: { connectorId: connector.id, mode: "baseline" },
      idempotencyKey: `sync:${connector.id}:baseline`,
    })
    return { connectorId: connector.id, sourceTenant, baselineJobId: job.id }
  })
}

/** Disconnects: revokes stored credentials, releases upstream grants best-effort, keeps history. */
export async function disconnectIntegration(
  deps: LifecycleDependencies,
  input: {
    tenantId: string
    connectorId: string
    actor: AuditActor
    reason: string
    request?: AuditRequestContext
  },
) {
  await withSystem(deps.db, "connectors.disconnect", async (trx) => {
    const connector = await trx
      .selectFrom("connectors")
      .selectAll()
      .where("id", "=", input.connectorId)
      .where("tenant_id", "=", input.tenantId)
      .forUpdate()
      .executeTakeFirst()
    if (!connector || connector.status === "disconnected") return
    const adapter = deps.registry.get(connector.connector_type)
    try {
      const ctx = await buildConnectorContext(
        { ...deps, sink: noSink },
        trx,
        connector,
        adapter,
        deps.log,
      )
      await adapter.revoke(ctx)
    } catch (error) {
      deps.log.warn("upstream revoke failed; credentials revoked locally", {
        connectorId: connector.id,
        error: (error as Error).name,
      })
    }
    await revokeConnectorCredentials(trx, connector.id)
    await trx
      .updateTable("connectors")
      .set({ status: "disconnected", disconnected_at: new Date() })
      .where("id", "=", connector.id)
      .execute()
    await recordAudit(trx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: "integration.disconnected",
      target: { type: "connector", id: connector.id },
      oldState: { status: connector.status },
      newState: { status: "disconnected" },
      reason: input.reason,
      ...(input.request ? { request: input.request } : {}),
    })
  })
}

const noSink: EvidenceSink = {
  capture: async () => "duplicate",
  quarantine: async () => {},
}

/**
 * Enqueues incremental syncs for connectors whose last sync is older than
 * `intervalMs`. Idempotent per connector and time bucket, so overlapping
 * schedulers cannot double-enqueue.
 */
export async function enqueueDueSyncs(
  db: Db,
  options: { intervalMs: number; now?: Date },
): Promise<number> {
  const now = options.now ?? new Date()
  const bucket = Math.floor(now.getTime() / options.intervalMs)
  const cutoff = new Date(now.getTime() - options.intervalMs)
  return withSystem(db, "connectors.schedule", async (trx) => {
    const due = await trx
      .selectFrom("connectors")
      .select(["id", "tenant_id"])
      .where("status", "not in", ["disconnected", "pending"])
      .where((eb) => eb.or([eb("last_sync_at", "is", null), eb("last_sync_at", "<", cutoff)]))
      .execute()
    let created = 0
    for (const connector of due) {
      const result = await enqueueJob(trx, {
        queue: "connector-sync",
        type: "connector.sync",
        tenantId: connector.tenant_id,
        payload: { connectorId: connector.id, mode: "incremental" },
        idempotencyKey: `sync:${connector.id}:incremental:${bucket}`,
      })
      if (result.created) created++
    }
    return created
  })
}

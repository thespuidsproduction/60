import { recordAudit } from "@platform/audit"
import {
  withSystem,
  type Connector,
  type ConnectorStatus,
  type Db,
  type SyncMode,
  type Tx,
} from "@platform/db"
import { emitEvent, PermanentJobError } from "@platform/jobs"
import type { Logger, SecretBox } from "@platform/shared"
import { loadConnectorCredentials } from "./credentials"
import { ConnectorError, CredentialError, PermissionDeniedError } from "./errors"
import { deriveConnectorStatus, isUnhealthy } from "./health"
import { createHttpClient, type ConnectorHttpClient } from "./http"
import type { ConnectorRegistry } from "./registry"
import type { EvidenceSink } from "./sink"
import { sourceEnvelopeSchema, type AnyConnectorAdapter, type ConnectorContext } from "./types"

export interface SyncDependencies {
  db: Db
  secretBox: SecretBox
  registry: ConnectorRegistry
  sink: EvidenceSink
  log: Logger
  now?: () => Date
  httpClient?: (log: Logger) => ConnectorHttpClient
}

export interface SyncSummary {
  syncRunId: string | null
  status: "succeeded" | "partial" | "failed" | "skipped"
  captured: number
  duplicates: number
  failures: number
}

const MAX_SUMMARY = 1000

/** Builds the adapter context for a connector (system scope; decrypts credentials). */
export async function buildConnectorContext(
  deps: SyncDependencies,
  trx: Tx,
  connector: Connector,
  adapter: AnyConnectorAdapter,
  log: Logger,
): Promise<ConnectorContext<unknown, unknown>> {
  const credentials = await loadConnectorCredentials(trx, deps.secretBox, connector)
  if (credentials == null) throw new PermanentJobError("Connector has no active credentials")
  const config = adapter.configSchema.safeParse(connector.config)
  if (!config.success) throw new PermanentJobError("Connector configuration is invalid")
  const creds = adapter.credentialsSchema.safeParse(credentials)
  if (!creds.success)
    throw new PermanentJobError("Stored credentials do not match the connector schema")
  return {
    connectorId: connector.id,
    tenantId: connector.tenant_id,
    sourceTenant: connector.source_tenant,
    config: config.data,
    credentials: creds.data,
    http: (deps.httpClient ?? ((l) => createHttpClient({ log: l })))(log),
    log,
    now: deps.now ?? (() => new Date()),
  }
}

/**
 * Runs one baseline or incremental sync (dev bible §58, §60, §111).
 *
 * Every attempt is recorded in connector_sync_runs. Cursors advance per batch
 * only after the sink has accepted every envelope in that batch, so a crash or
 * outage never skips evidence. Any failure degrades connector health and emits
 * ConnectorDegraded; recovery emits ConnectorRecovered.
 */
export async function runConnectorSync(
  deps: SyncDependencies,
  input: { connectorId: string; mode: SyncMode; jobId?: string; attempt?: number },
): Promise<SyncSummary> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log.child({ connectorId: input.connectorId, mode: input.mode })

  const prepared = await withSystem(deps.db, "connectors.sync_start", async (trx) => {
    const connector = await trx
      .selectFrom("connectors")
      .selectAll()
      .where("id", "=", input.connectorId)
      .executeTakeFirst()
    if (!connector) throw new PermanentJobError("Connector not found")
    if (connector.status === "disconnected") return null
    const adapter = deps.registry.get(connector.connector_type)
    const ctx = await buildConnectorContext(deps, trx, connector, adapter, log)
    const cursorRows = await trx
      .selectFrom("connector_cursors")
      .select(["stream", "cursor"])
      .where("connector_id", "=", connector.id)
      .execute()
    const cursors = new Map(cursorRows.map((row) => [row.stream, row.cursor]))
    const run = await trx
      .insertInto("connector_sync_runs")
      .values({
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        job_id: input.jobId ?? null,
        mode: input.mode,
        started_at: now(),
        source_api: adapter.source,
        cursor_before: JSON.stringify(Object.fromEntries(cursors)),
        attempt: input.attempt ?? 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
    return { connector, adapter, ctx, cursors, runId: run.id }
  })
  if (!prepared)
    return { syncRunId: null, status: "skipped", captured: 0, duplicates: 0, failures: 0 }

  const { connector, adapter, ctx, cursors, runId } = prepared
  const captureContext = {
    tenantId: connector.tenant_id,
    connectorId: connector.id,
    syncRunId: runId,
  }
  const counters = { captured: 0, duplicates: 0, failures: 0 }
  const failureReasons: string[] = []

  try {
    const batches =
      input.mode === "baseline" ? adapter.syncBaseline(ctx) : adapter.syncIncremental(ctx, cursors)
    for await (const batch of batches) {
      for (const raw of batch.envelopes) {
        const parsed = sourceEnvelopeSchema.safeParse(raw)
        if (!parsed.success || parsed.data.source !== adapter.source) {
          const reason = parsed.success ? "envelope source mismatch" : "invalid source envelope"
          await deps.sink.quarantine(raw, reason, captureContext)
          counters.failures++
          if (!failureReasons.includes(reason)) failureReasons.push(reason)
          continue
        }
        const outcome = await deps.sink.capture(parsed.data, captureContext)
        if (outcome === "captured") counters.captured++
        else counters.duplicates++
      }
      cursors.set(batch.stream, batch.cursor)
      await withSystem(deps.db, "connectors.sync_progress", async (trx) => {
        await trx
          .insertInto("connector_cursors")
          .values({
            connector_id: connector.id,
            stream: batch.stream,
            tenant_id: connector.tenant_id,
            cursor: JSON.stringify(batch.cursor),
          })
          .onConflict((oc) =>
            oc.columns(["connector_id", "stream"]).doUpdateSet({
              cursor: JSON.stringify(batch.cursor),
              updated_at: now(),
            }),
          )
          .execute()
        await trx
          .updateTable("connector_sync_runs")
          .set({
            objects_captured: counters.captured,
            duplicates: counters.duplicates,
            failures: counters.failures,
            cursor_after: JSON.stringify(Object.fromEntries(cursors)),
          })
          .where("id", "=", runId)
          .execute()
      })
    }
  } catch (error) {
    const credentialFailure =
      error instanceof CredentialError || error instanceof PermissionDeniedError
    const summary = describe(error)
    await finishRun(deps, connector, adapter, runId, {
      status: counters.captured + counters.duplicates > 0 ? "partial" : "failed",
      counters,
      cursors,
      errorSummary: summary,
      responseState: error instanceof ConnectorError ? error.name : "UnexpectedError",
      failed: true,
      credentialFailure,
    })
    log.warn("connector sync failed", { error: summary, ...counters })
    if (error instanceof ConnectorError && !error.retryable) throw new PermanentJobError(summary)
    throw error
  }

  const status = counters.failures > 0 ? "partial" : "succeeded"
  await finishRun(deps, connector, adapter, runId, {
    status,
    counters,
    cursors,
    errorSummary: failureReasons.length
      ? `${counters.failures} object(s) quarantined: ${failureReasons.join("; ")}`
      : null,
    responseState: "ok",
    failed: false,
    credentialFailure: false,
  })
  log.info("connector sync finished", { status, ...counters })
  return { syncRunId: runId, status, ...counters }
}

function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
    0,
    MAX_SUMMARY,
  )
}

async function finishRun(
  deps: SyncDependencies,
  connector: Connector,
  adapter: AnyConnectorAdapter,
  runId: string,
  outcome: {
    status: "succeeded" | "partial" | "failed"
    counters: { captured: number; duplicates: number; failures: number }
    cursors: Map<string, unknown>
    errorSummary: string | null
    responseState: string
    failed: boolean
    credentialFailure: boolean
  },
) {
  const at = (deps.now ?? (() => new Date()))()
  await withSystem(deps.db, "connectors.sync_finish", async (trx) => {
    await trx
      .updateTable("connector_sync_runs")
      .set({
        status: outcome.status,
        finished_at: at,
        objects_captured: outcome.counters.captured,
        duplicates: outcome.counters.duplicates,
        failures: outcome.counters.failures,
        cursor_after: JSON.stringify(Object.fromEntries(outcome.cursors)),
        response_state: outcome.responseState,
        error_summary: outcome.errorSummary,
      })
      .where("id", "=", runId)
      .execute()

    // Re-read under lock: concurrent syncs must not lose failure counts.
    const current = await trx
      .selectFrom("connectors")
      .select(["status", "consecutive_failures", "last_success_at"])
      .where("id", "=", connector.id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    const consecutiveFailures = outcome.failed ? current.consecutive_failures + 1 : 0
    const lastSuccessAt = outcome.failed ? current.last_success_at : at
    const next: ConnectorStatus = deriveConnectorStatus({
      current: current.status,
      consecutiveFailures,
      lastSuccessAt,
      expectedFreshnessMs: adapter.expectedFreshnessMs,
      lastRunPartial: outcome.status === "partial",
      credentialFailure: outcome.credentialFailure,
      now: at,
    })
    await trx
      .updateTable("connectors")
      .set({
        status: next,
        consecutive_failures: consecutiveFailures,
        last_sync_at: at,
        last_success_at: lastSuccessAt,
        ...(outcome.errorSummary ? { last_error: outcome.errorSummary, last_error_at: at } : {}),
      })
      .where("id", "=", connector.id)
      .execute()

    if (next !== current.status && (isUnhealthy(next) || isUnhealthy(current.status))) {
      const degraded = isUnhealthy(next)
      await emitEvent(trx, {
        type: degraded ? "ConnectorDegraded" : "ConnectorRecovered",
        tenantId: connector.tenant_id,
        aggregate: { type: "connector", id: connector.id },
        payload: { connectorId: connector.id, from: current.status, to: next },
      })
      await recordAudit(trx, {
        tenantId: connector.tenant_id,
        actor: { type: "connector", id: connector.id, label: connector.display_name },
        action: "integration.health_changed",
        target: { type: "connector", id: connector.id },
        oldState: { status: current.status },
        newState: { status: next },
        reason: outcome.errorSummary,
      })
    }
  })
}

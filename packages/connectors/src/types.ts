import { z } from "zod"
import type { Logger } from "@platform/shared"
import type { ConnectorHttpClient } from "./http"

/** Read-only capabilities a connector can declare (dev bible §58, §1.2). */
export const capabilities = [
  "IDENTITIES_READ",
  "SECURITY_ALERTS_READ",
  "ASSETS_READ",
  "CONFIG_READ",
  "INCIDENTS_READ",
  "AUDIT_READ",
  "CUSTOMERS_READ",
  "TICKETS_READ",
] as const
export type Capability = (typeof capabilities)[number]

/**
 * Source envelope (dev bible §38): what every connector produces. The payload is
 * the untouched upstream object; it is preserved before any normalisation.
 * `objectType` and `sourceApi` extend §38 for provenance (§111).
 */
export const sourceEnvelopeSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  sourceTenant: z.string().min(1).max(256),
  sourceObjectId: z.string().min(1).max(512),
  sourceEventId: z.string().min(1).max(512).nullable(),
  objectType: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,63}$/),
  sourceApi: z.string().min(1).max(512),
  capturedAt: z.iso.datetime({ offset: true }),
  sourceTimestamp: z.iso.datetime({ offset: true }).nullable(),
  payload: z.unknown().refine((value) => value !== undefined, "payload is required"),
})
export type SourceEnvelope = z.infer<typeof sourceEnvelopeSchema>

/** One page of results for one stream; `cursor` is the position after this batch. */
export interface SyncBatch {
  stream: string
  envelopes: unknown[]
  cursor: unknown
}

export interface PermissionCheck {
  granted: string[]
  missing: string[]
}

export interface HealthCheckResult {
  ok: boolean
  latencyMs: number
  detail?: string
}

export interface ConnectorContext<Config, Credentials> {
  connectorId: string
  tenantId: string
  sourceTenant: string | null
  config: Config
  credentials: Credentials
  http: ConnectorHttpClient
  log: Logger
  now: () => Date
  signal?: AbortSignal
}

/**
 * Common logical contract for every connector (dev bible §58). Connectors are
 * read-only witnesses: no method may change state in the customer's system.
 */
export interface ConnectorAdapter<Config = unknown, Credentials = unknown> {
  type: string
  source: string
  displayName: string
  version: string
  declaredCapabilities: readonly Capability[]
  /** Least-privilege upstream scopes/permissions required (§66). */
  requiredPermissions: readonly string[]
  /** Expected evidence cadence; staleness beyond this degrades health (§18, §60). */
  expectedFreshnessMs: number
  configSchema: z.ZodType<Config>
  credentialsSchema: z.ZodType<Credentials>

  /** Validates credentials and identifies the upstream tenant. */
  connect(ctx: ConnectorContext<Config, Credentials>): Promise<{ sourceTenant: string }>
  validatePermissions(ctx: ConnectorContext<Config, Credentials>): Promise<PermissionCheck>
  discoverCapabilities(ctx: ConnectorContext<Config, Credentials>): Promise<Capability[]>
  syncBaseline(ctx: ConnectorContext<Config, Credentials>): AsyncIterable<SyncBatch>
  syncIncremental(
    ctx: ConnectorContext<Config, Credentials>,
    cursors: ReadonlyMap<string, unknown>,
  ): AsyncIterable<SyncBatch>
  fetchObject(
    ctx: ConnectorContext<Config, Credentials>,
    objectType: string,
    id: string,
  ): Promise<unknown | null>
  fetchEvidence(
    ctx: ConnectorContext<Config, Credentials>,
    query: Record<string, string>,
  ): AsyncIterable<unknown>
  healthCheck(ctx: ConnectorContext<Config, Credentials>): Promise<HealthCheckResult>
  /** Releases upstream grants where the source supports it (on disconnect). */
  revoke(ctx: ConnectorContext<Config, Credentials>): Promise<void>
}

// Erased form for registries holding heterogeneous adapters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyConnectorAdapter = ConnectorAdapter<any, any>

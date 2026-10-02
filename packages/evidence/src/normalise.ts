import { z } from "zod"
import { withSystem, type Db, type Severity, type Tx } from "@platform/db"
import type { SourceEnvelope } from "@platform/connectors"
import { defineJob, emitEvent, enqueueJob, PermanentJobError } from "@platform/jobs"
import { canonicalJson, type Logger } from "@platform/shared"
import { readRawEvidence } from "./capture"
import { ObjectIntegrityError, sha256Hex, type ObjectStore } from "./object-store"

/**
 * Normalisation (dev bible §38–39, §72, §112).
 *
 *   raw evidence ──(transformer name@version)──► canonical EvidenceEvent (schema vN)
 *
 * Transformers are pure functions of the source envelope. Their identity and
 * version are recorded on every output; a new version adds new rows and never
 * reinterprets history in place.
 */
export const normalisedEventSchema = z.object({
  eventType: z.string().regex(/^[a-z][a-z0-9_.]*$/),
  category: z.string().min(1).max(64),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  description: z.string().min(1).max(500),
  subjectType: z.string().max(64).nullable().default(null),
  subjectId: z.string().max(512).nullable().default(null),
  assetType: z.string().max(64).nullable().default(null),
  assetId: z.string().max(512).nullable().default(null),
  occurredAt: z.iso.datetime({ offset: true }).nullable().default(null),
  payload: z.record(z.string(), z.unknown()),
})
export type NormalisedEvent = z.input<typeof normalisedEventSchema>

export interface Transformer {
  name: string
  /** Semantic version; recorded on every event it produces. */
  version: string
  source: string
  objectTypes: readonly string[]
  /** e.g. `identity.authentication.v2` (§72). */
  schemaVersion: string
  /** Returns null for objects that are preserved but carry no event semantics. */
  transform(envelope: SourceEnvelope): NormalisedEvent | null
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface TransformerRegistry {
  /** Latest version for (source, objectType), or a specific version. */
  resolve(source: string, objectType: string, version?: string): Transformer | undefined
  list(): Transformer[]
}

export function createTransformerRegistry(transformers: Transformer[]): TransformerRegistry {
  const seen = new Set<string>()
  for (const t of transformers) {
    const id = `${t.name}@${t.version}`
    if (seen.has(id)) throw new Error(`Duplicate transformer ${id}`)
    if (!/^\d+\.\d+\.\d+$/.test(t.version))
      throw new Error(`Transformer ${t.name} version must be semver`)
    seen.add(id)
  }
  return {
    resolve(source, objectType, version) {
      const candidates = transformers
        .filter((t) => t.source === source && t.objectTypes.includes(objectType))
        .filter((t) => !version || t.version === version)
        .sort((a, b) => compareVersions(b.version, a.version))
      return candidates[0]
    },
    list: () => [...transformers],
  }
}

export interface NormaliseDependencies {
  db: Db
  store: ObjectStore
  transformers: TransformerRegistry
  log: Logger
}

export type NormaliseOutcome =
  | { status: "normalised"; eventId: string }
  | { status: "already_normalised" }
  | { status: "no_transformer" }
  | { status: "no_event" }

async function recordIntegrityFailure(
  trx: Tx,
  row: { id: string; tenant_id: string },
  detail: string,
) {
  await trx
    .insertInto("evidence_verifications")
    .values({
      tenant_id: row.tenant_id,
      raw_object_id: row.id,
      manifest_id: null,
      result: "failed",
      checks: JSON.stringify([{ check: "RAW_HASH", status: "failed", detail }]),
      verified_by: "system:normaliser",
    })
    .execute()
}

export async function normaliseEvidence(
  deps: NormaliseDependencies,
  input: { evidenceId: string; transformerVersion?: string },
): Promise<NormaliseOutcome> {
  const row = await withSystem(deps.db, "evidence.normalise_load", (trx) =>
    trx
      .selectFrom("raw_evidence_objects")
      .selectAll()
      .where("id", "=", input.evidenceId)
      .executeTakeFirst(),
  )
  if (!row) throw new PermanentJobError("Evidence object not found")

  const transformer = deps.transformers.resolve(
    row.source,
    row.object_type,
    input.transformerVersion,
  )
  if (!transformer) return { status: "no_transformer" }

  let envelope: SourceEnvelope
  try {
    ;({ envelope } = await readRawEvidence(deps.store, row))
  } catch (error) {
    if (error instanceof ObjectIntegrityError) {
      await withSystem(deps.db, "evidence.integrity_failure", (trx) =>
        recordIntegrityFailure(trx, row, error.message),
      )
      deps.log.error("raw evidence failed integrity check", { evidenceId: row.id })
      throw new PermanentJobError(error.message)
    }
    throw error
  }

  const produced = transformer.transform(envelope)
  if (!produced) return { status: "no_event" }
  const event = normalisedEventSchema.parse(produced)
  const normalisedPayload = canonicalJson(event.payload)

  return withSystem(deps.db, "evidence.normalise", async (trx) => {
    const inserted = await trx
      .insertInto("evidence_events")
      .values({
        tenant_id: row.tenant_id,
        raw_object_id: row.id,
        event_type: event.eventType,
        category: event.category,
        severity: event.severity as Severity,
        description: event.description,
        source_type: row.source,
        source_id: row.connector_id,
        source_event_id: row.source_event_id,
        subject_type: event.subjectType,
        subject_id: event.subjectId,
        asset_type: event.assetType,
        asset_id: event.assetId,
        occurred_at: event.occurredAt ? new Date(event.occurredAt) : row.occurred_at,
        observed_at: row.observed_at,
        ingested_at: row.ingested_at,
        time_confidence: event.occurredAt || row.occurred_at ? "source" : "observed",
        raw_sha256: row.raw_sha256,
        normalized_payload: normalisedPayload,
        normalized_sha256: sha256Hex(normalisedPayload),
        schema_version: transformer.schemaVersion,
        transformer: transformer.name,
        transformer_version: transformer.version,
        trust_level: row.trust_level,
      })
      .onConflict((oc) =>
        oc.columns(["raw_object_id", "transformer", "transformer_version"]).doNothing(),
      )
      .returning("id")
      .executeTakeFirst()
    if (!inserted) return { status: "already_normalised" as const }
    await emitEvent(trx, {
      type: "EvidenceNormalised",
      tenantId: row.tenant_id,
      aggregate: { type: "evidence", id: row.id },
      payload: {
        evidenceId: row.id,
        eventId: inserted.id,
        schemaVersion: transformer.schemaVersion,
      },
    })
    return { status: "normalised" as const, eventId: inserted.id }
  })
}

export const normalisePayload = z.object({
  evidenceId: z.string().uuid(),
  transformerVersion: z.string().optional(),
})

/** `evidence.normalise` job; subscribe it to EvidenceCaptured. */
export function createNormaliseJob(deps: Omit<NormaliseDependencies, "db" | "log">) {
  return defineJob({
    type: "evidence.normalise",
    queue: "evidence-process",
    payload: normalisePayload,
    maxAttempts: 5,
    async run({ payload, db, log }) {
      const outcome = await normaliseEvidence({ ...deps, db, log }, payload)
      log.debug("normalisation finished", {
        evidenceId: payload.evidenceId,
        status: outcome.status,
      })
    },
  })
}

/**
 * Reprocessing (§112): re-normalises existing raw evidence with a specific
 * transformer version. Earlier outputs remain; idempotent per object+version.
 */
export async function enqueueReprocessing(
  db: Db,
  input: { tenantId: string; source: string; objectType: string; transformer: Transformer },
): Promise<number> {
  return withSystem(db, "evidence.reprocess", async (trx) => {
    const rows = await trx
      .selectFrom("raw_evidence_objects")
      .select("id")
      .where("tenant_id", "=", input.tenantId)
      .where("source", "=", input.source)
      .where("object_type", "=", input.objectType)
      .execute()
    let created = 0
    for (const row of rows) {
      const result = await enqueueJob(trx, {
        queue: "evidence-process",
        type: "evidence.normalise",
        tenantId: input.tenantId,
        payload: { evidenceId: row.id, transformerVersion: input.transformer.version },
        idempotencyKey: `normalise:${row.id}:${input.transformer.name}@${input.transformer.version}`,
      })
      if (result.created) created++
    }
    return created
  })
}

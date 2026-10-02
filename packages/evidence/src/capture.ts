import { randomUUID } from "node:crypto"
import { sql, withSystem, type Db, type RawEvidenceObject, type TrustLevel } from "@platform/db"
import type { CaptureContext, EvidenceSink, SourceEnvelope } from "@platform/connectors"
import { sourceEnvelopeSchema } from "@platform/connectors"
import { emitEvent } from "@platform/jobs"
import { canonicalJson, type Logger } from "@platform/shared"
import { ObjectIntegrityError, sha256Hex, type ObjectStore } from "./object-store"
import { quarantineKey, rawEvidenceKey } from "./storage-keys"

export const RAW_MEDIA_TYPE = "application/vnd.platform.source-envelope+json"

/** `EV-000042` — per-tenant, gap-tolerant human reference. */
export const formatEvidenceReference = (n: number | string) => `EV-${String(n).padStart(6, "0")}`

/**
 * Deduplication key (§71): source + source tenant + source event ID, or — for
 * snapshot objects without an event ID — object ID plus payload hash, so a
 * changed object is captured as a new version while a re-read is not.
 */
export function dedupKey(envelope: SourceEnvelope): string {
  const identity = envelope.sourceEventId
    ? `e:${envelope.sourceEventId}`
    : `o:${envelope.sourceObjectId}:${sha256Hex(canonicalJson(envelope.payload))}`
  return sha256Hex(`${envelope.source}\n${envelope.sourceTenant}\n${identity}`)
}

export interface CaptureOptions {
  db: Db
  store: ObjectStore
  log: Logger
  now?: () => Date
  /** Trust level of objects captured through connectors (§40: direct API capture). */
  trustLevel?: TrustLevel
}

/**
 * Raw evidence capture (dev bible §1.3, §38, §110):
 *
 *   SourceEnvelope → canonical bytes → SHA-256 → write-once object storage
 *   → provenance row (raw_evidence_objects) + EvidenceCaptured (outbox)
 *
 * The object is stored before the row is written, so a row never points at
 * missing bytes. The row and its outbox event commit together.
 */
export function createEvidenceCapture(options: CaptureOptions): EvidenceSink {
  const { db, store } = options
  const now = options.now ?? (() => new Date())
  const trustLevel = options.trustLevel ?? "A"

  return {
    async capture(envelope, context) {
      const key = dedupKey(envelope)
      return withSystem(db, "evidence.capture", async (trx) => {
        const existing = await trx
          .selectFrom("raw_evidence_objects")
          .select("id")
          .where("tenant_id", "=", context.tenantId)
          .where("dedup_key", "=", key)
          .executeTakeFirst()
        if (existing) return "duplicate" as const

        const bytes = Buffer.from(canonicalJson(envelope), "utf8")
        const digest = sha256Hex(bytes)
        const id = randomUUID()
        const observedAt = new Date(envelope.capturedAt)
        const objectKey = rawEvidenceKey({
          tenantId: context.tenantId,
          source: envelope.source,
          evidenceId: id,
          capturedAt: observedAt,
        })
        await store.putImmutable(objectKey, bytes, { contentType: RAW_MEDIA_TYPE, sha256: digest })

        const { rows } = await sql<{
          n: string
        }>`select app_next_reference(${context.tenantId}, 'evidence') as n`.execute(trx)
        const inserted = await trx
          .insertInto("raw_evidence_objects")
          .values({
            id,
            tenant_id: context.tenantId,
            reference: formatEvidenceReference(rows[0]!.n),
            source: envelope.source,
            connector_id: context.connectorId,
            sync_run_id: context.syncRunId,
            source_tenant: envelope.sourceTenant,
            source_object_id: envelope.sourceObjectId,
            source_event_id: envelope.sourceEventId,
            object_type: envelope.objectType,
            source_api: envelope.sourceApi,
            media_type: RAW_MEDIA_TYPE,
            occurred_at: envelope.sourceTimestamp ? new Date(envelope.sourceTimestamp) : null,
            observed_at: observedAt,
            ingested_at: now(),
            raw_sha256: digest,
            size_bytes: bytes.length,
            storage_object_key: objectKey,
            trust_level: trustLevel,
            dedup_key: key,
          })
          .onConflict((oc) => oc.columns(["tenant_id", "dedup_key"]).doNothing())
          .returning("id")
          .executeTakeFirst()
        // Lost a race with a concurrent capture of the same object: the other row wins.
        if (!inserted) return "duplicate" as const

        await emitEvent(trx, {
          type: "EvidenceCaptured",
          tenantId: context.tenantId,
          aggregate: { type: "evidence", id },
          payload: { evidenceId: id, source: envelope.source, objectType: envelope.objectType },
        })
        return "captured" as const
      })
    },

    async quarantine(raw, reason, context: CaptureContext) {
      const at = now()
      const id = randomUUID()
      let serialised: string
      try {
        serialised = canonicalJson({ reason, receivedAt: at.toISOString(), raw })
      } catch {
        serialised = canonicalJson({
          reason,
          receivedAt: at.toISOString(),
          unserialisable: String(raw),
        })
      }
      const bytes = Buffer.from(serialised, "utf8")
      const digest = sha256Hex(bytes)
      const objectKey = quarantineKey(context.tenantId, id, at)
      await store.putImmutable(objectKey, bytes, {
        contentType: "application/json",
        sha256: digest,
      })
      await withSystem(db, "evidence.quarantine", (trx) =>
        trx
          .insertInto("evidence_quarantine")
          .values({
            id,
            tenant_id: context.tenantId,
            connector_id: context.connectorId,
            sync_run_id: context.syncRunId,
            reason,
            raw_sha256: digest,
            size_bytes: bytes.length,
            storage_object_key: objectKey,
            captured_at: at,
          })
          .execute(),
      )
      options.log.warn("evidence object quarantined", {
        quarantineId: id,
        connectorId: context.connectorId,
        reason,
      })
    },
  }
}

/**
 * Reads a raw object back and proves it is byte-identical to what was captured
 * before parsing it. Throws ObjectIntegrityError on any mismatch.
 */
export async function readRawEvidence(
  store: ObjectStore,
  row: Pick<RawEvidenceObject, "storage_object_key" | "raw_sha256">,
): Promise<{ bytes: Buffer; envelope: SourceEnvelope }> {
  const bytes = await store.get(row.storage_object_key)
  if (sha256Hex(bytes) !== row.raw_sha256) {
    throw new ObjectIntegrityError(
      `Stored object ${row.storage_object_key} does not match its recorded SHA-256`,
    )
  }
  const envelope = sourceEnvelopeSchema.parse(JSON.parse(bytes.toString("utf8")))
  return { bytes, envelope }
}

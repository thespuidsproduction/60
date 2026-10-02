import { randomUUID } from "node:crypto"
import { z } from "zod"
import { sql, withSystem, type Db } from "@platform/db"
import { manifestKey, manifestSignatureKey, sha256Hex, type ObjectStore } from "@platform/evidence"
import { defineJob, enqueueJob } from "@platform/jobs"
import type { Logger } from "@platform/shared"
import {
  computeMerkleRoot,
  manifestHash,
  serialiseManifest,
  type ManifestDocument,
} from "./manifest"
import { LEAF_ENCODING, MERKLE_ALGORITHM } from "./merkle"
import type { ManifestSigner } from "./signing"

export interface SealDependencies {
  db: Db
  store: ObjectStore
  signer: ManifestSigner
  log: Logger
  now?: () => Date
  /** Objects younger than this are left for the next run (late arrivals in the same hour). */
  graceMs?: number
  maxItemsPerRun?: number
}

const HOUR = 60 * 60 * 1000

/**
 * Seals unmanifested evidence for one tenant into signed manifests, one per
 * (source, ingestion hour) partition, appended to the tenant's hash chain
 * (dev bible §41). Serialised per tenant with an advisory lock so the chain
 * never forks. Manifest bytes and signature are written to object storage
 * before the rows commit.
 */
export async function sealPendingEvidence(
  deps: SealDependencies,
  input: { tenantId: string },
): Promise<{ manifestIds: string[]; items: number }> {
  const now = (deps.now ?? (() => new Date()))()
  const cutoff = new Date(now.getTime() - (deps.graceMs ?? 60_000))
  const limit = deps.maxItemsPerRun ?? 10_000

  return withSystem(deps.db, "integrity.seal", async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${"manifest-chain:" + input.tenantId}))`.execute(
      trx,
    )

    const pending = await trx
      .selectFrom("raw_evidence_objects as r")
      .leftJoin("integrity_manifest_items as i", "i.raw_object_id", "r.id")
      .select(["r.id", "r.reference", "r.raw_sha256", "r.source", "r.ingested_at"])
      .where("r.tenant_id", "=", input.tenantId)
      .where("i.raw_object_id", "is", null)
      .where("r.ingested_at", "<=", cutoff)
      .orderBy("r.ingested_at")
      .orderBy("r.id")
      .limit(limit)
      .execute()
    if (!pending.length) return { manifestIds: [], items: 0 }

    const groups = new Map<string, typeof pending>()
    for (const row of pending) {
      const hour = Math.floor(row.ingested_at.getTime() / HOUR)
      const key = `${hour}|${row.source}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }

    let previous = await trx
      .selectFrom("integrity_manifests")
      .select(["id", "sequence", "manifest_sha256"])
      .where("tenant_id", "=", input.tenantId)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst()

    const manifestIds: string[] = []
    const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [key, rows] of ordered) {
      const hour = Number(key.split("|")[0])
      const id = randomUUID()
      const sequence = previous ? Number(previous.sequence) + 1 : 1
      const items = rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        hash: row.raw_sha256,
      }))
      const document: ManifestDocument = {
        manifestVersion: 1,
        manifestId: id,
        tenantId: input.tenantId,
        sequence,
        source: rows[0]!.source,
        periodStart: new Date(hour * HOUR).toISOString(),
        periodEnd: new Date((hour + 1) * HOUR).toISOString(),
        merkleAlgorithm: MERKLE_ALGORITHM,
        leafEncoding: LEAF_ENCODING,
        items,
        merkleRoot: computeMerkleRoot(items),
        previousManifestId: previous?.id ?? null,
        previousManifestHash: previous?.manifest_sha256 ?? null,
        createdAt: now.toISOString(),
        signingKeyId: deps.signer.keyId,
      }
      const bytes = serialiseManifest(document)
      const digest = manifestHash(bytes)
      const signature = deps.signer.sign(bytes)
      const signatureBytes = Buffer.from(signature, "utf8")
      const objectKey = manifestKey(input.tenantId, id)
      await deps.store.putImmutable(objectKey, bytes, {
        contentType: "application/json",
        sha256: digest,
      })
      await deps.store.putImmutable(manifestSignatureKey(input.tenantId, id), signatureBytes, {
        contentType: "text/plain",
        sha256: sha256Hex(signatureBytes),
      })

      await trx
        .insertInto("integrity_manifests")
        .values({
          id,
          tenant_id: input.tenantId,
          sequence,
          manifest_version: 1,
          source: document.source,
          period_start: document.periodStart,
          period_end: document.periodEnd,
          item_count: items.length,
          merkle_root: document.merkleRoot,
          previous_manifest_id: document.previousManifestId,
          previous_manifest_hash: document.previousManifestHash,
          manifest_sha256: digest,
          signature,
          signing_key_id: deps.signer.keyId,
          storage_object_key: objectKey,
          created_at: now,
        })
        .execute()
      await trx
        .insertInto("integrity_manifest_items")
        .values(
          rows.map((row, index) => ({
            manifest_id: id,
            leaf_index: index,
            raw_object_id: row.id,
            tenant_id: input.tenantId,
            raw_sha256: row.raw_sha256,
          })),
        )
        .execute()
      previous = { id, sequence: String(sequence), manifest_sha256: digest }
      manifestIds.push(id)
    }
    deps.log.info("evidence sealed", {
      tenantId: input.tenantId,
      manifests: manifestIds.length,
      items: pending.length,
    })
    return { manifestIds, items: pending.length }
  })
}

export const sealPayload = z.object({ tenantId: z.string().uuid() })

/** `integrity.seal` job (queue: integrity). */
export function createSealJob(deps: Omit<SealDependencies, "db" | "log">) {
  return defineJob({
    type: "integrity.seal",
    queue: "integrity",
    payload: sealPayload,
    maxAttempts: 5,
    async run({ payload, db, log }) {
      await sealPendingEvidence({ ...deps, db, log }, payload)
    },
  })
}

/** Enqueues a seal job for every tenant with unmanifested evidence (idempotent per interval). */
export async function enqueueSealing(
  db: Db,
  options: { intervalMs: number; now?: Date },
): Promise<number> {
  const now = options.now ?? new Date()
  const bucket = Math.floor(now.getTime() / options.intervalMs)
  return withSystem(db, "integrity.schedule", async (trx) => {
    const tenants = await trx
      .selectFrom("raw_evidence_objects as r")
      .leftJoin("integrity_manifest_items as i", "i.raw_object_id", "r.id")
      .select("r.tenant_id")
      .distinct()
      .where("i.raw_object_id", "is", null)
      .execute()
    let created = 0
    for (const { tenant_id } of tenants) {
      const result = await enqueueJob(trx, {
        queue: "integrity",
        type: "integrity.seal",
        tenantId: tenant_id,
        payload: { tenantId: tenant_id },
        idempotencyKey: `seal:${tenant_id}:${bucket}`,
      })
      if (result.created) created++
    }
    return created
  })
}

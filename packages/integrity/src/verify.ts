import { withSystem, withTenant, type Db, type IntegrityManifest, type Tx } from "@platform/db"
import {
  manifestSignatureKey,
  ObjectNotFoundError,
  readRawEvidence,
  type ObjectStore,
} from "@platform/evidence"
import { emitEvent } from "@platform/jobs"
import { computeMerkleRoot, manifestHash, type ManifestDocument } from "./manifest"
import { verifySignature } from "./signing"

/**
 * Evidence verification (dev bible §15). Checks resolve in order:
 *
 *   SOURCE → ORIGINAL OBJECT → RAW HASH → TIMESTAMP → MANIFEST → SIGNATURE → CHAIN
 *
 * Each check is evaluated from first principles against object storage and
 * historical public keys; nothing is taken from a cached "verified" flag.
 * Verification proves the artifact is unchanged since capture — not that the
 * upstream source was truthful (§1.4).
 */
export const verificationChecks = [
  "SOURCE",
  "ORIGINAL_OBJECT",
  "RAW_HASH",
  "TIMESTAMP",
  "MANIFEST",
  "SIGNATURE",
  "CHAIN",
] as const
export type VerificationCheck = (typeof verificationChecks)[number]
export type CheckStatus = "passed" | "failed" | "pending" | "skipped"

export interface CheckResult {
  check: VerificationCheck
  status: CheckStatus
  detail: string
}

export interface EvidenceVerification {
  evidenceId: string
  reference: string
  result: "verified" | "pending" | "failed"
  manifestId: string | null
  checks: CheckResult[]
  verifiedAt: string
}

const CLOCK_SKEW_MS = 5 * 60 * 1000

export interface VerifyDependencies {
  db: Db
  store: ObjectStore
  now?: () => Date
}

async function loadManifestDocument(store: ObjectStore, manifest: IntegrityManifest) {
  const bytes = await store.get(manifest.storage_object_key)
  return { bytes, document: JSON.parse(bytes.toString("utf8")) as ManifestDocument }
}

/** Verifies one manifest's bytes, Merkle root and signature. */
async function checkManifest(trx: Tx, store: ObjectStore, manifest: IntegrityManifest) {
  const { bytes, document } = await loadManifestDocument(store, manifest)
  if (manifestHash(bytes) !== manifest.manifest_sha256) {
    return {
      ok: false as const,
      check: "MANIFEST" as const,
      detail: "Manifest object does not match its recorded hash",
    }
  }
  if (
    computeMerkleRoot(document.items) !== manifest.merkle_root ||
    document.merkleRoot !== manifest.merkle_root
  ) {
    return {
      ok: false as const,
      check: "MANIFEST" as const,
      detail: "Merkle root does not match manifest items",
    }
  }
  const key = await trx
    .selectFrom("signing_keys")
    .select(["public_key", "status"])
    .where("id", "=", manifest.signing_key_id)
    .executeTakeFirst()
  if (!key)
    return {
      ok: false as const,
      check: "SIGNATURE" as const,
      detail: `Unknown signing key ${manifest.signing_key_id}`,
    }
  const storedSignature = (
    await store.get(manifestSignatureKey(manifest.tenant_id, manifest.id))
  ).toString("utf8")
  if (
    storedSignature !== manifest.signature ||
    !verifySignature(key.public_key, bytes, manifest.signature)
  ) {
    return {
      ok: false as const,
      check: "SIGNATURE" as const,
      detail: "Manifest signature is invalid",
    }
  }
  return { ok: true as const, document, keyStatus: key.status }
}

/** Verifies the link from `manifest` to its predecessor. */
async function checkChainLink(
  trx: Tx,
  store: ObjectStore,
  manifest: IntegrityManifest,
  document: ManifestDocument,
) {
  if (Number(manifest.sequence) === 1) {
    return document.previousManifestHash === null
      ? { ok: true, detail: "Genesis manifest of the tenant chain" }
      : { ok: false, detail: "Genesis manifest claims a predecessor" }
  }
  const previous = await trx
    .selectFrom("integrity_manifests")
    .selectAll()
    .where("tenant_id", "=", manifest.tenant_id)
    .where("sequence", "=", String(Number(manifest.sequence) - 1))
    .executeTakeFirst()
  if (!previous || previous.id !== manifest.previous_manifest_id) {
    return { ok: false, detail: "Predecessor manifest is missing" }
  }
  const previousBytes = await store.get(previous.storage_object_key)
  const previousHash = manifestHash(previousBytes)
  if (previousHash !== previous.manifest_sha256)
    return { ok: false, detail: "Predecessor manifest object was altered" }
  if (
    document.previousManifestHash !== previousHash ||
    manifest.previous_manifest_hash !== previousHash
  ) {
    return { ok: false, detail: "Chain link hash mismatch" }
  }
  return { ok: true, detail: `Linked to manifest #${previous.sequence}` }
}

export async function verifyEvidence(
  deps: VerifyDependencies,
  input: { tenantId: string; evidenceId: string; verifiedBy: string },
): Promise<EvidenceVerification> {
  const at = (deps.now ?? (() => new Date()))()
  return withTenant(deps.db, { tenantId: input.tenantId }, async (trx) => {
    const row = await trx
      .selectFrom("raw_evidence_objects")
      .selectAll()
      .where("id", "=", input.evidenceId)
      .executeTakeFirst()
    if (!row) throw new Error("Evidence not found")

    const checks: CheckResult[] = []
    const add = (check: VerificationCheck, status: CheckStatus, detail: string) =>
      checks.push({ check, status, detail })
    const skipRest = () => {
      for (const check of verificationChecks) {
        if (!checks.some((c) => c.check === check))
          add(check, "skipped", "Not evaluated after an earlier failure")
      }
    }

    // SOURCE — provenance is complete and attributable.
    if (row.source && row.source_api && row.source_tenant && row.source_object_id) {
      add("SOURCE", "passed", `${row.source} · ${row.source_api} · tenant ${row.source_tenant}`)
    } else {
      add("SOURCE", "failed", "Provenance is incomplete")
    }

    // ORIGINAL OBJECT + RAW HASH
    let envelopeOk = false
    try {
      const { envelope } = await readRawEvidence(deps.store, row)
      add("ORIGINAL_OBJECT", "passed", "Original object retrieved from evidence storage")
      const matches =
        envelope.source === row.source &&
        envelope.sourceObjectId === row.source_object_id &&
        (envelope.sourceEventId ?? null) === row.source_event_id
      add(
        "RAW_HASH",
        matches ? "passed" : "failed",
        matches ? `SHA-256 ${row.raw_sha256}` : "Envelope identity does not match provenance",
      )
      envelopeOk = matches
    } catch (error) {
      if (error instanceof ObjectNotFoundError)
        add("ORIGINAL_OBJECT", "failed", "Original object is missing")
      else {
        add("ORIGINAL_OBJECT", "passed", "Original object retrieved from evidence storage")
        add("RAW_HASH", "failed", "Stored bytes do not match the recorded SHA-256")
      }
    }

    const item = await trx
      .selectFrom("integrity_manifest_items")
      .selectAll()
      .where("raw_object_id", "=", row.id)
      .executeTakeFirst()
    const manifest = item
      ? await trx
          .selectFrom("integrity_manifests")
          .selectAll()
          .where("id", "=", item.manifest_id)
          .executeTakeFirstOrThrow()
      : undefined

    if (envelopeOk) {
      // TIMESTAMP — capture order is plausible and covered by the sealed period.
      const ordered = row.observed_at.getTime() <= row.ingested_at.getTime() + CLOCK_SKEW_MS
      const inPeriod =
        !manifest ||
        (row.ingested_at >= manifest.period_start && row.ingested_at < manifest.period_end)
      add(
        "TIMESTAMP",
        ordered && inPeriod ? "passed" : "failed",
        ordered && inPeriod
          ? `Observed ${row.observed_at.toISOString()} · ingested ${row.ingested_at.toISOString()}`
          : "Capture timestamps are inconsistent",
      )
    }

    if (checks.some((c) => c.status === "failed")) {
      skipRest()
    } else if (!manifest) {
      for (const check of ["MANIFEST", "SIGNATURE", "CHAIN"] as const)
        add(check, "pending", "Awaiting next integrity seal")
    } else {
      try {
        const verified = await checkManifest(trx, deps.store, manifest)
        if (!verified.ok) {
          if (verified.check === "SIGNATURE")
            add("MANIFEST", "passed", "Manifest contents verified")
          add(verified.check, "failed", verified.detail)
          skipRest()
        } else {
          const leaf = verified.document.items[item!.leaf_index]
          if (!leaf || leaf.id !== row.id || leaf.hash !== row.raw_sha256) {
            add("MANIFEST", "failed", "Object is not in its manifest at the recorded position")
            skipRest()
          } else {
            add(
              "MANIFEST",
              "passed",
              `Manifest #${manifest.sequence} · leaf ${item!.leaf_index} · root ${manifest.merkle_root.slice(0, 16)}…`,
            )
            add(
              "SIGNATURE",
              "passed",
              `Ed25519 · key ${manifest.signing_key_id}${verified.keyStatus === "retired" ? " (retired, historical)" : ""}`,
            )
            const link = await checkChainLink(trx, deps.store, manifest, verified.document)
            add("CHAIN", link.ok ? "passed" : "failed", link.detail)
          }
        }
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error
        add("MANIFEST", "failed", "Manifest object is missing")
        skipRest()
      }
    }

    const result = checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.some((c) => c.status === "pending")
        ? "pending"
        : "verified"
    await trx
      .insertInto("evidence_verifications")
      .values({
        tenant_id: row.tenant_id,
        raw_object_id: row.id,
        manifest_id: manifest?.id ?? null,
        result,
        checks: JSON.stringify(checks),
        verified_by: input.verifiedBy,
        verified_at: at,
      })
      .execute()
    if (result === "verified") {
      await emitEvent(trx, {
        type: "EvidenceIntegrityVerified",
        tenantId: row.tenant_id,
        aggregate: { type: "evidence", id: row.id },
        payload: { evidenceId: row.id, manifestId: manifest!.id },
      })
    }
    return {
      evidenceId: row.id,
      reference: row.reference,
      result,
      manifestId: manifest?.id ?? null,
      checks,
      verifiedAt: at.toISOString(),
    }
  })
}

/**
 * Walks a tenant's entire manifest chain: every manifest's bytes, Merkle root,
 * signature, item rows and link to its predecessor.
 */
export async function verifyManifestChain(
  deps: VerifyDependencies,
  input: { tenantId: string },
): Promise<{ manifests: number; items: number; failures: { sequence: number; detail: string }[] }> {
  return withSystem(deps.db, "integrity.verify_chain", async (trx) => {
    const manifests = await trx
      .selectFrom("integrity_manifests")
      .selectAll()
      .where("tenant_id", "=", input.tenantId)
      .orderBy("sequence")
      .execute()
    const failures: { sequence: number; detail: string }[] = []
    let items = 0
    for (const [index, manifest] of manifests.entries()) {
      const sequence = Number(manifest.sequence)
      if (sequence !== index + 1)
        failures.push({ sequence, detail: `Gap in chain before #${sequence}` })
      try {
        const verified = await checkManifest(trx, deps.store, manifest)
        if (!verified.ok) {
          failures.push({ sequence, detail: verified.detail })
          continue
        }
        const rows = await trx
          .selectFrom("integrity_manifest_items")
          .select(["raw_object_id", "raw_sha256", "leaf_index"])
          .where("manifest_id", "=", manifest.id)
          .orderBy("leaf_index")
          .execute()
        items += rows.length
        const consistent =
          rows.length === verified.document.items.length &&
          rows.every(
            (r, i) =>
              verified.document.items[i]?.id === r.raw_object_id &&
              verified.document.items[i]?.hash === r.raw_sha256,
          )
        if (!consistent)
          failures.push({ sequence, detail: "Item rows differ from the signed manifest" })
        const link = await checkChainLink(trx, deps.store, manifest, verified.document)
        if (!link.ok) failures.push({ sequence, detail: link.detail })
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error
        failures.push({ sequence, detail: "Manifest object is missing" })
      }
    }
    return { manifests: manifests.length, items, failures }
  })
}

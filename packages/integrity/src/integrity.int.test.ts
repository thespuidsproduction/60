import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql, withSystem } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import {
  createEvidenceCapture,
  createMemoryObjectStore,
  manifestSignatureKey,
} from "@platform/evidence"
import { canonicalJson, createLogger } from "@platform/shared"
import { sealPendingEvidence, enqueueSealing } from "./seal"
import {
  createManifestSigner,
  generateSigningKey,
  registerSigningKeys,
  retireSigningKey,
} from "./signing"
import { verifyEvidence, verifyManifestChain } from "./verify"

const log = createLogger({ level: "error" })
const store = createMemoryObjectStore()
const k1 = generateSigningKey("k1")
const k2 = generateSigningKey("k2")
let db: TestDatabase
let tenant: string
let clock = new Date("2026-10-02T02:30:00Z")
const now = () => clock

const envelope = (id: string, source = "fixture") => ({
  source,
  sourceTenant: "upstream-1",
  sourceObjectId: id,
  sourceEventId: id,
  objectType: "event",
  sourceApi: "GET /events",
  capturedAt: clock.toISOString(),
  sourceTimestamp: clock.toISOString(),
  payload: { id, type: "sign_in", user: "alice@acme.example" },
})

async function capture(id: string, source = "fixture") {
  const sink = createEvidenceCapture({ db: db.app, store, log, now })
  await sink.capture(envelope(id, source), {
    tenantId: tenant,
    connectorId: null as never,
    syncRunId: null as never,
  })
  const row = await db.owner
    .selectFrom("raw_evidence_objects")
    .select("id")
    .where("source_event_id", "=", id)
    .executeTakeFirstOrThrow()
  return row.id
}

const seal = (spec = `k1:${k1.privateKeyPkcs8}`) =>
  sealPendingEvidence(
    { db: db.app, store, signer: createManifestSigner(spec), log, now, graceMs: 0 },
    { tenantId: tenant },
  )
const verify = (evidenceId: string) =>
  verifyEvidence({ db: db.app, store, now }, { tenantId: tenant, evidenceId, verifiedBy: "test" })
const statuses = (v: Awaited<ReturnType<typeof verify>>) =>
  Object.fromEntries(v.checks.map((c) => [c.check, c.status]))

beforeAll(async () => {
  db = await createTestDatabase()
  tenant = await withSystem(db.app, "test", async (trx) => {
    const row = await trx
      .insertInto("organisations")
      .values({ slug: "acme", name: "Acme" })
      .returning("id")
      .executeTakeFirstOrThrow()
    return row.id
  })
  await registerSigningKeys(db.app, `k1:${k1.privateKeyPkcs8},k2:${k2.privateKeyPkcs8}`)
})
afterAll(async () => {
  await db?.destroy()
})

describe("sealing and verification", () => {
  it("reports MANIFEST/SIGNATURE/CHAIN pending before sealing", async () => {
    const id = await capture("e1")
    const v = await verify(id)
    expect(v.result).toBe("pending")
    expect(statuses(v)).toEqual({
      SOURCE: "passed",
      ORIGINAL_OBJECT: "passed",
      RAW_HASH: "passed",
      TIMESTAMP: "passed",
      MANIFEST: "pending",
      SIGNATURE: "pending",
      CHAIN: "pending",
    })
  })

  it("seals per source and hour into a signed, chained sequence; verifies every check", async () => {
    await capture("e2")
    await capture("s1", "other-source")
    clock = new Date("2026-10-02T03:10:00Z")
    const late = await capture("e3")
    const result = await seal()
    expect(result.items).toBe(4)
    expect(result.manifestIds).toHaveLength(3) // fixture@02h, other-source@02h, fixture@03h

    const manifests = await db.owner
      .selectFrom("integrity_manifests")
      .selectAll()
      .orderBy("sequence")
      .execute()
    expect(manifests.map((m) => [Number(m.sequence), m.source, m.item_count])).toEqual([
      [1, "fixture", 2],
      [2, "other-source", 1],
      [3, "fixture", 1],
    ])
    expect(manifests[0]!.previous_manifest_hash).toBeNull()
    expect(manifests[1]!.previous_manifest_hash).toBe(manifests[0]!.manifest_sha256)
    expect(manifests[2]!.previous_manifest_hash).toBe(manifests[1]!.manifest_sha256)

    const v = await verify(late)
    expect(v.result).toBe("verified")
    expect(Object.values(statuses(v)).every((s) => s === "passed")).toBe(true)
    expect((await seal()).manifestIds).toHaveLength(0) // idempotent

    const chain = await verifyManifestChain({ db: db.app, store }, { tenantId: tenant })
    expect(chain).toEqual({ manifests: 3, items: 4, failures: [] })
  })

  it("keeps old manifests verifiable after key rotation and retirement", async () => {
    clock = new Date("2026-10-02T04:05:00Z")
    const id = await capture("e4")
    await seal(`k2:${k2.privateKeyPkcs8},k1:${k1.privateKeyPkcs8}`)
    await retireSigningKey(db.app, "k1")
    const latest = await db.owner
      .selectFrom("integrity_manifests")
      .select("signing_key_id")
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow()
    expect(latest.signing_key_id).toBe("k2")
    const first = await db.owner
      .selectFrom("integrity_manifest_items")
      .select("raw_object_id")
      .where("leaf_index", "=", 0)
      .orderBy("raw_object_id")
      .execute()
    const oldOne = await verify(first[0]!.raw_object_id)
    expect(oldOne.result).toBe("verified")
    expect((await verify(id)).result).toBe("verified")
    expect(oldOne.checks.find((c) => c.check === "SIGNATURE")?.detail ?? "").toMatch(/k1|k2/)
  })

  it("detects a tampered raw object", async () => {
    clock = new Date("2026-10-02T05:00:00Z")
    const id = await capture("t1")
    await seal()
    const row = await db.owner
      .selectFrom("raw_evidence_objects")
      .select("storage_object_key")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    const original = store.objects.get(row.storage_object_key)!
    store.objects.set(
      row.storage_object_key,
      Buffer.from(canonicalJson({ ...envelope("t1"), payload: { forged: true } })),
    )
    const v = await verify(id)
    expect(v.result).toBe("failed")
    expect(statuses(v)).toMatchObject({
      ORIGINAL_OBJECT: "passed",
      RAW_HASH: "failed",
      MANIFEST: "skipped",
    })
    store.objects.set(row.storage_object_key, original)
    expect((await verify(id)).result).toBe("verified")
  })

  it("detects tampered manifests, forged signatures and broken chain links", async () => {
    const manifests = await db.owner
      .selectFrom("integrity_manifests")
      .selectAll()
      .orderBy("sequence")
      .execute()
    const target = manifests[1]!
    const item = await db.owner
      .selectFrom("integrity_manifest_items")
      .select("raw_object_id")
      .where("manifest_id", "=", target.id)
      .executeTakeFirstOrThrow()

    // Altered manifest bytes: MANIFEST fails for its items, CHAIN fails for its successor.
    const original = store.objects.get(target.storage_object_key)!
    const doc = JSON.parse(original.toString())
    store.objects.set(
      target.storage_object_key,
      Buffer.from(canonicalJson({ ...doc, source: "forged" })),
    )
    expect(statuses(await verify(item.raw_object_id)).MANIFEST).toBe("failed")
    const successorItem = await db.owner
      .selectFrom("integrity_manifest_items")
      .select("raw_object_id")
      .where("manifest_id", "=", manifests[2]!.id)
      .executeTakeFirstOrThrow()
    expect(statuses(await verify(successorItem.raw_object_id)).CHAIN).toBe("failed")
    const chain = await verifyManifestChain({ db: db.app, store }, { tenantId: tenant })
    expect(chain.failures.map((f) => f.sequence)).toEqual([2, 3])
    store.objects.set(target.storage_object_key, original)

    // Forged signature object.
    const sigKey = manifestSignatureKey(tenant, target.id)
    const sig = store.objects.get(sigKey)!
    store.objects.set(sigKey, Buffer.from(Buffer.alloc(64, 1).toString("base64")))
    expect(statuses(await verify(item.raw_object_id)).SIGNATURE).toBe("failed")
    store.objects.set(sigKey, sig)

    expect(
      (await verifyManifestChain({ db: db.app, store }, { tenantId: tenant })).failures,
    ).toEqual([])
  })

  it("records every verification and rejects edits to manifests", async () => {
    const count = await db.owner
      .selectFrom("evidence_verifications")
      .select(db.owner.fn.countAll().as("n"))
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBeGreaterThan(5)
    await expect(
      sql`update integrity_manifests set merkle_root = repeat('0', 64)`.execute(db.owner),
    ).rejects.toThrow(/append-only/)
    await expect(sql`delete from integrity_manifest_items`.execute(db.owner)).rejects.toThrow(
      /append-only/,
    )
  })

  it("refuses to re-register a key id with a different key; schedules sealing per tenant", async () => {
    const other = generateSigningKey("k1")
    await expect(registerSigningKeys(db.app, `k1:${other.privateKeyPkcs8}`)).rejects.toThrow(
      /different public key/,
    )
    clock = new Date("2026-10-02T06:00:00Z")
    await capture("sched-1")
    expect(await enqueueSealing(db.app, { intervalMs: 300_000, now: clock })).toBe(1)
    expect(await enqueueSealing(db.app, { intervalMs: 300_000, now: clock })).toBe(0)
  })
})

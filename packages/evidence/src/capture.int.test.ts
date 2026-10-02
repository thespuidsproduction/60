import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  connectIntegration,
  createConnectorRegistry,
  createHttpClient,
  runConnectorSync,
} from "@platform/connectors"
import { fixtureAdapter, startFakeUpstream } from "@platform/connectors/testing"
import { sql, withSystem, withTenant } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import { PermanentJobError } from "@platform/jobs"
import { canonicalJson, createLogger, createSecretBox, parseKeyRing } from "@platform/shared"
import { createEvidenceCapture, dedupKey, readRawEvidence } from "./capture"
import { createTransformerRegistry, enqueueReprocessing, normaliseEvidence } from "./normalise"
import { createMemoryObjectStore, sha256Hex } from "./object-store"
import { fixtureTransformerV1, fixtureTransformerV2 } from "./testing"

const log = createLogger({ level: "error" })
let db: TestDatabase
let tenantA: string
let tenantB: string
const store = createMemoryObjectStore()

const envelope = (over: Record<string, unknown> = {}) => ({
  source: "fixture",
  sourceTenant: "upstream-1",
  sourceObjectId: "obj-1",
  sourceEventId: "evt-1",
  objectType: "event",
  sourceApi: "GET /events",
  capturedAt: "2026-10-02T02:18:03.000Z",
  sourceTimestamp: "2026-10-02T02:17:24.000Z",
  payload: {
    type: "privilege_change",
    user: "alice@acme.example",
    ip: "203.0.113.7",
    severity: "high",
  },
  ...over,
})

beforeAll(async () => {
  db = await createTestDatabase()
  ;[tenantA, tenantB] = await withSystem(db.app, "test", async (trx) => {
    const rows = await trx
      .insertInto("organisations")
      .values([
        { slug: "acme", name: "Acme" },
        { slug: "beta", name: "Beta" },
      ])
      .returning("id")
      .execute()
    return [rows[0]!.id, rows[1]!.id]
  })
})
afterAll(async () => {
  await db?.destroy()
})

const ctx = () => ({
  tenantId: tenantA,
  connectorId: null as unknown as string,
  syncRunId: null as unknown as string,
})
const sink = () => createEvidenceCapture({ db: db.app, store, log })

describe("raw evidence capture", () => {
  it("stores canonical bytes, records provenance and emits EvidenceCaptured", async () => {
    const e = envelope()
    expect(await sink().capture(e, ctx())).toBe("captured")
    const row = await db.owner
      .selectFrom("raw_evidence_objects")
      .selectAll()
      .where("dedup_key", "=", dedupKey(e))
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      reference: "EV-000001",
      source: "fixture",
      source_event_id: "evt-1",
      object_type: "event",
      trust_level: "A",
      classification: "SECURITY_SENSITIVE",
    })
    expect(row.occurred_at?.toISOString()).toBe("2026-10-02T02:17:24.000Z")
    expect(row.observed_at.toISOString()).toBe("2026-10-02T02:18:03.000Z")
    expect(row.storage_object_key).toMatch(
      new RegExp(
        `^tenant/${tenantA}/raw/year=2026/month=10/day=02/source=fixture/${row.id}\\.json$`,
      ),
    )

    const stored = store.objects.get(row.storage_object_key)!
    expect(stored.toString()).toBe(canonicalJson(e))
    expect(sha256Hex(stored)).toBe(row.raw_sha256)
    expect((await readRawEvidence(store, row)).envelope).toEqual(e)

    const events = await db.owner
      .selectFrom("outbox_events")
      .select(["event_type", "payload"])
      .where("aggregate_id", "=", row.id)
      .execute()
    expect(events).toEqual([
      {
        event_type: "EvidenceCaptured",
        payload: { evidenceId: row.id, source: "fixture", objectType: "event" },
      },
    ])
  })

  it("deduplicates by source event ID; snapshot objects version on payload change", async () => {
    expect(await sink().capture(envelope({ capturedAt: "2026-10-02T03:00:00.000Z" }), ctx())).toBe(
      "duplicate",
    )
    const snap = envelope({
      sourceEventId: null,
      sourceObjectId: "user-42",
      objectType: "event",
      payload: { type: "snapshot", mfa: true },
    })
    expect(await sink().capture(snap, ctx())).toBe("captured")
    expect(await sink().capture({ ...snap, capturedAt: "2026-10-02T05:00:00.000Z" }, ctx())).toBe(
      "duplicate",
    )
    expect(
      await sink().capture({ ...snap, payload: { type: "snapshot", mfa: false } }, ctx()),
    ).toBe("captured")
  })

  it("is append-only and invisible to other tenants", async () => {
    await expect(
      sql`update raw_evidence_objects set source = 'x'`.execute(db.owner),
    ).rejects.toThrow(/append-only/)
    await expect(sql`delete from raw_evidence_objects`.execute(db.owner)).rejects.toThrow(
      /append-only/,
    )
    const visible = await withTenant(db.app, { tenantId: tenantB }, (trx) =>
      trx.selectFrom("raw_evidence_objects").select("id").execute(),
    )
    expect(visible).toHaveLength(0)
  })

  it("issues per-tenant references", async () => {
    await sink().capture(envelope({ sourceEventId: "b-1" }), { ...ctx(), tenantId: tenantB })
    const row = await db.owner
      .selectFrom("raw_evidence_objects")
      .select("reference")
      .where("tenant_id", "=", tenantB)
      .executeTakeFirstOrThrow()
    expect(row.reference).toBe("EV-000001")
  })

  it("quarantines unparseable objects with their raw content preserved", async () => {
    await sink().quarantine({ weird: true }, "invalid source envelope", ctx())
    const q = await db.owner.selectFrom("evidence_quarantine").selectAll().executeTakeFirstOrThrow()
    expect(JSON.parse(store.objects.get(q.storage_object_key)!.toString())).toMatchObject({
      reason: "invalid source envelope",
      raw: { weird: true },
    })
  })
})

describe("normalisation", () => {
  const registry = createTransformerRegistry([fixtureTransformerV1, fixtureTransformerV2])
  const deps = () => ({ db: db.app, store, transformers: registry, log })

  it("produces a versioned canonical event, idempotently", async () => {
    const raw = await db.owner
      .selectFrom("raw_evidence_objects")
      .selectAll()
      .where("reference", "=", "EV-000001")
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow()
    const first = await normaliseEvidence(deps(), {
      evidenceId: raw.id,
      transformerVersion: "1.0.0",
    })
    expect(first.status).toBe("normalised")
    expect(
      (await normaliseEvidence(deps(), { evidenceId: raw.id, transformerVersion: "1.0.0" })).status,
    ).toBe("already_normalised")
    const event = await db.owner
      .selectFrom("evidence_events")
      .selectAll()
      .where("raw_object_id", "=", raw.id)
      .executeTakeFirstOrThrow()
    expect(event).toMatchObject({
      event_type: "fixture.privilege_change",
      severity: "high",
      subject_type: "identity",
      subject_id: "alice@acme.example",
      schema_version: "evidence.fixture.event.v1",
      transformer: "fixture-transformer",
      transformer_version: "1.0.0",
      time_confidence: "source",
      raw_sha256: raw.raw_sha256,
      trust_level: "A",
    })
    expect(event.normalized_sha256).toBe(sha256Hex(canonicalJson(event.normalized_payload)))
    expect(event.occurred_at?.toISOString()).toBe("2026-10-02T02:17:24.000Z")
  })

  it("reprocessing with a new transformer adds rows and keeps history (§112)", async () => {
    expect(
      await enqueueReprocessing(db.app, {
        tenantId: tenantA,
        source: "fixture",
        objectType: "event",
        transformer: fixtureTransformerV2,
      }),
    ).toBeGreaterThan(0)
    const raw = await db.owner
      .selectFrom("raw_evidence_objects")
      .select("id")
      .where("reference", "=", "EV-000001")
      .where("tenant_id", "=", tenantA)
      .executeTakeFirstOrThrow()
    await normaliseEvidence(deps(), { evidenceId: raw.id, transformerVersion: "2.0.0" })
    const events = await db.owner
      .selectFrom("evidence_events")
      .select(["transformer_version", "schema_version", "normalized_payload"])
      .where("raw_object_id", "=", raw.id)
      .orderBy("transformer_version")
      .execute()
    expect(events.map((e) => e.transformer_version)).toEqual(["1.0.0", "2.0.0"])
    expect(events[1]!.normalized_payload).toMatchObject({ ip: "203.0.113.7" })
  })

  it("refuses to normalise tampered objects and records the integrity failure", async () => {
    const e = envelope({ sourceEventId: "tamper-1" })
    await sink().capture(e, ctx())
    const raw = await db.owner
      .selectFrom("raw_evidence_objects")
      .selectAll()
      .where("dedup_key", "=", dedupKey(e))
      .executeTakeFirstOrThrow()
    store.objects.set(
      raw.storage_object_key,
      Buffer.from(canonicalJson({ ...e, payload: { type: "nothing_to_see" } })),
    )
    await expect(normaliseEvidence(deps(), { evidenceId: raw.id })).rejects.toBeInstanceOf(
      PermanentJobError,
    )
    const failure = await db.owner
      .selectFrom("evidence_verifications")
      .selectAll()
      .where("raw_object_id", "=", raw.id)
      .executeTakeFirstOrThrow()
    expect(failure).toMatchObject({
      result: "failed",
      checks: [{ check: "RAW_HASH", status: "failed" }],
    })
  })
})

describe("connector → capture end to end", () => {
  it("syncs through the real capture sink with provenance back to the sync run", async () => {
    const upstream = await startFakeUpstream({
      records: [
        {
          id: "u1",
          occurredAt: "2026-10-02T02:14:00Z",
          type: "sign_in",
          user: "alice@acme.example",
        },
        {
          id: "u2",
          occurredAt: "2026-10-02T02:17:24Z",
          type: "privilege_change",
          user: "alice@acme.example",
        },
        { id: "u3", occurredAt: "2026-10-02T02:21:00Z", type: "alert", user: "alice@acme.example" },
      ],
    })
    try {
      const box = createSecretBox(parseKeyRing(`k1:${randomBytes(32).toString("base64")}`))
      const registry = createConnectorRegistry([fixtureAdapter])
      const httpClient = (l: typeof log) => createHttpClient({ log: l, baseBackoffMs: 1 })
      const { connectorId } = await connectIntegration(
        { db: db.app, secretBox: box, registry, log, httpClient },
        {
          tenantId: tenantB,
          type: "fixture",
          displayName: "Fixture",
          config: { baseUrl: upstream.url, pageSize: 2 },
          credentials: { token: upstream.token },
          actor: { type: "system", label: "test" },
        },
      )
      const summary = await runConnectorSync(
        { db: db.app, secretBox: box, registry, sink: sink(), log, httpClient },
        { connectorId, mode: "baseline" },
      )
      expect(summary).toMatchObject({ status: "succeeded", captured: 3 })
      const rows = await db.owner
        .selectFrom("raw_evidence_objects")
        .selectAll()
        .where("connector_id", "=", connectorId)
        .orderBy("reference")
        .execute()
      expect(rows.map((r) => r.source_event_id)).toEqual(["u1", "u2", "u3"])
      expect(new Set(rows.map((r) => r.sync_run_id)).size).toBe(1)
      expect(rows.every((r) => r.source_tenant === "upstream-tenant-1")).toBe(true)
    } finally {
      await upstream.close()
    }
  })
})

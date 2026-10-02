import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withSystem, withTenant } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import { createLogger } from "@platform/shared"
import { createEvidenceCapture } from "./capture"
import { createTransformerRegistry, normaliseEvidence } from "./normalise"
import { createMemoryObjectStore } from "./object-store"
import { parseEvidenceQuery } from "./query"
import { getEvidenceDetail, searchEvidence } from "./search"
import { fixtureTransformerV1 } from "./testing"

const log = createLogger({ level: "error" })
const store = createMemoryObjectStore()
let db: TestDatabase
let tenant: string
let other: string

const records = [
  {
    id: "a1",
    at: "2026-10-02T02:14:32Z",
    type: "sign_in",
    user: "alice@acme.example",
    severity: "medium",
    description: "Sign-in from unfamiliar location",
  },
  {
    id: "a2",
    at: "2026-10-02T02:17:24Z",
    type: "privilege_change",
    user: "alice@acme.example",
    severity: "high",
    description: "Global Administrator role added",
  },
  {
    id: "b1",
    at: "2026-10-02T02:23:40Z",
    type: "remote_session",
    user: "bob@acme.example",
    device: "SRV-ACME-DC01",
    severity: "high",
    description: "Remote session opened",
  },
  {
    id: "b2",
    at: "2026-10-02T05:00:00Z",
    type: "account_disabled",
    user: "bob@acme.example",
    severity: "info",
    description: "Account disabled",
  },
]

beforeAll(async () => {
  db = await createTestDatabase()
  ;[tenant, other] = await withSystem(db.app, "test", async (trx) => {
    const rows = await trx
      .insertInto("organisations")
      .values([
        { slug: "acme", name: "Acme" },
        { slug: "other", name: "Other" },
      ])
      .returning("id")
      .execute()
    return [rows[0]!.id, rows[1]!.id]
  })
  const sink = createEvidenceCapture({ db: db.app, store, log })
  const transformers = createTransformerRegistry([fixtureTransformerV1])
  for (const r of records) {
    await sink.capture(
      {
        source: "fixture",
        sourceTenant: "u",
        sourceObjectId: r.id,
        sourceEventId: r.id,
        objectType: "event",
        sourceApi: "GET /events",
        capturedAt: "2026-10-02T06:00:00.000Z",
        sourceTimestamp: r.at,
        payload: { ...r },
      },
      { tenantId: tenant, connectorId: null as never, syncRunId: null as never },
    )
  }
  const raws = await db.owner.selectFrom("raw_evidence_objects").select("id").execute()
  for (const raw of raws)
    await normaliseEvidence({ db: db.app, store, transformers, log }, { evidenceId: raw.id })
})
afterAll(async () => {
  await db?.destroy()
})

const search = (q: string, options = {}) =>
  withTenant(db.app, { tenantId: tenant }, (trx) =>
    searchEvidence(
      trx,
      parseEvidenceQuery(q, { today: new Date("2026-10-02T12:00:00Z") }).query,
      options,
    ),
  )
const refs = (page: Awaited<ReturnType<typeof search>>) => page.items.map((i) => i.reference)

describe("searchEvidence", () => {
  it("returns newest first with normalised fields and integrity state", async () => {
    const page = await search("")
    expect(refs(page)).toEqual(["EV-000004", "EV-000003", "EV-000002", "EV-000001"])
    expect(page.items[2]).toMatchObject({
      eventType: "fixture.privilege_change",
      subjectId: "alice@acme.example",
      occurredAt: "2026-10-02T02:17:24.000Z",
      integrity: "unsealed",
      transformerVersion: "1.0.0",
      trustLevel: "A",
    })
  })

  it("applies §19 filters", async () => {
    expect(refs(await search("identity:alice"))).toEqual(["EV-000002", "EV-000001"])
    expect(refs(await search("type:privilege_change"))).toEqual(["EV-000002"])
    expect(refs(await search("asset:dc01"))).toEqual(["EV-000003"])
    expect(refs(await search("between:02:00..04:00 severity:high"))).toEqual([
      "EV-000003",
      "EV-000002",
    ])
    expect(refs(await search("ref:EV-1"))).toEqual(["EV-000001"])
    expect(refs(await search("disabled"))).toEqual(["EV-000004"])
    expect(refs(await search("source:other"))).toEqual([])
    expect(refs(await search('identity:"100%_"'))).toEqual([]) // wildcards are escaped
  })

  it("derives integrity from the latest verification", async () => {
    const id = (await search("ref:EV-000001")).items[0]!.id
    await withSystem(db.app, "test", (trx) =>
      trx
        .insertInto("evidence_verifications")
        .values({
          tenant_id: tenant,
          raw_object_id: id,
          result: "failed",
          checks: "[]",
          verified_by: "t",
        })
        .execute(),
    )
    expect(refs(await search("integrity:failed"))).toEqual(["EV-000001"])
    expect(refs(await search("integrity:unsealed"))).toHaveLength(3)
  })

  it("paginates with a stable keyset cursor", async () => {
    const first = await search("", { limit: 3 })
    expect(refs(first)).toEqual(["EV-000004", "EV-000003", "EV-000002"])
    const second = await search("", { limit: 3, cursor: first.nextCursor })
    expect(refs(second)).toEqual(["EV-000001"])
    expect(second.nextCursor).toBeNull()
    expect(refs(await search("", { cursor: "garbage" }))).toHaveLength(4)
  })

  it("is tenant-isolated and returns full detail", async () => {
    const empty = await withTenant(db.app, { tenantId: other }, (trx) =>
      searchEvidence(trx, parseEvidenceQuery("").query),
    )
    expect(empty.items).toEqual([])
    const id = (await search("ref:EV-000002")).items[0]!.id
    const detail = await withTenant(db.app, { tenantId: tenant }, (trx) =>
      getEvidenceDetail(trx, id),
    )
    expect(detail?.events[0]).toMatchObject({
      transformer: "fixture-transformer",
      schema_version: "evidence.fixture.event.v1",
    })
    expect(
      await withTenant(db.app, { tenantId: other }, (trx) => getEvidenceDetail(trx, id)),
    ).toBeNull()
  })
})

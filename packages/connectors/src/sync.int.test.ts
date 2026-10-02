import { randomBytes } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withSystem, withTenant } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import { PermanentJobError } from "@platform/jobs"
import { createLogger, createSecretBox, parseKeyRing } from "@platform/shared"
import { createHttpClient } from "./http"
import {
  connectIntegration,
  ConnectorSetupError,
  disconnectIntegration,
  enqueueDueSyncs,
} from "./lifecycle"
import { createConnectorRegistry } from "./registry"
import { runConnectorSync } from "./sync"
import { createMemorySink, fixtureAdapter, startFakeUpstream, type FakeUpstream } from "./testing"

const log = createLogger({ level: "error" })
const box = createSecretBox(parseKeyRing(`k1:${randomBytes(32).toString("base64")}`))
const registry = createConnectorRegistry([fixtureAdapter])
const httpClient = (l: typeof log) => createHttpClient({ log: l, baseBackoffMs: 1, maxAttempts: 2 })
const actor = { type: "user" as const, id: null, label: "admin@acme.example" }

let db: TestDatabase
let tenant: string
let upstream: FakeUpstream

const records = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `evt-${from + i}`,
    occurredAt: "2026-10-02T02:17:24Z",
    user: "alice",
  }))

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
})
afterAll(async () => {
  await db?.destroy()
})
beforeEach(async () => {
  upstream = await startFakeUpstream({ records: records(0, 5), pageSize: 2 })
})
afterEach(async () => {
  await upstream.close()
})

const deps = () => ({ db: db.app, secretBox: box, registry, log, httpClient })

async function connect(token = upstream.token) {
  return connectIntegration(deps(), {
    tenantId: tenant,
    type: "fixture",
    displayName: "Fixture",
    config: { baseUrl: upstream.url, pageSize: 2 },
    credentials: { token },
    actor,
  })
}

const connectorRow = (id: string) =>
  db.owner.selectFrom("connectors").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const runs = (id: string) =>
  db.owner
    .selectFrom("connector_sync_runs")
    .selectAll()
    .where("connector_id", "=", id)
    .orderBy("requested_at")
    .execute()
const events = (id: string) =>
  db.owner
    .selectFrom("outbox_events")
    .select("event_type")
    .where("aggregate_id", "=", id)
    .orderBy("seq")
    .execute()

describe("connectIntegration", () => {
  it("verifies upstream, stores encrypted credentials by reference, audits, and enqueues a baseline", async () => {
    const { connectorId, sourceTenant, baselineJobId } = await connect()
    expect(sourceTenant).toBe("upstream-tenant-1")
    const row = await connectorRow(connectorId)
    expect(row).toMatchObject({
      status: "pending",
      granted_permissions: ["Events.Read"],
      capabilities: ["AUDIT_READ"],
    })
    expect(row.credential_ref).toBeTruthy()

    const cred = await db.owner
      .selectFrom("connector_credentials")
      .selectAll()
      .where("id", "=", row.credential_ref!)
      .executeTakeFirstOrThrow()
    expect(cred.secret_enc).not.toContain(upstream.token)

    const job = await db.owner
      .selectFrom("job_records")
      .selectAll()
      .where("id", "=", baselineJobId)
      .executeTakeFirstOrThrow()
    expect(job).toMatchObject({
      queue: "connector-sync",
      job_type: "connector.sync",
      payload: { connectorId, mode: "baseline" },
    })

    // Tenant-scoped code can see the connector but never the credentials.
    await withTenant(db.app, { tenantId: tenant }, async (trx) => {
      expect(
        await trx.selectFrom("connectors").select("id").where("id", "=", connectorId).execute(),
      ).toHaveLength(1)
      expect(await trx.selectFrom("connector_credentials").selectAll().execute()).toHaveLength(0)
    })
    const audit = await db.owner
      .selectFrom("audit_entries")
      .select(["action", "new_state"])
      .where("target_id", "=", connectorId)
      .execute()
    expect(audit.map((a) => a.action)).toEqual([
      "integration.credentials_stored",
      "integration.connected",
    ])
    expect(JSON.stringify(audit)).not.toContain(upstream.token)
  })

  it("refuses to connect with missing permissions or bad credentials", async () => {
    upstream.permissions = []
    const error = await connect().catch((e) => e)
    expect(error).toBeInstanceOf(ConnectorSetupError)
    expect(error.missingPermissions).toEqual(["Events.Read"])
    upstream.permissions = ["Events.Read"]
    const stale = upstream.token
    upstream.expireToken()
    await expect(connect(stale)).rejects.toThrow(/Credentials rejected/)
  })
})

describe("runConnectorSync", () => {
  it("baseline paginates, advances cursors, then incremental continues and dedupes", async () => {
    const { connectorId } = await connect()
    const memory = createMemorySink()
    const sync = (mode: "baseline" | "incremental") =>
      runConnectorSync({ ...deps(), sink: memory.sink }, { connectorId, mode })

    expect(await sync("baseline")).toMatchObject({
      status: "succeeded",
      captured: 5,
      duplicates: 0,
    })
    expect(memory.captured.map((e) => e.sourceEventId)).toEqual(records(0, 5).map((r) => r.id))
    expect(memory.captured[0]).toMatchObject({
      source: "fixture",
      sourceTenant: "upstream-tenant-1",
      payload: records(0, 1)[0],
    })
    expect((await connectorRow(connectorId)).status).toBe("healthy")

    upstream.records = [...records(0, 7), records(3, 4)[0]!] // two new + one duplicate
    expect(await sync("incremental")).toMatchObject({
      status: "succeeded",
      captured: 2,
      duplicates: 1,
    })
    expect(upstream.requests.some((r) => r.startsWith("/events?cursor=5"))).toBe(true)
    const cursor = await db.owner
      .selectFrom("connector_cursors")
      .select("cursor")
      .where("connector_id", "=", connectorId)
      .executeTakeFirstOrThrow()
    expect(cursor.cursor).toBe("8")
  })

  it("quarantines malformed objects, marks the run partial, and degrades health", async () => {
    const { connectorId } = await connect()
    upstream.records = [
      records(0, 1)[0]!,
      { occurredAt: "2026-10-02T02:17:24Z", note: "no id" },
      records(2, 3)[0]!,
    ]
    const memory = createMemorySink()
    const summary = await runConnectorSync(
      { ...deps(), sink: memory.sink },
      { connectorId, mode: "baseline" },
    )
    expect(summary).toMatchObject({ status: "partial", captured: 2, failures: 1 })
    expect(memory.quarantined).toHaveLength(1)
    expect((memory.quarantined[0]!.raw as { payload: unknown }).payload).toEqual({
      occurredAt: "2026-10-02T02:17:24Z",
      note: "no id",
    })
    expect((await connectorRow(connectorId)).status).toBe("degraded")
    expect((await events(connectorId)).map((e) => e.event_type)).toEqual(["ConnectorDegraded"])
  })

  it("expired credentials fail the connector permanently (no retry storm)", async () => {
    const { connectorId } = await connect()
    upstream.expireToken()
    const error = await runConnectorSync(
      { ...deps(), sink: createMemorySink().sink },
      { connectorId, mode: "baseline" },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect((await connectorRow(connectorId)).status).toBe("failed")
    expect((await runs(connectorId)).at(-1)).toMatchObject({
      status: "failed",
      response_state: "CredentialError",
    })
  })

  it("partial outage keeps captured pages, advances the cursor only past them, retries, then recovers", async () => {
    const { connectorId } = await connect()
    const memory = createMemorySink()
    upstream.outageFromPage(1)
    const error = await runConnectorSync(
      { ...deps(), sink: memory.sink },
      { connectorId, mode: "baseline" },
    ).catch((e) => e)
    expect(error).not.toBeInstanceOf(PermanentJobError) // retryable
    expect(memory.captured).toHaveLength(2)
    expect((await runs(connectorId)).at(-1)).toMatchObject({
      status: "partial",
      objects_captured: 2,
    })
    expect((await connectorRow(connectorId)).status).toBe("degraded")

    upstream.outageFromPage(null)
    const summary = await runConnectorSync(
      { ...deps(), sink: memory.sink },
      { connectorId, mode: "incremental" },
    )
    expect(summary).toMatchObject({ status: "succeeded", captured: 3 })
    expect(memory.captured.map((e) => e.sourceEventId)).toEqual(records(0, 5).map((r) => r.id))
    expect((await connectorRow(connectorId)).status).toBe("healthy")
    expect((await events(connectorId)).map((e) => e.event_type)).toEqual([
      "ConnectorDegraded",
      "ConnectorRecovered",
    ])
  })

  it("does not advance the cursor past a batch the sink failed to store", async () => {
    const { connectorId } = await connect()
    const failing = createMemorySink({ failAfter: 3 })
    await expect(
      runConnectorSync({ ...deps(), sink: failing.sink }, { connectorId, mode: "baseline" }),
    ).rejects.toThrow(/sink unavailable/)
    const cursor = await db.owner
      .selectFrom("connector_cursors")
      .select("cursor")
      .where("connector_id", "=", connectorId)
      .executeTakeFirstOrThrow()
    expect(cursor.cursor).toBe("2") // page 2 (items 3–4) was not fully stored
  })

  it("skips disconnected connectors; disconnect revokes credentials and is audited", async () => {
    const { connectorId } = await connect()
    await disconnectIntegration(deps(), {
      tenantId: tenant,
      connectorId,
      actor,
      reason: "offboarding",
    })
    const row = await connectorRow(connectorId)
    expect(row).toMatchObject({ status: "disconnected", credential_ref: null })
    expect(upstream.requests).toContain("/revoke")
    expect(
      await runConnectorSync(
        { ...deps(), sink: createMemorySink().sink },
        { connectorId, mode: "incremental" },
      ),
    ).toMatchObject({ status: "skipped" })
    const revoked = await db.owner
      .selectFrom("connector_credentials")
      .select("revoked_at")
      .where("connector_id", "=", connectorId)
      .execute()
    expect(revoked.every((c) => c.revoked_at !== null)).toBe(true)
  })
})

describe("enqueueDueSyncs", () => {
  it("enqueues once per connector per interval bucket", async () => {
    const { connectorId } = await connect()
    await runConnectorSync(
      { ...deps(), sink: createMemorySink().sink },
      { connectorId, mode: "baseline" },
    )
    const later = new Date(Date.now() + 2 * 3_600_000)
    const first = await enqueueDueSyncs(db.app, { intervalMs: 3_600_000, now: later })
    const second = await enqueueDueSyncs(db.app, { intervalMs: 3_600_000, now: later })
    expect(first).toBeGreaterThanOrEqual(1)
    expect(second).toBe(0)
  })
})

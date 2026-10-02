import { randomUUID } from "node:crypto"
import { Redis } from "ioredis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { withSystem, withTenant } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import { createLogger } from "@platform/shared"
import { defineJob, PermanentJobError } from "./definitions"
import { enqueueJob } from "./enqueue"
import { emitEvent } from "./outbox"
import { createJobRuntime, type JobRuntime } from "./runtime"

const redisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379"
const connection = { url: redisUrl, maxRetriesPerRequest: null }
const log = createLogger({ level: "error" })

let db: TestDatabase
let tenant: string
let redis: Redis

beforeAll(async () => {
  db = await createTestDatabase()
  redis = new Redis(redisUrl)
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
  await redis?.quit()
  await db?.destroy()
})

async function statusOf(id: string) {
  return db.owner
    .selectFrom("job_records")
    .select(["status", "attempts", "last_error"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out waiting for condition")
}

function runtimeWith(jobs: Parameters<typeof createJobRuntime>[0]["jobs"], extra = {}): JobRuntime {
  return createJobRuntime({
    db: db.app,
    connection,
    log,
    jobs,
    prefix: `test-${randomUUID()}`,
    backoffMs: 10,
    pollIntervalMs: 50,
    ...extra,
  })
}

describe("enqueueJob", () => {
  it("is idempotent per queue and key", async () => {
    const first = await withTenant(db.app, { tenantId: tenant }, (trx) =>
      enqueueJob(trx, {
        queue: "maintenance",
        type: "test.noop",
        tenantId: tenant,
        payload: {},
        idempotencyKey: "k1",
      }),
    )
    const second = await withTenant(db.app, { tenantId: tenant }, (trx) =>
      enqueueJob(trx, {
        queue: "maintenance",
        type: "test.noop",
        tenantId: tenant,
        payload: {},
        idempotencyKey: "k1",
      }),
    )
    expect(first.created).toBe(true)
    expect(second).toEqual({ id: first.id, created: false })
  })

  it("is not recorded if the business transaction rolls back", async () => {
    await expect(
      withTenant(db.app, { tenantId: tenant }, async (trx) => {
        await enqueueJob(trx, {
          queue: "maintenance",
          type: "test.noop",
          tenantId: tenant,
          payload: {},
          idempotencyKey: "rolled-back",
        })
        throw new Error("business failure")
      }),
    ).rejects.toThrow()
    const row = await db.owner
      .selectFrom("job_records")
      .select("id")
      .where("idempotency_key", "=", "rolled-back")
      .executeTakeFirst()
    expect(row).toBeUndefined()
  })

  it("tenants cannot enqueue for another tenant or modify job state", async () => {
    await expect(
      withTenant(db.app, { tenantId: tenant }, (trx) =>
        enqueueJob(trx, { queue: "maintenance", type: "test.noop", tenantId: null, payload: {} }),
      ),
    ).rejects.toThrow(/row-level security/)
    const result = await withTenant(db.app, { tenantId: tenant }, (trx) =>
      trx.updateTable("job_records").set({ status: "succeeded" }).executeTakeFirst(),
    )
    expect(result.numUpdatedRows).toBe(0n)
  })
})

describe("job runtime", () => {
  it("runs a job end to end and ignores duplicate deliveries", async () => {
    const seen: string[] = []
    const job = defineJob({
      type: "test.record",
      queue: "maintenance",
      payload: z.object({ value: z.string() }),
      async run({ payload }) {
        seen.push(payload.value)
      },
    })
    const runtime = runtimeWith([job])
    const { id } = await withTenant(db.app, { tenantId: tenant }, (trx) =>
      enqueueJob(trx, {
        queue: "maintenance",
        type: job.type,
        tenantId: tenant,
        payload: { value: "a" },
      }),
    )
    runtime.start()
    try {
      await waitFor(async () => (await statusOf(id)).status === "succeeded")
      // Simulate a duplicate delivery (e.g. dispatched twice after a crash).
      await runtime.process({ data: { jobRecordId: id } } as never)
      expect(seen).toEqual(["a"])
      expect(await statusOf(id)).toMatchObject({ attempts: 1, last_error: null })
    } finally {
      await runtime.stop()
    }
  })

  it("retries with backoff, then dead-letters with the error visible to the tenant", async () => {
    let calls = 0
    const job = defineJob({
      type: "test.flaky",
      queue: "maintenance",
      payload: z.object({}),
      maxAttempts: 3,
      async run() {
        calls++
        throw new Error("upstream unavailable")
      },
    })
    const runtime = runtimeWith([job])
    const { id } = await withTenant(db.app, { tenantId: tenant }, (trx) =>
      enqueueJob(trx, {
        queue: "maintenance",
        type: job.type,
        tenantId: tenant,
        payload: {},
        maxAttempts: 3,
      }),
    )
    runtime.start()
    try {
      await waitFor(async () => (await statusOf(id)).status === "dead")
      expect(calls).toBe(3)
      const visible = await withTenant(db.app, { tenantId: tenant }, (trx) =>
        trx
          .selectFrom("job_records")
          .select(["status", "last_error"])
          .where("id", "=", id)
          .executeTakeFirst(),
      )
      expect(visible).toEqual({ status: "dead", last_error: "Error: upstream unavailable" })
    } finally {
      await runtime.stop()
    }
  })

  it("dead-letters permanent failures and invalid payloads without retrying", async () => {
    let calls = 0
    const job = defineJob({
      type: "test.permanent",
      queue: "maintenance",
      payload: z.object({ n: z.number() }),
      async run() {
        calls++
        throw new PermanentJobError("mapping is ambiguous")
      },
    })
    const runtime = runtimeWith([job])
    const [ok, invalid] = await withSystem(db.app, "test", async (trx) => [
      await enqueueJob(trx, {
        queue: "maintenance",
        type: job.type,
        tenantId: tenant,
        payload: { n: 1 },
      }),
      await enqueueJob(trx, {
        queue: "maintenance",
        type: job.type,
        tenantId: tenant,
        payload: { n: "x" },
      }),
    ])
    runtime.start()
    try {
      await waitFor(
        async () =>
          (await statusOf(ok!.id)).status === "dead" &&
          (await statusOf(invalid!.id)).status === "dead",
      )
      expect(calls).toBe(1)
      expect((await statusOf(invalid!.id)).last_error).toMatch(/payload failed validation/)
    } finally {
      await runtime.stop()
    }
  })

  it("fans outbox events out to subscribed jobs exactly once", async () => {
    const received: unknown[] = []
    const job = defineJob({
      type: "test.on_connector_degraded",
      queue: "notifications",
      payload: z.object({ eventId: z.string().uuid(), connectorId: z.string() }),
      async run({ payload, correlationId }) {
        received.push({ ...payload, correlationId })
      },
    })
    const runtime = runtimeWith([job], { subscriptions: [{ event: "ConnectorDegraded", job }] })
    await withTenant(db.app, { tenantId: tenant }, (trx) =>
      emitEvent(trx, {
        type: "ConnectorDegraded",
        tenantId: tenant,
        aggregate: { type: "connector", id: "c1" },
        payload: { connectorId: "c1" },
        correlationId: "corr-1",
      }),
    )
    runtime.start()
    try {
      await waitFor(async () => received.length === 1)
      await runtime.dispatchOutbox()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(received).toEqual([
        { eventId: expect.any(String), connectorId: "c1", correlationId: "corr-1" },
      ])
    } finally {
      await runtime.stop()
    }
  })

  it("recovers jobs from PostgreSQL when Redis loses them", async () => {
    let ran = false
    const job = defineJob({
      type: "test.survives_redis_loss",
      queue: "maintenance",
      payload: z.object({}),
      async run() {
        ran = true
      },
    })
    const prefix = `test-${randomUUID()}`
    const runtime = runtimeWith([job], { prefix, staleAfterMs: 0 })
    const { id } = await withSystem(db.app, "test", (trx) =>
      enqueueJob(trx, { queue: "maintenance", type: job.type, tenantId: null, payload: {} }),
    )
    expect(await runtime.dispatchJobs()).toBeGreaterThanOrEqual(1)

    // Redis data loss: delete everything under this runtime's prefix.
    const keys = await redis.keys(`${prefix}:*`)
    if (keys.length) await redis.del(...keys)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await runtime.reconcile()).toBe(1)
    runtime.start()
    try {
      await waitFor(async () => (await statusOf(id)).status === "succeeded")
      expect(ran).toBe(true)
    } finally {
      await runtime.stop()
    }
  })
})

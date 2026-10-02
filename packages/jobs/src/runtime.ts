import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from "bullmq"
import { sql, withSystem, type Db, type QueueName } from "@platform/db"
import type { Logger } from "@platform/shared"
import { PermanentJobError, type EventSubscription, type JobDefinition } from "./definitions"
import { enqueueJob } from "./enqueue"

export interface JobRuntimeOptions {
  db: Db
  connection: ConnectionOptions
  log: Logger
  jobs: JobDefinition[]
  subscriptions?: EventSubscription[]
  /** BullMQ key prefix (isolates environments and tests). */
  prefix?: string
  concurrency?: number
  /** Base delay for exponential retry backoff. */
  backoffMs?: number
  pollIntervalMs?: number
  /** Dispatched jobs untouched for this long are checked against Redis and re-dispatched if lost. */
  staleAfterMs?: number
  batchSize?: number
}

interface BullPayload {
  jobRecordId: string
}

const MAX_ERROR_LENGTH = 2000

function describeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return message.slice(0, MAX_ERROR_LENGTH)
}

/**
 * Worker runtime (dev bible §104–106, D-003).
 *
 *   job_records (PostgreSQL, source of truth)
 *        │  dispatcher: undispatched rows → BullMQ (jobId = row id)
 *        ▼
 *   BullMQ / Redis (delivery, retries with backoff, stalled-job recovery)
 *        │  processor: idempotent — succeeded/dead rows are skipped
 *        ▼
 *   handler → status written back to job_records (running / retrying / succeeded / dead)
 *
 * Domain events in outbox_events are fanned out into job_records by the same
 * dispatcher. If Redis loses data, the reconciler re-dispatches from PostgreSQL.
 */
export function createJobRuntime(options: JobRuntimeOptions) {
  const { db, connection, log } = options
  const prefix = options.prefix ?? "platform"
  const backoffMs = options.backoffMs ?? 5_000
  const batchSize = options.batchSize ?? 100
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000

  const definitions = new Map<string, JobDefinition>()
  for (const job of options.jobs) {
    if (definitions.has(job.type)) throw new Error(`Duplicate job type ${job.type}`)
    definitions.set(job.type, job)
  }
  const queueNames = [...new Set(options.jobs.map((job) => job.queue))]
  const queues = new Map<QueueName, Queue<BullPayload>>(
    queueNames.map((name) => [name, new Queue<BullPayload>(name, { connection, prefix })]),
  )
  const workers: Worker<BullPayload>[] = []
  let timer: NodeJS.Timeout | undefined
  let reconcileTimer: NodeJS.Timeout | undefined
  let ticking = false

  async function process(job: Job<BullPayload>) {
    const id = job.data.jobRecordId
    const record = await withSystem(db, "jobs.claim", async (trx) => {
      const row = await trx
        .selectFrom("job_records")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst()
      if (!row || row.status === "succeeded" || row.status === "dead") return null
      return trx
        .updateTable("job_records")
        .set({ status: "running", attempts: row.attempts + 1, started_at: new Date() })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow()
    })
    if (!record) return // Already finished: duplicate delivery is a no-op (§71).

    const jobLog = log.child({
      jobId: record.id,
      jobType: record.job_type,
      tenantId: record.tenant_id,
      correlationId: record.correlation_id,
      attempt: record.attempts,
    })
    try {
      const definition = definitions.get(record.job_type)
      if (!definition) throw new PermanentJobError(`No handler for job type ${record.job_type}`)
      const parsed = definition.payload.safeParse(record.payload)
      if (!parsed.success) throw new PermanentJobError("Job payload failed validation")
      await definition.run({
        jobId: record.id,
        tenantId: record.tenant_id,
        correlationId: record.correlation_id,
        attempt: record.attempts,
        payload: parsed.data,
        db,
        log: jobLog,
      })
      await withSystem(db, "jobs.complete", (trx) =>
        trx
          .updateTable("job_records")
          .set({ status: "succeeded", finished_at: new Date(), last_error: null })
          .where("id", "=", id)
          .execute(),
      )
    } catch (error) {
      const permanent = error instanceof PermanentJobError
      const final = permanent || record.attempts >= record.max_attempts
      await withSystem(db, "jobs.fail", (trx) =>
        trx
          .updateTable("job_records")
          .set({
            status: final ? "dead" : "retrying",
            last_error: describeError(error),
            ...(final ? { finished_at: new Date() } : {}),
          })
          .where("id", "=", id)
          .execute(),
      )
      jobLog.warn(final ? "job dead-lettered" : "job failed; will retry", {
        error: describeError(error),
      })
      if (final) throw new UnrecoverableError(describeError(error))
      throw error
    }
  }

  /** Fans unpublished outbox events into job records. */
  async function dispatchOutbox(): Promise<number> {
    const subscriptions = options.subscriptions ?? []
    return withSystem(db, "jobs.outbox", async (trx) => {
      const events = await trx
        .selectFrom("outbox_events")
        .selectAll()
        .where("published_at", "is", null)
        .orderBy("seq")
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute()
      for (const event of events) {
        for (const subscription of subscriptions.filter((s) => s.event === event.event_type)) {
          await enqueueJob(trx, {
            queue: subscription.job.queue,
            type: subscription.job.type,
            tenantId: event.tenant_id,
            payload: { eventId: event.id, ...(event.payload as Record<string, unknown>) },
            idempotencyKey: `event:${event.id}:${subscription.job.type}`,
            correlationId: event.correlation_id,
            ...(subscription.job.maxAttempts ? { maxAttempts: subscription.job.maxAttempts } : {}),
          })
        }
        await trx
          .updateTable("outbox_events")
          .set({ published_at: new Date() })
          .where("id", "=", event.id)
          .execute()
      }
      return events.length
    })
  }

  /** Pushes undispatched job records to BullMQ. Safe to repeat: jobId dedupes. */
  async function dispatchJobs(): Promise<number> {
    return withSystem(db, "jobs.dispatch", async (trx) => {
      const rows = await trx
        .selectFrom("job_records")
        .select(["id", "queue", "job_type", "max_attempts", "attempts"])
        .where("dispatched_at", "is", null)
        .where("status", "in", ["queued", "retrying"])
        .where("run_after", "<=", sql<Date>`now()`)
        .where("queue", "in", queueNames.length ? queueNames : ["maintenance"])
        .orderBy("run_after")
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute()
      for (const row of rows) {
        const queue = queues.get(row.queue)
        if (!queue) continue
        await queue.add(
          row.job_type,
          { jobRecordId: row.id },
          {
            jobId: row.id,
            attempts: Math.max(1, row.max_attempts - row.attempts),
            backoff: { type: "exponential", delay: backoffMs },
            removeOnComplete: { age: 24 * 3600, count: 10_000 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        )
        await trx
          .updateTable("job_records")
          .set({ dispatched_at: new Date() })
          .where("id", "=", row.id)
          .execute()
      }
      return rows.length
    })
  }

  /**
   * Re-dispatches unfinished jobs that Redis no longer knows about (e.g. Redis
   * restarted without persistence). PostgreSQL remains the source of truth.
   */
  async function reconcile(): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs)
    const candidates = await withSystem(db, "jobs.reconcile", (trx) =>
      trx
        .selectFrom("job_records")
        .select(["id", "queue"])
        .where("dispatched_at", "is not", null)
        .where("status", "in", ["queued", "running", "retrying"])
        .where("updated_at", "<", cutoff)
        .limit(batchSize)
        .execute(),
    )
    let reset = 0
    for (const candidate of candidates) {
      const queue = queues.get(candidate.queue)
      if (!queue) continue
      const existing = await queue.getJob(candidate.id)
      if (existing && !(await existing.isFailed())) continue
      if (existing) await existing.remove()
      await withSystem(db, "jobs.reconcile", (trx) =>
        trx
          .updateTable("job_records")
          .set({
            dispatched_at: null,
            status: "retrying",
            last_error: "re-dispatched by reconciler",
          })
          .where("id", "=", candidate.id)
          .where("status", "in", ["queued", "running", "retrying"])
          .execute(),
      )
      reset++
    }
    if (reset) log.warn("reconciler re-dispatched lost jobs", { count: reset })
    return reset
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await dispatchOutbox()
      await dispatchJobs()
    } catch (error) {
      log.error("dispatcher tick failed", { error: describeError(error) })
    } finally {
      ticking = false
    }
  }

  return {
    queues,
    process,
    dispatchOutbox,
    dispatchJobs,
    reconcile,
    tick,

    /** Starts BullMQ workers for every queue that has handlers, plus the dispatcher loop. */
    start() {
      for (const name of queueNames) {
        const worker = new Worker<BullPayload>(name, (job) => process(job), {
          connection,
          prefix,
          concurrency: options.concurrency ?? 4,
        })
        worker.on("error", (error) =>
          log.error("bullmq worker error", { queue: name, error: describeError(error) }),
        )
        workers.push(worker)
      }
      const interval = options.pollIntervalMs ?? 1_000
      timer = setInterval(() => void tick(), interval)
      reconcileTimer = setInterval(
        () => void reconcile().catch(() => {}),
        Math.max(interval * 60, 60_000),
      )
      log.info("job runtime started", { queues: queueNames })
    },

    async stop() {
      if (timer) clearInterval(timer)
      if (reconcileTimer) clearInterval(reconcileTimer)
      await Promise.all(workers.map((worker) => worker.close()))
      await Promise.all([...queues.values()].map((queue) => queue.close()))
    },
  }
}

export type JobRuntime = ReturnType<typeof createJobRuntime>

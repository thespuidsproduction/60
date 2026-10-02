import { Redis } from "ioredis"
import { enqueueDueSyncs } from "@platform/connectors"
import { createDb, sql } from "@platform/db"
import { createJobRuntime } from "@platform/jobs"
import { createLogger } from "@platform/shared"
import { loadWorkerConfig } from "./config"
import { startHealthServer } from "./health"
import { workerJobs } from "./jobs"

const config = loadWorkerConfig()
const log = createLogger({
  level: config.LOG_LEVEL,
  base: { service: "worker", env: config.APP_ENV },
})

const db = createDb({ connectionString: config.DATABASE_URL, applicationName: "worker" })
// BullMQ requires maxRetriesPerRequest: null on its connections.
const connection = { url: config.REDIS_URL, maxRetriesPerRequest: null }
const probe = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
probe.on("error", () => {})

const { jobs, subscriptions } = workerJobs()
const runtime = createJobRuntime({
  db,
  connection,
  log,
  jobs,
  subscriptions,
  prefix: config.APP_ENV,
})

const dependencies = { database: false, redis: false }
async function checkDependencies() {
  dependencies.database = await sql`select 1`
    .execute(db)
    .then(() => true)
    .catch(() => false)
  dependencies.redis = await probe
    .ping()
    .then(() => true)
    .catch(() => false)
}

let running = true
const health = startHealthServer(
  config.WORKER_HEALTH_PORT,
  () => running && dependencies.database && dependencies.redis,
)

await checkDependencies()
const dependencyTimer = setInterval(() => void checkDependencies(), 15_000)
const scheduleTimer = setInterval(() => {
  enqueueDueSyncs(db, { intervalMs: config.CONNECTOR_SYNC_INTERVAL_MS }).catch((error) =>
    log.error("connector scheduling failed", { error }),
  )
}, 60_000)
runtime.start()
log.info("worker started", { healthPort: config.WORKER_HEALTH_PORT, dependencies })

async function shutdown(signal: string) {
  if (!running) return
  running = false
  log.info("worker shutting down", { signal })
  clearInterval(dependencyTimer)
  clearInterval(scheduleTimer)
  await runtime.stop().catch((error) => log.error("runtime stop failed", { error }))
  await db.destroy()
  probe.disconnect()
  health.close()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

import { createLogger } from "@platform/shared"
import { loadWorkerConfig } from "./config"
import { startHealthServer } from "./health"

const config = loadWorkerConfig()
const log = createLogger({
  level: config.LOG_LEVEL,
  base: { service: "worker", env: config.APP_ENV },
})

let running = true
const health = startHealthServer(config.WORKER_HEALTH_PORT, () => running)
log.info("worker started", { healthPort: config.WORKER_HEALTH_PORT })

async function shutdown(signal: string) {
  if (!running) return
  running = false
  log.info("worker shutting down", { signal })
  health.close()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

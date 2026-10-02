import { createLogger } from "@platform/shared"
import { migrate } from "../migrator"

const log = createLogger({ base: { service: "migrate" } })
const url = process.env.DATABASE_MIGRATION_URL
if (!url) {
  log.error("DATABASE_MIGRATION_URL is not set")
  process.exit(1)
}

try {
  const result = await migrate(url, { log: (message) => log.info(message) })
  log.info("migrations complete", {
    applied: result.applied,
    alreadyApplied: result.alreadyApplied.length,
  })
} catch (error) {
  log.error("migration failed", { error })
  process.exit(1)
}

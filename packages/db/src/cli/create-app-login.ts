import pg from "pg"
import { createLogger } from "@platform/shared"

/**
 * Creates (or updates the password of) the application's login role, a member
 * of `platform_app`, so the app connects without superuser or BYPASSRLS.
 * Run once per environment as the database owner:
 *
 *   DATABASE_MIGRATION_URL=... APP_DB_USER=platform_app_login APP_DB_PASSWORD=... \
 *     pnpm --filter @platform/db create-app-login
 */
const log = createLogger({ base: { service: "create-app-login" } })
const url = process.env.DATABASE_MIGRATION_URL
const user = process.env.APP_DB_USER ?? "platform_app_login"
const password = process.env.APP_DB_PASSWORD

if (!url || !password || !/^[a-z_][a-z0-9_]{0,62}$/.test(user)) {
  log.error("DATABASE_MIGRATION_URL, APP_DB_PASSWORD and a valid APP_DB_USER are required")
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const quotedPassword = client.escapeLiteral(password)
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user])
  if (rowCount) {
    await client.query(
      `ALTER ROLE ${user} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${quotedPassword}`,
    )
  } else {
    await client.query(
      `CREATE ROLE ${user} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${quotedPassword}`,
    )
  }
  await client.query(`GRANT platform_app TO ${user}`)
  log.info("application login ready", { user })
} finally {
  await client.end()
}

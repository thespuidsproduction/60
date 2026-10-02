import { randomBytes } from "node:crypto"
import pg from "pg"
import { createDb, type Db } from "./client"
import { migrate } from "./migrator"

/**
 * Integration-test harness: creates an isolated, migrated database per call.
 *
 * `app` connects as a non-superuser member of `platform_app`, exactly like the
 * production application, so row-level security is exercised for real.
 * `owner` connects as the migration owner (bypasses RLS) for assertions.
 */
export interface TestDatabase {
  name: string
  app: Db
  owner: Db
  appUrl: string
  ownerUrl: string
  destroy(): Promise<void>
}

const APP_LOGIN = "platform_app_test"
const APP_PASSWORD = "platform-app-test-only"

export function testAdminUrl(): string {
  return (
    process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://platform:platform@127.0.0.1:5432/platform"
  )
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  if (user) parsed.username = user
  if (password) parsed.password = password
  return parsed.toString()
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testAdminUrl()
  const name = `platform_test_${randomBytes(6).toString("hex")}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }

  const ownerUrl = withDatabase(adminUrl, name)
  await migrate(ownerUrl)

  const owner = new pg.Client({ connectionString: ownerUrl })
  await owner.connect()
  try {
    await owner.query(`
      DO $$
      BEGIN
        CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE platform_app;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END
      $$;`)
    await owner.query(`GRANT CONNECT ON DATABASE ${name} TO ${APP_LOGIN}`)
  } finally {
    await owner.end()
  }

  const appUrl = withDatabase(adminUrl, name, APP_LOGIN, APP_PASSWORD)
  const app = createDb({ connectionString: appUrl, maxConnections: 4, applicationName: "test-app" })
  const ownerDb = createDb({
    connectionString: ownerUrl,
    maxConnections: 2,
    applicationName: "test-owner",
  })

  return {
    name,
    app,
    owner: ownerDb,
    appUrl,
    ownerUrl,
    async destroy() {
      await app.destroy()
      await ownerDb.destroy()
      const client = new pg.Client({ connectionString: adminUrl })
      await client.connect()
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await client.end()
      }
    },
  }
}

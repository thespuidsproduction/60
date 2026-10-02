import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import pg from "pg"

export const defaultMigrationsDir = new URL("../migrations/", import.meta.url).pathname

export interface MigrationFile {
  name: string
  sql: string
  checksum: string
}

export async function loadMigrations(dir = defaultMigrationsDir): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8")
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") }
    }),
  )
}

export interface MigrateResult {
  applied: string[]
  alreadyApplied: string[]
}

/**
 * Applies pending SQL migrations in order, each in its own transaction (§125).
 * Applied migrations are immutable: a changed checksum aborts the run, because
 * editing history in place would make environments silently diverge.
 */
export async function migrate(
  connectionString: string,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => {})
  const migrations = await loadMigrations(options.dir)
  const client = new pg.Client({ connectionString, application_name: "platform-migrate" })
  await client.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`)
    // Serialise concurrent migrators.
    await client.query("SELECT pg_advisory_lock(hashtext('platform.schema_migrations'))")

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    )
    const applied = new Map(rows.map((row) => [row.name, row.checksum]))

    for (const [name] of applied) {
      if (!migrations.some((m) => m.name === name)) {
        throw new Error(`Applied migration ${name} is missing from the migrations directory`)
      }
    }

    const result: MigrateResult = { applied: [], alreadyApplied: [] }
    for (const migration of migrations) {
      const existing = applied.get(migration.name)
      if (existing) {
        if (existing !== migration.checksum) {
          throw new Error(`Migration ${migration.name} was modified after being applied`)
        }
        result.alreadyApplied.push(migration.name)
        continue
      }
      log(`applying ${migration.name}`)
      await client.query("BEGIN")
      try {
        await client.query(migration.sql)
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          migration.name,
          migration.checksum,
        ])
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        })
      }
      result.applied.push(migration.name)
    }
    return result
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('platform.schema_migrations'))")
      .catch(() => {})
    await client.end()
  }
}

import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"
import type { Database } from "./schema"

// Return bigint/int8 as string to avoid silent precision loss.
pg.types.setTypeParser(20, (value) => value)

export type Db = Kysely<Database>

export interface CreateDbOptions {
  connectionString: string
  maxConnections?: number
  applicationName?: string
}

export function createDb(options: CreateDbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "platform",
  })
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

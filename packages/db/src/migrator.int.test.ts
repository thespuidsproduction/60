import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { migrate } from "./migrator"
import { testAdminUrl } from "./testing"

let url: string
let name: string

beforeAll(async () => {
  name = `platform_migrator_${Date.now()}`
  const admin = new pg.Client({ connectionString: testAdminUrl() })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const parsed = new URL(testAdminUrl())
  parsed.pathname = `/${name}`
  url = parsed.toString()
})

afterAll(async () => {
  const admin = new pg.Client({ connectionString: testAdminUrl() })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.end()
})

describe("migrate", () => {
  it("applies once, is idempotent, and refuses edited or missing history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-"))
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id int);")
    expect((await migrate(url, { dir })).applied).toEqual(["0001_a.sql"])
    expect((await migrate(url, { dir })).applied).toEqual([])

    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id bigint);")
    await expect(migrate(url, { dir })).rejects.toThrow(/modified after being applied/)

    const empty = await mkdtemp(join(tmpdir(), "migrations-"))
    await expect(migrate(url, { dir: empty })).rejects.toThrow(/missing from the migrations/)
  })

  it("rolls back a failing migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-"))
    // 0001_a is already applied by the previous test; keep it identical.
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id int);")
    await writeFile(join(dir, "0002_b.sql"), "CREATE TABLE b (id int); SELECT broken_syntax(;")
    await expect(migrate(url, { dir })).rejects.toThrow(/0002_b.sql failed/)
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    const { rows } = await client.query("select to_regclass('b') as t")
    await client.end()
    expect(rows[0].t).toBeNull()
  })
})

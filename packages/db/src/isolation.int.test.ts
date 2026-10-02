import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "kysely"
import { withSystem, withTenant } from "./context"
import { createTestDatabase, type TestDatabase } from "./testing"

/**
 * Mandatory cross-tenant isolation tests (dev bible §91, §126).
 */
let db: TestDatabase
let tenantA: string
let tenantB: string
let userA: string
let userB: string

beforeAll(async () => {
  db = await createTestDatabase()
  const seeded = await withSystem(db.app, "test.seed", async (trx) => {
    const [a, b] = await trx
      .insertInto("organisations")
      .values([
        { slug: "tenant-a", name: "Tenant A" },
        { slug: "tenant-b", name: "Tenant B" },
      ])
      .returning("id")
      .execute()
    const [ua, ub] = await trx
      .insertInto("users")
      .values([
        { email: "a@a.example", display_name: "User A" },
        { email: "b@b.example", display_name: "User B" },
      ])
      .returning("id")
      .execute()
    await trx
      .insertInto("memberships")
      .values([
        { tenant_id: a!.id, user_id: ua!.id, role: "ADMIN" },
        { tenant_id: b!.id, user_id: ub!.id, role: "ADMIN" },
      ])
      .execute()
    await trx
      .insertInto("audit_entries")
      .values([
        { tenant_id: a!.id, actor_type: "system", actor_label: "seed", action: "test.seed" },
        { tenant_id: b!.id, actor_type: "system", actor_label: "seed", action: "test.seed" },
        { tenant_id: null, actor_type: "system", actor_label: "seed", action: "platform.seed" },
      ])
      .execute()
    return { a: a!.id, b: b!.id, ua: ua!.id, ub: ub!.id }
  })
  tenantA = seeded.a
  tenantB = seeded.b
  userA = seeded.ua
  userB = seeded.ub
})

afterAll(async () => {
  await db?.destroy()
})

describe("tenant isolation (RLS)", () => {
  it("application role is not a superuser and cannot bypass RLS", async () => {
    const { rows } = await sql<{
      rolsuper: boolean
      rolbypassrls: boolean
    }>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(db.app)
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
  })

  it("sees nothing without a tenant or system context", async () => {
    expect(await db.app.selectFrom("organisations").selectAll().execute()).toHaveLength(0)
    expect(await db.app.selectFrom("memberships").selectAll().execute()).toHaveLength(0)
    expect(await db.app.selectFrom("users").selectAll().execute()).toHaveLength(0)
    expect(await db.app.selectFrom("audit_entries").selectAll().execute()).toHaveLength(0)
  })

  it("restricts reads to the current tenant", async () => {
    await withTenant(db.app, { tenantId: tenantA }, async (trx) => {
      const orgs = await trx.selectFrom("organisations").select("id").execute()
      expect(orgs.map((o) => o.id)).toEqual([tenantA])
      const members = await trx.selectFrom("memberships").select("tenant_id").execute()
      expect(members.every((m) => m.tenant_id === tenantA)).toBe(true)
      const users = await trx.selectFrom("users").select("id").execute()
      expect(users.map((u) => u.id)).toEqual([userA])
      const audit = await trx.selectFrom("audit_entries").select("tenant_id").execute()
      expect(audit).toEqual([{ tenant_id: tenantA }])
    })
  })

  it("rejects writes into another tenant", async () => {
    await expect(
      withTenant(db.app, { tenantId: tenantA }, (trx) =>
        trx
          .insertInto("memberships")
          .values({ tenant_id: tenantB, user_id: userA, role: "VIEWER" })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/)

    await expect(
      withTenant(db.app, { tenantId: tenantA }, (trx) =>
        trx
          .insertInto("audit_entries")
          .values({ tenant_id: tenantB, actor_type: "system", actor_label: "x", action: "test.x" })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it("cannot update another tenant's rows (silently matches zero rows)", async () => {
    const result = await withTenant(db.app, { tenantId: tenantA }, (trx) =>
      trx
        .updateTable("memberships")
        .set({ role: "VIEWER" })
        .where("user_id", "=", userB)
        .executeTakeFirst(),
    )
    expect(result.numUpdatedRows).toBe(0n)
  })

  it("does not leak tenant context across pooled connections", async () => {
    await withTenant(db.app, { tenantId: tenantA }, async () => {})
    expect(await db.app.selectFrom("organisations").selectAll().execute()).toHaveLength(0)
  })

  it("tenant users cannot change organisations or create tenants", async () => {
    await expect(
      withTenant(db.app, { tenantId: tenantA }, (trx) =>
        trx.insertInto("organisations").values({ slug: "evil", name: "Evil" }).execute(),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it("sessions and backup codes are system-only", async () => {
    await withTenant(db.app, { tenantId: tenantA, userId: userA }, async (trx) => {
      expect(await trx.selectFrom("sessions").selectAll().execute()).toHaveLength(0)
      expect(await trx.selectFrom("user_backup_codes").selectAll().execute()).toHaveLength(0)
    })
  })
})

describe("audit log is append-only", () => {
  it("rejects UPDATE and DELETE even in system scope", async () => {
    await expect(
      withSystem(db.app, "test", (trx) =>
        trx.updateTable("audit_entries").set({ reason: "tampered" }).execute(),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withSystem(db.app, "test", (trx) => trx.deleteFrom("audit_entries").execute()),
    ).rejects.toThrow(/permission denied/)
  })

  it("rejects UPDATE, DELETE and TRUNCATE even for the owner", async () => {
    await expect(
      db.owner.updateTable("audit_entries").set({ reason: "tampered" }).execute(),
    ).rejects.toThrow(/append-only/)
    await expect(db.owner.deleteFrom("audit_entries").execute()).rejects.toThrow(/append-only/)
    await expect(sql`truncate audit_entries`.execute(db.owner)).rejects.toThrow(/append-only/)
  })
})

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withSystem } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import { createFeatureService, FeatureUnavailableError } from "./service"

let db: TestDatabase
let tenant: string
const actor = { type: "internal_employee" as const, label: "father@internal" }

beforeAll(async () => {
  db = await createTestDatabase()
  tenant = await withSystem(db.app, "test", async (trx) => {
    const row = await trx
      .insertInto("organisations")
      .values({ slug: "acme", name: "Acme" })
      .returning("id")
      .executeTakeFirstOrThrow()
    return row.id
  })
})

afterAll(async () => {
  await db?.destroy()
})

describe("feature service", () => {
  it("guards unreleased features and exposes them after a change, with audit", async () => {
    const features = createFeatureService({ db: db.app, environment: "test" })
    const viewer = { tenantId: tenant, internal: false }

    await expect(features.require("reports.print", viewer)).rejects.toBeInstanceOf(
      FeatureUnavailableError,
    )
    await expect(features.require("reports.print", viewer)).rejects.toThrow(
      "Functionality is currently in development.",
    )

    await features.setState({
      key: "reports.print",
      tenantId: tenant,
      state: "ON",
      actor,
      reason: "pilot",
    })
    expect((await features.require("reports.print", viewer)).source).toBe("tenant")

    await features.setState({
      key: "reports.print",
      tenantId: tenant,
      state: "OFF",
      actor,
      reason: "rollback",
    })
    expect((await features.resolve("reports.print", viewer)).enabled).toBe(false)

    await features.setState({
      key: "reports.print",
      tenantId: tenant,
      state: null,
      actor,
      reason: "reset",
    })
    expect((await features.resolve("reports.print", viewer)).source).toBe("default")

    const audit = await db.owner
      .selectFrom("audit_entries")
      .select(["action", "old_state", "new_state", "reason"])
      .where("action", "=", "feature.state_changed")
      .orderBy("seq")
      .execute()
    expect(audit.map((a) => [a.old_state, a.new_state, a.reason])).toEqual([
      [{ state: null }, { state: "ON" }, "pilot"],
      [{ state: "ON" }, { state: "OFF" }, "rollback"],
      [{ state: "OFF" }, { state: null }, "reset"],
    ])
  })

  it("keeps environments separate and rejects unknown keys or empty reasons", async () => {
    const staging = createFeatureService({ db: db.app, environment: "staging" })
    const test = createFeatureService({ db: db.app, environment: "test" })
    await staging.setState({
      key: "portal.customer",
      tenantId: null,
      state: "ON",
      actor,
      reason: "staging trial",
    })
    expect(
      (await staging.resolve("portal.customer", { tenantId: null, internal: false })).enabled,
    ).toBe(true)
    expect(
      (await test.resolve("portal.customer", { tenantId: null, internal: false })).enabled,
    ).toBe(false)

    await expect(
      test.setState({ key: "nope", tenantId: null, state: "ON", actor, reason: "x" }),
    ).rejects.toThrow(/Unknown feature/)
    await expect(
      test.setState({ key: "portal.customer", tenantId: null, state: "ON", actor, reason: " " }),
    ).rejects.toThrow(/reason/)
  })
})

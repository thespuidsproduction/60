import { randomBytes } from "node:crypto"
import { generate } from "otplib"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withSystem } from "@platform/db"
import { createTestDatabase, type TestDatabase } from "@platform/db/testing"
import { createSecretBox, parseKeyRing } from "@platform/shared"
import { provisionOrganisation } from "./provisioning"
import { createAuthService, type AuthService } from "./service"

let db: TestDatabase
let clock: Date
let auth: AuthService
const PASSWORD = "a long enough test password"
const box = createSecretBox(parseKeyRing(`k1:${randomBytes(32).toString("base64")}`))
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms))
const epoch = () => Math.floor(clock.getTime() / 1000)

let tenantA: string
let tenantB: string

beforeAll(async () => {
  db = await createTestDatabase()
  const actor = { type: "system" as const, label: "test" }
  const a = await provisionOrganisation(db.app, {
    slug: "acme",
    name: "Acme MSP",
    admin: { email: "Admin@Acme.example", displayName: "Admin", password: PASSWORD },
    actor,
    reason: "test",
  })
  tenantA = a.organisation.id
  const b = await provisionOrganisation(db.app, {
    slug: "other",
    name: "Other MSP",
    admin: { email: "multi@example.com", displayName: "Multi", password: PASSWORD, role: "VIEWER" },
    actor,
    reason: "test",
  })
  tenantB = b.organisation.id
  // multi@ is a member of both tenants.
  await withSystem(db.app, "test", (trx) =>
    trx
      .insertInto("memberships")
      .values({ tenant_id: tenantA, user_id: b.userId, role: "SECOPS" })
      .execute(),
  )
})

afterAll(async () => {
  await db?.destroy()
})

beforeEach(() => {
  clock = new Date("2026-10-02T12:00:00Z")
  auth = createAuthService({ db: db.app, secretBox: box, now: () => clock })
})

async function auditActions(): Promise<string[]> {
  const rows = await db.owner.selectFrom("audit_entries").select("action").orderBy("seq").execute()
  return rows.map((r) => r.action)
}

describe("login", () => {
  it("signs in with a case-insensitive email and selects the only workspace", async () => {
    const result = await auth.login("admin@acme.example", PASSWORD, { ip: "203.0.113.5" })
    expect(result).toMatchObject({ mfaRequired: false, tenantId: tenantA })
    const ctx = await auth.resolveSession(result.token)
    expect(ctx).toMatchObject({ state: "active", tenantId: tenantA, role: "ADMIN" })
    expect(ctx!.permissions.has("users:manage")).toBe(true)
    expect(await auditActions()).toContain("auth.login_succeeded")
  })

  it("returns the same error for unknown accounts and wrong passwords", async () => {
    await expect(auth.login("nobody@example.com", PASSWORD)).rejects.toThrow(
      "Invalid email or password.",
    )
    await expect(auth.login("admin@acme.example", "wrong password here")).rejects.toThrow(
      "Invalid email or password.",
    )
  })

  it("requires workspace selection for multi-tenant users and rejects foreign tenants", async () => {
    const result = await auth.login("multi@example.com", PASSWORD)
    expect(result.tenantId).toBeNull()
    let ctx = await auth.resolveSession(result.token)
    expect(ctx).toMatchObject({ tenantId: null, role: null })
    expect((await auth.listWorkspaces(ctx!)).map((w) => w.slug)).toEqual(["acme", "other"])

    await auth.selectTenant(ctx!, tenantB)
    ctx = await auth.resolveSession(result.token)
    expect(ctx).toMatchObject({ tenantId: tenantB, role: "VIEWER" })

    const outsider = await provisionOrganisation(db.app, {
      slug: "outsider",
      name: "Outsider",
      admin: { email: "out@example.com", displayName: "Out", password: PASSWORD },
      actor: { type: "system", label: "test" },
      reason: "test",
    })
    await expect(auth.selectTenant(ctx!, outsider.organisation.id)).rejects.toThrow(/permission/)
  })

  it("locks the account after repeated failures, even for the right password", async () => {
    await provisionOrganisation(db.app, {
      slug: "lock-test",
      name: "Lock Test",
      admin: { email: "lock@example.com", displayName: "Lock", password: PASSWORD },
      actor: { type: "system", label: "test" },
      reason: "test",
    })
    for (let i = 0; i < 5; i++) {
      await expect(auth.login("lock@example.com", "not the password!")).rejects.toThrow()
    }
    await expect(auth.login("lock@example.com", PASSWORD)).rejects.toThrow(
      "Invalid email or password.",
    )
    advance(16 * 60 * 1000)
    await expect(auth.login("lock@example.com", PASSWORD)).resolves.toMatchObject({
      mfaRequired: false,
    })
  })
})

describe("sessions", () => {
  it("expire after idle timeout and absolute lifetime, and on logout", async () => {
    const idle = await auth.login("admin@acme.example", PASSWORD)
    advance(31 * 60 * 1000)
    expect(await auth.resolveSession(idle.token)).toBeNull()

    const absolute = await auth.login("admin@acme.example", PASSWORD)
    for (let i = 0; i < 25; i++) {
      advance(29 * 60 * 1000)
      if (!(await auth.resolveSession(absolute.token))) break
    }
    expect(await auth.resolveSession(absolute.token)).toBeNull()

    const loggedOut = await auth.login("admin@acme.example", PASSWORD)
    await auth.logout(loggedOut.token)
    expect(await auth.resolveSession(loggedOut.token)).toBeNull()
  })

  it("loses role immediately when the membership is revoked", async () => {
    const created = await provisionOrganisation(db.app, {
      slug: "revoke-test",
      name: "Revoke Test",
      admin: { email: "revoke@example.com", displayName: "R", password: PASSWORD },
      actor: { type: "system", label: "test" },
      reason: "test",
    })
    const login = await auth.login("revoke@example.com", PASSWORD)
    expect((await auth.resolveSession(login.token))?.role).toBe("ADMIN")
    await withSystem(db.app, "test", (trx) =>
      trx
        .updateTable("memberships")
        .set({ revoked_at: clock })
        .where("user_id", "=", created.userId)
        .execute(),
    )
    expect(await auth.resolveSession(login.token)).toMatchObject({ role: null, tenantId: null })
  })

  it("rejects garbage tokens without touching the database shape", async () => {
    expect(await auth.resolveSession("not-a-token")).toBeNull()
    expect(await auth.resolveSession(undefined)).toBeNull()
  })
})

describe("MFA", () => {
  it("enrols, then requires TOTP at login, rejects replay, and accepts single-use backup codes", async () => {
    await provisionOrganisation(db.app, {
      slug: "mfa-test",
      name: "MFA Test",
      admin: { email: "mfa@example.com", displayName: "M", password: PASSWORD },
      actor: { type: "system", label: "test" },
      reason: "test",
    })
    const first = await auth.login("mfa@example.com", PASSWORD)
    const ctx = (await auth.resolveSession(first.token))!
    const { secret, uri } = await auth.beginTotpEnrollment(ctx)
    expect(uri).toMatch(/^otpauth:\/\/totp\//)

    const stored = await db.owner
      .selectFrom("users")
      .select("totp_secret_enc")
      .where("email", "=", "mfa@example.com")
      .executeTakeFirstOrThrow()
    expect(stored.totp_secret_enc).not.toContain(secret)

    await expect(auth.confirmTotpEnrollment(ctx, "000000")).rejects.toThrow(/Invalid verification/)
    const backupCodes = await auth.confirmTotpEnrollment(
      ctx,
      await generate({ secret, epoch: epoch() }),
    )
    expect(backupCodes).toHaveLength(10)

    advance(60_000)
    const second = await auth.login("mfa@example.com", PASSWORD)
    expect(second.mfaRequired).toBe(true)
    expect(await auth.resolveSession(second.token)).toMatchObject({
      state: "mfa_pending",
      role: null,
    })

    const code = await generate({ secret, epoch: epoch() })
    await auth.verifyMfa(second.token, code)
    expect(await auth.resolveSession(second.token)).toMatchObject({
      state: "active",
      role: "ADMIN",
    })

    // The same code cannot be replayed on another pending session.
    const third = await auth.login("mfa@example.com", PASSWORD)
    await expect(auth.verifyMfa(third.token, code)).rejects.toThrow(/Invalid verification/)

    await auth.verifyMfa(third.token, backupCodes[0]!)
    const fourth = await auth.login("mfa@example.com", PASSWORD)
    await expect(auth.verifyMfa(fourth.token, backupCodes[0]!)).rejects.toThrow(
      /Invalid verification/,
    )
  })

  it("step-up requires password and second factor and opens a time-limited window", async () => {
    await provisionOrganisation(db.app, {
      slug: "stepup-test",
      name: "Step-up Test",
      admin: { email: "stepup@example.com", displayName: "S", password: PASSWORD },
      actor: { type: "system", label: "test" },
      reason: "test",
    })
    const login = await auth.login("stepup@example.com", PASSWORD)
    let ctx = (await auth.resolveSession(login.token))!
    await expect(auth.stepUp(ctx, PASSWORD, "000000")).rejects.toThrow(/Multi-factor/)

    const { secret } = await auth.beginTotpEnrollment(ctx)
    await auth.confirmTotpEnrollment(ctx, await generate({ secret, epoch: epoch() }))
    advance(11 * 60 * 1000)
    ctx = (await auth.resolveSession(login.token))!
    await expect(auth.regenerateBackupCodes(ctx)).rejects.toThrow(/Confirm your identity/)

    advance(30_000)
    await expect(
      auth.stepUp(ctx, "wrong password!!", await generate({ secret, epoch: epoch() })),
    ).rejects.toThrow()
    await auth.stepUp(ctx, PASSWORD, await generate({ secret, epoch: epoch() }))
    ctx = (await auth.resolveSession(login.token))!
    expect(await auth.regenerateBackupCodes(ctx)).toHaveLength(10)
    expect(await auditActions()).toEqual(
      expect.arrayContaining([
        "auth.step_up_failed",
        "auth.step_up_succeeded",
        "auth.backup_codes_regenerated",
      ]),
    )
  })
})

describe("password change", () => {
  it("revokes the user's other sessions", async () => {
    await provisionOrganisation(db.app, {
      slug: "pw-test",
      name: "PW Test",
      admin: { email: "pw@example.com", displayName: "P", password: PASSWORD },
      actor: { type: "system", label: "test" },
      reason: "test",
    })
    const keep = await auth.login("pw@example.com", PASSWORD)
    const other = await auth.login("pw@example.com", PASSWORD)
    const ctx = (await auth.resolveSession(keep.token))!
    await auth.changePassword(ctx, PASSWORD, "a brand new long password")
    expect(await auth.resolveSession(keep.token)).not.toBeNull()
    expect(await auth.resolveSession(other.token)).toBeNull()
    await expect(auth.login("pw@example.com", PASSWORD)).rejects.toThrow()
    await expect(auth.login("pw@example.com", "a brand new long password")).resolves.toBeTruthy()
  })
})

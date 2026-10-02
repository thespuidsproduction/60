import { generate } from "otplib"
import { describe, expect, it } from "vitest"
import { generateBackupCodes, hashBackupCode, looksLikeBackupCode } from "./backup-codes"
import { AuthError } from "./errors"
import { assertPasswordPolicy, hashPassword, passwordNeedsRehash, verifyPassword } from "./password"
import { permissionsForRole, rolePermissions, stepUpPermissions } from "./permissions"
import { authorize, type AuthContext } from "./service"
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from "./tokens"
import { checkTotp, createTotpSecret } from "./totp"

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple")
    expect(hash).toMatch(/^scrypt\$17\$8\$1\$/)
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true)
    expect(await verifyPassword("wrong horse battery staple", hash)).toBe(false)
    expect(passwordNeedsRehash(hash)).toBe(false)
    expect(passwordNeedsRehash("scrypt$14$8$1$a$b")).toBe(true)
  })

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false)
    expect(await verifyPassword("x", "scrypt$40$8$1$AA$AA")).toBe(false)
  })

  it("enforces a length policy", () => {
    expect(() => assertPasswordPolicy("short")).toThrow(AuthError)
    expect(() => assertPasswordPolicy("x".repeat(257))).toThrow(AuthError)
    expect(() => assertPasswordPolicy("twelve chars")).not.toThrow()
  })
})

describe("session tokens", () => {
  it("are 256-bit opaque strings hashed with SHA-256", () => {
    const token = generateSessionToken()
    expect(isWellFormedSessionToken(token)).toBe(true)
    expect(hashSessionToken(token)).toHaveLength(32)
    expect(generateSessionToken()).not.toBe(token)
    expect(isWellFormedSessionToken("short")).toBe(false)
  })
})

describe("TOTP", () => {
  it("verifies current codes and rejects replay", async () => {
    const secret = createTotpSecret()
    const epoch = 1_800_000_000
    const code = await generate({ secret, epoch })
    const first = await checkTotp({ secret, code, epochSeconds: epoch })
    expect(first.valid).toBe(true)
    if (!first.valid) return
    const replay = await checkTotp({
      secret,
      code,
      epochSeconds: epoch,
      lastTimeStep: first.timeStep,
    })
    expect(replay.valid).toBe(false)
  })

  it("rejects codes outside the skew window and malformed input", async () => {
    const secret = createTotpSecret()
    const code = await generate({ secret, epoch: 1_800_000_000 })
    expect((await checkTotp({ secret, code, epochSeconds: 1_800_000_000 + 120 })).valid).toBe(false)
    expect((await checkTotp({ secret, code: "12345a" })).valid).toBe(false)
  })
})

describe("backup codes", () => {
  it("generates distinct high-entropy codes and hashes normalised input", () => {
    const codes = generateBackupCodes()
    expect(new Set(codes).size).toBe(10)
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
    expect(looksLikeBackupCode(codes[0]!)).toBe(true)
    expect(hashBackupCode(codes[0]!.toLowerCase().replaceAll("-", " "))).toBe(
      hashBackupCode(codes[0]!),
    )
  })
})

describe("RBAC", () => {
  const ctx = (overrides: Partial<AuthContext> = {}): AuthContext => ({
    sessionId: "s",
    userId: "u",
    email: "u@example.com",
    displayName: "U",
    state: "active",
    mfaEnrolled: true,
    reauthenticatedAt: null,
    tenantId: "t",
    role: "SECOPS",
    permissions: permissionsForRole("SECOPS"),
    ...overrides,
  })

  it("every role's permissions are known and VIEWER is minimal", () => {
    expect(rolePermissions.VIEWER).toEqual(["incident:view", "report:view"])
    expect(rolePermissions.AUDITOR).not.toContain("evidence:export")
    expect(rolePermissions.ADMIN).not.toContain("evidence:view")
  })

  it("authorises permitted actions and returns the tenant", () => {
    expect(authorize(ctx(), "incident:create")).toBe("t")
  })

  it("rejects missing session, pending MFA, missing tenant, and missing permission", () => {
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return (error as AuthError).code
      }
      return "none"
    }
    expect(code(() => authorize(null, "incident:view"))).toBe("SESSION_INVALID")
    expect(code(() => authorize(ctx({ state: "mfa_pending" }), "incident:view"))).toBe(
      "MFA_REQUIRED",
    )
    expect(code(() => authorize(ctx({ tenantId: null, role: null }), "incident:view"))).toBe(
      "NO_TENANT_SELECTED",
    )
    expect(code(() => authorize(ctx(), "users:manage"))).toBe("FORBIDDEN")
  })

  it("requires recent step-up and enrolled MFA for dangerous permissions", () => {
    const now = new Date("2026-10-02T12:00:00Z")
    const admin = { role: "ADMIN" as const, permissions: permissionsForRole("ADMIN") }
    expect(stepUpPermissions.has("users:manage")).toBe(true)
    expect(() => authorize(ctx(admin), "users:manage", { now })).toThrow(/Confirm your identity/)
    expect(() => authorize(ctx({ ...admin, mfaEnrolled: false }), "users:manage", { now })).toThrow(
      /Multi-factor/,
    )
    const recent = new Date(now.getTime() - 60_000)
    expect(authorize(ctx({ ...admin, reauthenticatedAt: recent }), "users:manage", { now })).toBe(
      "t",
    )
    const stale = new Date(now.getTime() - 11 * 60_000)
    expect(() =>
      authorize(ctx({ ...admin, reauthenticatedAt: stale }), "users:manage", { now }),
    ).toThrow()
  })
})

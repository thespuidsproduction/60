import { recordAudit, type AuditRequestContext } from "@platform/audit"
import { withSystem, type CustomerRole, type Db, type Tx, type User } from "@platform/db"
import type { SecretBox } from "@platform/shared"
import { hashBackupCode, generateBackupCodes, looksLikeBackupCode } from "./backup-codes"
import { AuthError } from "./errors"
import {
  assertPasswordPolicy,
  hashPassword,
  passwordNeedsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from "./password"
import { permissionsForRole, stepUpPermissions, type Permission } from "./permissions"
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from "./tokens"
import { checkTotp, createTotpSecret, totpUri } from "./totp"

export interface AuthConfig {
  /** Absolute session lifetime after full sign-in. */
  sessionTtlMs: number
  /** Session expires after this much inactivity. */
  idleTimeoutMs: number
  /** Lifetime of a session waiting for its MFA code. */
  mfaPendingTtlMs: number
  /** How long a step-up re-authentication authorises dangerous actions. */
  stepUpWindowMs: number
  /** Failed attempts before the account is temporarily locked. */
  lockoutThreshold: number
  lockoutDurationMs: number
  totpIssuer: string
}

export const defaultAuthConfig: AuthConfig = {
  sessionTtlMs: 12 * 60 * 60 * 1000,
  idleTimeoutMs: 30 * 60 * 1000,
  mfaPendingTtlMs: 10 * 60 * 1000,
  stepUpWindowMs: 10 * 60 * 1000,
  lockoutThreshold: 5,
  lockoutDurationMs: 15 * 60 * 1000,
  totpIssuer: "Platform",
}

/** Server-side identity for one request. Resolved from the opaque session token. */
export interface AuthContext {
  sessionId: string
  userId: string
  email: string
  displayName: string
  state: "active" | "mfa_pending"
  mfaEnrolled: boolean
  reauthenticatedAt: Date | null
  tenantId: string | null
  role: CustomerRole | null
  permissions: ReadonlySet<Permission>
}

export interface LoginResult {
  token: string
  sessionId: string
  mfaRequired: boolean
  tenantId: string | null
}

export interface AuthServiceOptions {
  db: Db
  secretBox: SecretBox
  config?: Partial<AuthConfig>
  now?: () => Date
}

const TOUCH_INTERVAL_MS = 60 * 1000

function actorFor(user: Pick<User, "id" | "email">) {
  return { type: "user" as const, id: user.id, label: user.email }
}

export function createAuthService(options: AuthServiceOptions) {
  const { db, secretBox } = options
  const config: AuthConfig = { ...defaultAuthConfig, ...options.config }
  const now = options.now ?? (() => new Date())
  const totpAad = (userId: string) => `totp:${userId}`

  async function findSessionRow(trx: Tx, token: string) {
    if (!isWellFormedSessionToken(token)) return undefined
    return trx
      .selectFrom("sessions")
      .selectAll()
      .where("token_hash", "=", hashSessionToken(token))
      .executeTakeFirst()
  }

  async function activeMemberships(trx: Tx, userId: string) {
    return trx
      .selectFrom("memberships")
      .innerJoin("organisations", "organisations.id", "memberships.tenant_id")
      .select([
        "memberships.tenant_id",
        "memberships.role",
        "organisations.name",
        "organisations.slug",
      ])
      .where("memberships.user_id", "=", userId)
      .where("memberships.revoked_at", "is", null)
      .where("organisations.status", "=", "active")
      .orderBy("organisations.name")
      .execute()
  }

  /** Records a failed attempt and applies the temporary lockout. */
  async function registerFailure(trx: Tx, user: User, at: Date) {
    const failures = user.failed_login_count + 1
    const lock = failures >= config.lockoutThreshold
    await trx
      .updateTable("users")
      .set({
        failed_login_count: lock ? 0 : failures,
        locked_until: lock ? new Date(at.getTime() + config.lockoutDurationMs) : user.locked_until,
      })
      .where("id", "=", user.id)
      .execute()
    return lock
  }

  async function checkSecondFactor(
    trx: Tx,
    user: User,
    code: string,
    at: Date,
  ): Promise<"totp" | "backup_code" | null> {
    if (!user.totp_secret_enc || !user.totp_enabled_at) return null
    if (looksLikeBackupCode(code)) {
      const used = await trx
        .updateTable("user_backup_codes")
        .set({ used_at: at })
        .where("user_id", "=", user.id)
        .where("code_hash", "=", hashBackupCode(code))
        .where("used_at", "is", null)
        .returning("id")
        .executeTakeFirst()
      return used ? "backup_code" : null
    }
    const secret = secretBox.decrypt(user.totp_secret_enc, totpAad(user.id))
    const result = await checkTotp({
      secret,
      code,
      lastTimeStep: user.totp_last_step == null ? null : Number(user.totp_last_step),
      epochSeconds: Math.floor(at.getTime() / 1000),
    })
    if (!result.valid) return null
    await trx
      .updateTable("users")
      .set({ totp_last_step: result.timeStep })
      .where("id", "=", user.id)
      .execute()
    return "totp"
  }

  return {
    config,

    /**
     * Password sign-in. Always fails with the same error for unknown, disabled,
     * locked or wrong-password accounts; the reason is recorded in the audit log.
     */
    async login(
      email: string,
      password: string,
      request: AuditRequestContext = {},
    ): Promise<LoginResult> {
      const at = now()
      const outcome = await withSystem(db, "auth.login", async (trx) => {
        const user = await trx
          .selectFrom("users")
          .selectAll()
          .where((eb) => eb(eb.fn("lower", ["email"]), "=", email.trim().toLowerCase()))
          .executeTakeFirst()

        const fail = async (reason: string, target?: User) => {
          await recordAudit(trx, {
            tenantId: null,
            actor: target ? actorFor(target) : { type: "user", label: email.slice(0, 254) },
            action: "auth.login_failed",
            ...(target ? { target: { type: "user", id: target.id } } : {}),
            reason,
            request,
          })
          return { ok: false as const }
        }

        if (!user || !user.password_hash) {
          await verifyAgainstDummy(password)
          return fail(user ? "no_password_set" : "unknown_account")
        }
        if (user.status !== "active") {
          await verifyAgainstDummy(password)
          return fail("account_disabled", user)
        }
        if (user.locked_until && user.locked_until > at) {
          await verifyAgainstDummy(password)
          return fail("account_locked", user)
        }
        if (!(await verifyPassword(password, user.password_hash))) {
          const locked = await registerFailure(trx, user, at)
          return fail(locked ? "wrong_password_account_locked" : "wrong_password", user)
        }

        const rehash = passwordNeedsRehash(user.password_hash)
          ? await hashPassword(password)
          : user.password_hash
        await trx
          .updateTable("users")
          .set({ failed_login_count: 0, locked_until: null, password_hash: rehash })
          .where("id", "=", user.id)
          .execute()

        const mfaRequired = Boolean(user.totp_enabled_at)
        const memberships = await activeMemberships(trx, user.id)
        const tenantId = memberships.length === 1 ? memberships[0]!.tenant_id : null
        const token = generateSessionToken()
        const ttl = mfaRequired ? config.mfaPendingTtlMs : config.sessionTtlMs
        const session = await trx
          .insertInto("sessions")
          .values({
            token_hash: hashSessionToken(token),
            user_id: user.id,
            tenant_id: tenantId,
            created_at: at,
            last_seen_at: at,
            expires_at: new Date(at.getTime() + ttl),
            ip: request.ip ?? null,
            user_agent: request.userAgent?.slice(0, 512) ?? null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()

        await recordAudit(trx, {
          tenantId: null,
          actor: actorFor(user),
          action: mfaRequired ? "auth.password_verified" : "auth.login_succeeded",
          target: { type: "session", id: session.id },
          request: { ...request, sessionId: session.id },
        })
        return {
          ok: true as const,
          result: { token, sessionId: session.id, mfaRequired, tenantId },
        }
      })
      if (!outcome.ok) throw new AuthError("INVALID_CREDENTIALS")
      return outcome.result
    },

    /** Completes sign-in for an MFA-pending session with a TOTP or backup code. */
    async verifyMfa(token: string, code: string, request: AuditRequestContext = {}): Promise<void> {
      const at = now()
      const outcome = await withSystem(db, "auth.mfa", async (trx) => {
        const session = await findSessionRow(trx, token)
        if (!session || session.revoked_at || session.expires_at <= at || session.mfa_verified_at) {
          return "invalid_session" as const
        }
        const user = await trx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", session.user_id)
          .executeTakeFirstOrThrow()
        const audit = { ...request, sessionId: session.id }

        const method = await checkSecondFactor(trx, user, code, at)
        if (!method) {
          const locked = await registerFailure(trx, user, at)
          if (locked) {
            await trx
              .updateTable("sessions")
              .set({ revoked_at: at, revoked_reason: "mfa_lockout" })
              .where("id", "=", session.id)
              .execute()
          }
          await recordAudit(trx, {
            tenantId: null,
            actor: actorFor(user),
            action: "auth.mfa_failed",
            target: { type: "session", id: session.id },
            reason: locked ? "account_locked" : "invalid_code",
            request: audit,
          })
          return "invalid_code" as const
        }

        await trx
          .updateTable("users")
          .set({ failed_login_count: 0, locked_until: null })
          .where("id", "=", user.id)
          .execute()
        await trx
          .updateTable("sessions")
          .set({
            mfa_verified_at: at,
            last_seen_at: at,
            expires_at: new Date(at.getTime() + config.sessionTtlMs),
          })
          .where("id", "=", session.id)
          .execute()
        await recordAudit(trx, {
          tenantId: null,
          actor: actorFor(user),
          action: "auth.login_succeeded",
          target: { type: "session", id: session.id },
          newState: { method },
          request: audit,
        })
        return "ok" as const
      })
      if (outcome === "invalid_session") throw new AuthError("SESSION_INVALID")
      if (outcome === "invalid_code") throw new AuthError("MFA_INVALID")
    },

    /**
     * Resolves the opaque token into a server-side identity. Returns null for
     * missing, revoked, expired, idle, or disabled-user sessions. Role and
     * permissions are re-read from the active membership on every request, so
     * revoking a membership takes effect immediately.
     */
    async resolveSession(token: string | undefined | null): Promise<AuthContext | null> {
      if (!token) return null
      const at = now()
      return withSystem(db, "auth.resolve", async (trx) => {
        const session = await findSessionRow(trx, token)
        if (!session || session.revoked_at || session.expires_at <= at) return null
        if (at.getTime() - session.last_seen_at.getTime() > config.idleTimeoutMs) return null

        const user = await trx
          .selectFrom("users")
          .select(["id", "email", "display_name", "status", "totp_enabled_at"])
          .where("id", "=", session.user_id)
          .executeTakeFirst()
        if (!user || user.status !== "active") return null

        const mfaEnrolled = Boolean(user.totp_enabled_at)
        const state = mfaEnrolled && !session.mfa_verified_at ? "mfa_pending" : "active"

        let role: CustomerRole | null = null
        if (session.tenant_id && state === "active") {
          const membership = await trx
            .selectFrom("memberships")
            .innerJoin("organisations", "organisations.id", "memberships.tenant_id")
            .select("memberships.role")
            .where("memberships.user_id", "=", user.id)
            .where("memberships.tenant_id", "=", session.tenant_id)
            .where("memberships.revoked_at", "is", null)
            .where("organisations.status", "=", "active")
            .executeTakeFirst()
          role = membership?.role ?? null
        }

        if (at.getTime() - session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
          await trx
            .updateTable("sessions")
            .set({ last_seen_at: at })
            .where("id", "=", session.id)
            .execute()
        }

        return {
          sessionId: session.id,
          userId: user.id,
          email: user.email,
          displayName: user.display_name,
          state,
          mfaEnrolled,
          reauthenticatedAt: session.reauthenticated_at,
          tenantId: role ? session.tenant_id : null,
          role,
          permissions: role ? permissionsForRole(role) : new Set<Permission>(),
        }
      })
    },

    async listWorkspaces(ctx: AuthContext) {
      return withSystem(db, "auth.workspaces", (trx) => activeMemberships(trx, ctx.userId))
    },

    async selectTenant(ctx: AuthContext, tenantId: string, request: AuditRequestContext = {}) {
      requireActive(ctx)
      await withSystem(db, "auth.select_tenant", async (trx) => {
        const memberships = await activeMemberships(trx, ctx.userId)
        if (!memberships.some((m) => m.tenant_id === tenantId)) throw new AuthError("FORBIDDEN")
        await trx
          .updateTable("sessions")
          .set({ tenant_id: tenantId })
          .where("id", "=", ctx.sessionId)
          .execute()
        await recordAudit(trx, {
          tenantId,
          actor: { type: "user", id: ctx.userId, label: ctx.email },
          action: "auth.tenant_selected",
          target: { type: "session", id: ctx.sessionId },
          request: { ...request, sessionId: ctx.sessionId },
        })
      })
    },

    async logout(token: string, request: AuditRequestContext = {}) {
      const at = now()
      await withSystem(db, "auth.logout", async (trx) => {
        const session = await findSessionRow(trx, token)
        if (!session || session.revoked_at) return
        await trx
          .updateTable("sessions")
          .set({ revoked_at: at, revoked_reason: "logout" })
          .where("id", "=", session.id)
          .execute()
        await recordAudit(trx, {
          tenantId: null,
          actor: { type: "user", id: session.user_id, label: session.user_id },
          action: "auth.logout",
          target: { type: "session", id: session.id },
          request: { ...request, sessionId: session.id },
        })
      })
    },

    /**
     * Step-up re-authentication for dangerous actions (§107). Requires the
     * password and, for every user, a second factor: users without MFA must
     * enrol before they can perform step-up-protected actions.
     */
    async stepUp(
      ctx: AuthContext,
      password: string,
      code: string,
      request: AuditRequestContext = {},
    ) {
      requireActive(ctx)
      if (!ctx.mfaEnrolled) throw new AuthError("MFA_ENROLLMENT_REQUIRED")
      const at = now()
      const ok = await withSystem(db, "auth.step_up", async (trx) => {
        const user = await trx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", ctx.userId)
          .executeTakeFirstOrThrow()
        const audit = { ...request, sessionId: ctx.sessionId }
        const passwordOk = user.password_hash
          ? await verifyPassword(password, user.password_hash)
          : false
        const factor = passwordOk ? await checkSecondFactor(trx, user, code, at) : null
        if (!passwordOk || !factor) {
          await registerFailure(trx, user, at)
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actor: actorFor(user),
            action: "auth.step_up_failed",
            target: { type: "session", id: ctx.sessionId },
            request: audit,
          })
          return false
        }
        await trx
          .updateTable("sessions")
          .set({ reauthenticated_at: at })
          .where("id", "=", ctx.sessionId)
          .execute()
        await recordAudit(trx, {
          tenantId: ctx.tenantId,
          actor: actorFor(user),
          action: "auth.step_up_succeeded",
          target: { type: "session", id: ctx.sessionId },
          newState: { method: factor },
          request: audit,
        })
        return true
      })
      if (!ok) throw new AuthError("INVALID_CREDENTIALS")
    },

    /** Starts TOTP enrolment. The secret is stored encrypted but inactive until confirmed. */
    async beginTotpEnrollment(ctx: AuthContext) {
      requireActive(ctx)
      if (ctx.mfaEnrolled) throw new AuthError("MFA_ALREADY_ENROLLED")
      const secret = createTotpSecret()
      await withSystem(db, "auth.totp_enroll", (trx) =>
        trx
          .updateTable("users")
          .set({
            totp_secret_enc: secretBox.encrypt(secret, totpAad(ctx.userId)),
            totp_last_step: null,
          })
          .where("id", "=", ctx.userId)
          .where("totp_enabled_at", "is", null)
          .execute(),
      )
      return {
        secret,
        uri: totpUri({ issuer: config.totpIssuer, accountLabel: ctx.email, secret }),
      }
    },

    /** Confirms enrolment with a first valid code; returns one-time backup codes. */
    async confirmTotpEnrollment(ctx: AuthContext, code: string, request: AuditRequestContext = {}) {
      requireActive(ctx)
      const at = now()
      const codes = await withSystem(db, "auth.totp_confirm", async (trx) => {
        const user = await trx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", ctx.userId)
          .executeTakeFirstOrThrow()
        if (user.totp_enabled_at) throw new AuthError("MFA_ALREADY_ENROLLED")
        if (!user.totp_secret_enc) throw new AuthError("MFA_INVALID")
        const result = await checkTotp({
          secret: secretBox.decrypt(user.totp_secret_enc, totpAad(user.id)),
          code,
          epochSeconds: Math.floor(at.getTime() / 1000),
        })
        if (!result.valid) return null
        await trx
          .updateTable("users")
          .set({ totp_enabled_at: at, totp_last_step: result.timeStep })
          .where("id", "=", user.id)
          .execute()
        const backupCodes = await replaceBackupCodes(trx, user.id, at)
        await trx
          .updateTable("sessions")
          .set({ mfa_verified_at: at, reauthenticated_at: at })
          .where("id", "=", ctx.sessionId)
          .execute()
        await recordAudit(trx, {
          tenantId: ctx.tenantId,
          actor: actorFor(user),
          action: "auth.mfa_enrolled",
          target: { type: "user", id: user.id },
          request: { ...request, sessionId: ctx.sessionId },
        })
        return backupCodes
      })
      if (!codes) throw new AuthError("MFA_INVALID")
      return codes
    },

    /** Issues a new set of backup codes, invalidating the old ones. Requires step-up. */
    async regenerateBackupCodes(ctx: AuthContext, request: AuditRequestContext = {}) {
      requireActive(ctx)
      if (!ctx.mfaEnrolled) throw new AuthError("MFA_ENROLLMENT_REQUIRED")
      requireStepUp(ctx, config, now())
      return withSystem(db, "auth.backup_codes", async (trx) => {
        const codes = await replaceBackupCodes(trx, ctx.userId, now())
        await recordAudit(trx, {
          tenantId: ctx.tenantId,
          actor: { type: "user", id: ctx.userId, label: ctx.email },
          action: "auth.backup_codes_regenerated",
          target: { type: "user", id: ctx.userId },
          request: { ...request, sessionId: ctx.sessionId },
        })
        return codes
      })
    },

    async changePassword(
      ctx: AuthContext,
      currentPassword: string,
      newPassword: string,
      request: AuditRequestContext = {},
    ) {
      requireActive(ctx)
      assertPasswordPolicy(newPassword)
      const at = now()
      const ok = await withSystem(db, "auth.change_password", async (trx) => {
        const user = await trx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", ctx.userId)
          .executeTakeFirstOrThrow()
        if (!user.password_hash || !(await verifyPassword(currentPassword, user.password_hash))) {
          await registerFailure(trx, user, at)
          return false
        }
        await trx
          .updateTable("users")
          .set({ password_hash: await hashPassword(newPassword) })
          .where("id", "=", user.id)
          .execute()
        // Revoke every other session for this user.
        await trx
          .updateTable("sessions")
          .set({ revoked_at: at, revoked_reason: "password_changed" })
          .where("user_id", "=", user.id)
          .where("id", "!=", ctx.sessionId)
          .where("revoked_at", "is", null)
          .execute()
        await recordAudit(trx, {
          tenantId: ctx.tenantId,
          actor: actorFor(user),
          action: "auth.password_changed",
          target: { type: "user", id: user.id },
          request: { ...request, sessionId: ctx.sessionId },
        })
        return true
      })
      if (!ok) throw new AuthError("INVALID_CREDENTIALS")
    },
  }

  async function replaceBackupCodes(trx: Tx, userId: string, at: Date) {
    await trx
      .updateTable("user_backup_codes")
      .set({ used_at: at })
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .execute()
    const codes = generateBackupCodes()
    await trx
      .insertInto("user_backup_codes")
      .values(codes.map((code) => ({ user_id: userId, code_hash: hashBackupCode(code) })))
      .execute()
    return codes
  }
}

export type AuthService = ReturnType<typeof createAuthService>

function requireActive(ctx: AuthContext) {
  if (ctx.state !== "active") throw new AuthError("MFA_REQUIRED")
}

export function requireStepUp(
  ctx: AuthContext,
  config: Pick<AuthConfig, "stepUpWindowMs">,
  at: Date,
) {
  if (
    !ctx.reauthenticatedAt ||
    at.getTime() - ctx.reauthenticatedAt.getTime() > config.stepUpWindowMs
  ) {
    throw new AuthError("STEP_UP_REQUIRED")
  }
}

/**
 * Server-side authorisation check for tenant-scoped permissions (§27, §64).
 * Returns the tenant ID the caller is authorised for, for use with withTenant().
 */
export function authorize(
  ctx: AuthContext | null,
  permission: Permission,
  options: { config?: Pick<AuthConfig, "stepUpWindowMs">; now?: Date } = {},
): string {
  if (!ctx) throw new AuthError("SESSION_INVALID")
  requireActive(ctx)
  if (!ctx.tenantId || !ctx.role) throw new AuthError("NO_TENANT_SELECTED")
  if (!ctx.permissions.has(permission)) throw new AuthError("FORBIDDEN")
  if (stepUpPermissions.has(permission)) {
    if (!ctx.mfaEnrolled) throw new AuthError("MFA_ENROLLMENT_REQUIRED")
    requireStepUp(ctx, options.config ?? defaultAuthConfig, options.now ?? new Date())
  }
  return ctx.tenantId
}

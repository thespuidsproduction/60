import "server-only"
import { authorize, AuthError, type AuthContext, type Permission } from "@platform/auth"
import { withTenant } from "@platform/db"
import { services } from "./services"
import { currentAuth } from "./session"

/**
 * Server-side authorisation for a tenant-scoped permission (§27, §64).
 * Returns the identity and the tenant the caller is authorised for.
 */
export async function requirePermission(
  permission: Permission,
): Promise<{ ctx: AuthContext; tenantId: string }> {
  const ctx = await currentAuth()
  const tenantId = authorize(ctx, permission, { config: services().auth.config })
  return { ctx: ctx!, tenantId }
}

export async function hasPermission(permission: Permission): Promise<boolean> {
  try {
    await requirePermission(permission)
    return true
  } catch (error) {
    if (error instanceof AuthError) return false
    throw error
  }
}

export async function workspaceName(ctx: AuthContext): Promise<string> {
  if (!ctx.tenantId) return ""
  const org = await withTenant(
    services().db,
    { tenantId: ctx.tenantId, userId: ctx.userId },
    (trx) => trx.selectFrom("organisations").select("name").executeTakeFirst(),
  )
  return org?.name ?? ""
}

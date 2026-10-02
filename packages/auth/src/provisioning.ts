import { recordAudit, type AuditActor } from "@platform/audit"
import { withSystem, type CustomerRole, type Db } from "@platform/db"
import { assertPasswordPolicy, hashPassword } from "./password"

/**
 * Tenant provisioning. Customers are onboarded by internal staff (no public
 * sign-up); this is called from the bootstrap CLI now and from the internal
 * Control Plane later.
 */
export async function provisionOrganisation(
  db: Db,
  input: {
    slug: string
    name: string
    admin: { email: string; displayName: string; password: string; role?: CustomerRole }
    actor: AuditActor
    reason: string
  },
) {
  assertPasswordPolicy(input.admin.password)
  const passwordHash = await hashPassword(input.admin.password)
  return withSystem(db, "provision.organisation", async (trx) => {
    const org = await trx
      .insertInto("organisations")
      .values({ slug: input.slug, name: input.name })
      .returning(["id", "slug", "name"])
      .executeTakeFirstOrThrow()

    const existing = await trx
      .selectFrom("users")
      .select("id")
      .where((eb) => eb(eb.fn("lower", ["email"]), "=", input.admin.email.trim().toLowerCase()))
      .executeTakeFirst()
    const user =
      existing ??
      (await trx
        .insertInto("users")
        .values({
          email: input.admin.email.trim(),
          display_name: input.admin.displayName,
          password_hash: passwordHash,
        })
        .returning("id")
        .executeTakeFirstOrThrow())

    const role = input.admin.role ?? "ADMIN"
    await trx
      .insertInto("memberships")
      .values({ tenant_id: org.id, user_id: user.id, role })
      .execute()

    await recordAudit(trx, {
      tenantId: org.id,
      actor: input.actor,
      action: "tenant.provisioned",
      target: { type: "organisation", id: org.id },
      newState: { slug: org.slug, name: org.name, adminUserId: user.id, adminRole: role },
      reason: input.reason,
    })
    return { organisation: org, userId: user.id, createdUser: !existing }
  })
}

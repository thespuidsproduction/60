import { parseArgs } from "node:util"
import { createDb } from "@platform/db"
import { createLogger } from "@platform/shared"
import { provisionOrganisation } from "../provisioning"

/**
 * Provisions a tenant and its first administrator.
 *
 *   DATABASE_URL=... BOOTSTRAP_ADMIN_PASSWORD=... pnpm --filter @platform/auth bootstrap \
 *     --slug acme --name "Acme MSP" --email admin@acme.example --display-name "Jane Smith" \
 *     --reason "initial onboarding"
 *
 * The password is read from the environment so it never appears in shell history
 * or process listings.
 */
const log = createLogger({ base: { service: "bootstrap" } })
const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    "display-name": { type: "string" },
    reason: { type: "string" },
  },
})

const url = process.env.DATABASE_URL
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
const required = {
  slug: values.slug,
  name: values.name,
  email: values.email,
  reason: values.reason,
}
const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key)
if (!url || !password || missing.length) {
  log.error("missing input", {
    missing: [
      ...missing,
      ...(!url ? ["DATABASE_URL"] : []),
      ...(!password ? ["BOOTSTRAP_ADMIN_PASSWORD"] : []),
    ],
  })
  process.exit(1)
}

const db = createDb({ connectionString: url, applicationName: "bootstrap" })
try {
  const result = await provisionOrganisation(db, {
    slug: values.slug!,
    name: values.name!,
    admin: { email: values.email!, displayName: values["display-name"] ?? values.email!, password },
    actor: { type: "system", label: "bootstrap-cli" },
    reason: values.reason!,
  })
  log.info("tenant provisioned", {
    tenantId: result.organisation.id,
    slug: result.organisation.slug,
    userId: result.userId,
  })
} catch (error) {
  log.error("provisioning failed", { error })
  process.exitCode = 1
} finally {
  await db.destroy()
}

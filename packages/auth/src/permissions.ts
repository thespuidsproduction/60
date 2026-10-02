import type { CustomerRole } from "@platform/db"

/**
 * Customer permissions (dev bible §27). Enforced server-side only (§64).
 * `incident:view` and `audit:view` extend the bible's list; see docs/deviations.md.
 */
export const permissions = [
  "incident:view",
  "incident:create",
  "incident:update",
  "incident:close",
  "incident:approve_report",
  "evidence:view",
  "evidence:export",
  "evidence:verify",
  "integration:manage",
  "report:view",
  "report:approve",
  "users:manage",
  "settings:manage",
  "audit:view",
] as const

export type Permission = (typeof permissions)[number]

export const rolePermissions: Record<CustomerRole, readonly Permission[]> = {
  CISO: [
    "incident:view",
    "incident:create",
    "incident:update",
    "incident:close",
    "incident:approve_report",
    "evidence:view",
    "evidence:export",
    "evidence:verify",
    "report:view",
    "report:approve",
    "audit:view",
  ],
  SECOPS: [
    "incident:view",
    "incident:create",
    "incident:update",
    "incident:close",
    "evidence:view",
    "evidence:verify",
    "report:view",
  ],
  GRC: [
    "incident:view",
    "evidence:view",
    "evidence:export",
    "evidence:verify",
    "report:view",
    "report:approve",
    "audit:view",
  ],
  ADMIN: ["integration:manage", "users:manage", "settings:manage", "report:view", "audit:view"],
  AUDITOR: ["incident:view", "evidence:view", "evidence:verify", "report:view", "audit:view"],
  VIEWER: ["incident:view", "report:view"],
}

/**
 * Permissions whose use requires recent re-authentication (§107): bulk evidence
 * export, integration credential changes, user privilege changes, incident
 * report approval, and settings changes (retention, API keys).
 */
export const stepUpPermissions: ReadonlySet<Permission> = new Set<Permission>([
  "evidence:export",
  "integration:manage",
  "users:manage",
  "settings:manage",
  "incident:approve_report",
  "report:approve",
])

export function permissionsForRole(role: CustomerRole): ReadonlySet<Permission> {
  return new Set(rolePermissions[role])
}

/**
 * Object key layout (dev bible §109). Keys are built from system identifiers
 * only — never user-readable filenames (§109) — and every component is validated.
 *
 *   tenant/{tenant_id}/raw/year=YYYY/month=MM/day=DD/source={source}/{evidence_id}.json
 *   tenant/{tenant_id}/artifacts/{artifact_id}/{object}
 *   tenant/{tenant_id}/quarantine/year=YYYY/month=MM/day=DD/{quarantine_id}.json   (D-015)
 *   tenant/{tenant_id}/manifests/{manifest_id}.json (+ .sig)
 *   tenant/{tenant_id}/exports/{export_id}/{object}
 *   tenant/{tenant_id}/reports/{report_id}/{object}
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SOURCE = /^[a-z0-9][a-z0-9-]{0,62}$/
const OBJECT = /^[a-z0-9][a-z0-9._-]{0,127}$/

function uuid(value: string, label: string) {
  if (!UUID.test(value)) throw new Error(`${label} must be a lowercase UUID`)
  return value
}

function objectName(value: string) {
  if (!OBJECT.test(value) || value.includes("..")) throw new Error("Invalid object name")
  return value
}

const tenantRoot = (tenantId: string) => `tenant/${uuid(tenantId, "tenantId")}`

export function rawEvidenceKey(input: {
  tenantId: string
  source: string
  evidenceId: string
  capturedAt: Date
}): string {
  if (!SOURCE.test(input.source)) throw new Error("Invalid source identifier")
  return `${tenantRoot(input.tenantId)}/raw/${datePath(input.capturedAt)}/source=${input.source}/${uuid(input.evidenceId, "evidenceId")}.json`
}

function datePath(d: Date) {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0")
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const dd = d.getUTCDate().toString().padStart(2, "0")
  return `year=${yyyy}/month=${mm}/day=${dd}`
}

export const quarantineKey = (tenantId: string, quarantineId: string, at: Date) =>
  `${tenantRoot(tenantId)}/quarantine/${datePath(at)}/${uuid(quarantineId, "quarantineId")}.json`

export const manifestSignatureKey = (tenantId: string, manifestId: string) =>
  `${manifestKey(tenantId, manifestId)}.sig`

export const artifactKey = (tenantId: string, artifactId: string, object: string) =>
  `${tenantRoot(tenantId)}/artifacts/${uuid(artifactId, "artifactId")}/${objectName(object)}`

export const manifestKey = (tenantId: string, manifestId: string) =>
  `${tenantRoot(tenantId)}/manifests/${uuid(manifestId, "manifestId")}.json`

export const exportKey = (tenantId: string, exportId: string, object: string) =>
  `${tenantRoot(tenantId)}/exports/${uuid(exportId, "exportId")}/${objectName(object)}`

export const reportKey = (tenantId: string, reportId: string, object: string) =>
  `${tenantRoot(tenantId)}/reports/${uuid(reportId, "reportId")}/${objectName(object)}`

/** True when `key` belongs to `tenantId` — guards every read path. */
export function keyBelongsToTenant(key: string, tenantId: string): boolean {
  return key.startsWith(`${tenantRoot(tenantId)}/`)
}

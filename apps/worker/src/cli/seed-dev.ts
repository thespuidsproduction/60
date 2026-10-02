import { provisionMember } from "@platform/auth"
import { connectIntegration, createConnectorRegistry, runConnectorSync } from "@platform/connectors"
import { fixtureAdapter, startFakeUpstream } from "@platform/connectors/testing"
import { createDb, withSystem } from "@platform/db"
import {
  createEvidenceCapture,
  createTransformerRegistry,
  normaliseEvidence,
  objectStoreFromEnv,
} from "@platform/evidence"
import { fixtureTransformerV1 } from "@platform/evidence/testing"
import { createManifestSigner, registerSigningKeys, sealPendingEvidence } from "@platform/integrity"
import { createLogger, createSecretBox, parseKeyRing } from "@platform/shared"
import { loadWorkerConfig } from "../config"

/**
 * LOCAL ONLY. Seeds a tenant with evidence by running the real pipeline
 * in-process against the reference fixture connector:
 *   fake upstream → connector sync → raw capture (R2) → normalise → seal + sign
 *
 *   pnpm --filter @platform/worker seed-dev -- acme
 */
const config = loadWorkerConfig()
const log = createLogger({ level: config.LOG_LEVEL, base: { service: "seed-dev" } })
if (config.APP_ENV !== "local") {
  log.error("seed-dev only runs with APP_ENV=local")
  process.exit(1)
}
const slug = process.argv.slice(2).find((arg) => arg !== "--") ?? "acme"

const at = (time: string) => `2026-10-02T${time}Z`
const records = [
  {
    id: "sig-0001",
    occurredAt: at("02:14:32"),
    type: "sign_in",
    category: "identity",
    severity: "medium",
    user: "alice@acme.example",
    ip: "185.220.101.4",
    device: "WS-ALICE-01",
    description: "Interactive sign-in from unfamiliar location (Frankfurt, DE)",
  },
  {
    id: "aud-0117",
    occurredAt: at("02:17:24"),
    type: "privilege_change",
    category: "identity",
    severity: "high",
    user: "alice@acme.example",
    ip: "185.220.101.4",
    description: "Role 'Global Administrator' added to alice@acme.example",
  },
  {
    id: "aud-0118",
    occurredAt: at("02:18:51"),
    type: "mfa_method_added",
    category: "identity",
    severity: "high",
    user: "alice@acme.example",
    ip: "185.220.101.4",
    description: "New authenticator app registered for alice@acme.example",
  },
  {
    id: "alr-0129",
    occurredAt: at("02:21:07"),
    type: "security_alert",
    category: "detection",
    severity: "critical",
    user: "alice@acme.example",
    device: "WS-ALICE-01",
    description: "Alert: anomalous token use followed by privilege escalation",
  },
  {
    id: "rmm-0133",
    occurredAt: at("02:23:40"),
    type: "remote_session",
    category: "rmm",
    severity: "high",
    user: "alice@acme.example",
    device: "SRV-ACME-DC01",
    description: "Remote session opened to SRV-ACME-DC01 via RMM",
  },
  {
    id: "rmm-0134",
    occurredAt: at("02:26:12"),
    type: "script_executed",
    category: "rmm",
    severity: "high",
    user: "alice@acme.example",
    device: "SRV-ACME-DC01",
    description: "PowerShell script executed on SRV-ACME-DC01",
  },
  {
    id: "tkt-0141",
    occurredAt: at("02:28:14"),
    type: "ticket_created",
    category: "psa",
    severity: "info",
    user: "jane.smith@acme.example",
    description: "Ticket #8291 created: suspected account compromise",
  },
  {
    id: "aud-0150",
    occurredAt: at("02:39:02"),
    type: "sign_in_blocked",
    category: "identity",
    severity: "medium",
    user: "alice@acme.example",
    ip: "185.220.101.4",
    description: "Sign-in blocked by conditional access policy",
  },
  {
    id: "aud-0155",
    occurredAt: at("02:41:19"),
    type: "account_disabled",
    category: "identity",
    severity: "info",
    user: "alice@acme.example",
    description: "Account alice@acme.example disabled by jane.smith@acme.example",
  },
  {
    id: "aud-0156",
    occurredAt: at("02:42:03"),
    type: "sessions_revoked",
    category: "identity",
    severity: "info",
    user: "alice@acme.example",
    description: "All refresh tokens revoked for alice@acme.example",
  },
  {
    id: "snap-mfa",
    type: "policy_snapshot",
    category: "configuration",
    severity: "info",
    description: "Conditional access policy snapshot: MFA required for administrators",
  },
  { note: "object without an identifier — will be quarantined, never dropped" },
]

const db = createDb({ connectionString: config.DATABASE_URL, applicationName: "seed-dev" })
const store = objectStoreFromEnv()
const upstream = await startFakeUpstream({ records, pageSize: 5, tenantId: "acme-upstream-tenant" })
try {
  const tenant = await withSystem(db, "seed", (trx) =>
    trx.selectFrom("organisations").select("id").where("slug", "=", slug).executeTakeFirstOrThrow(),
  )
  await registerSigningKeys(db, config.MANIFEST_SIGNING_KEYS)
  // A CISO who can view and verify evidence (the bootstrap ADMIN cannot, by design).
  await provisionMember(db, {
    tenantId: tenant.id,
    email: "morgan.hale@acme.example",
    displayName: "Morgan Hale",
    password: process.env.SEED_USER_PASSWORD ?? "local ciso password",
    role: "CISO",
    actor: { type: "system", label: "seed-dev" },
    reason: "local development seed",
  })
  const secretBox = createSecretBox(parseKeyRing(config.DATA_ENCRYPTION_KEYS))
  const registry = createConnectorRegistry([fixtureAdapter])
  const { connectorId } = await connectIntegration(
    { db, secretBox, registry, log },
    {
      tenantId: tenant.id,
      type: "fixture",
      displayName: "Fixture (development)",
      config: { baseUrl: upstream.url, pageSize: 5 },
      credentials: { token: upstream.token },
      actor: { type: "system", label: "seed-dev" },
    },
  )
  const sink = createEvidenceCapture({ db, store, log })
  const summary = await runConnectorSync(
    { db, secretBox, registry, sink, log },
    { connectorId, mode: "baseline" },
  )

  const transformers = createTransformerRegistry([fixtureTransformerV1])
  const raw = await withSystem(db, "seed", (trx) =>
    trx
      .selectFrom("raw_evidence_objects")
      .select("id")
      .where("connector_id", "=", connectorId)
      .execute(),
  )
  for (const row of raw)
    await normaliseEvidence({ db, store, transformers, log }, { evidenceId: row.id })
  const sealed = await sealPendingEvidence(
    { db, store, signer: createManifestSigner(config.MANIFEST_SIGNING_KEYS), log, graceMs: 0 },
    { tenantId: tenant.id },
  )
  log.info("seed complete", { ...summary, manifests: sealed.manifestIds.length })
} finally {
  await upstream.close()
  await db.destroy()
}

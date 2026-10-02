# Infrastructure Notes

Production topology follows dev bible §56: Cloudflare → Hetzner (`web`, `worker`, `redis`
containers) → Supabase PostgreSQL + Cloudflare R2.

## PostgreSQL roles

| Role                        | Used by                          | Notes                                                                                                                                                  |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner (Supabase `postgres`) | `pnpm db:migrate` only           | Never used by running services.                                                                                                                        |
| `platform_app` (NOLOGIN)    | Grant holder                     | Table privileges are granted to this role by migrations.                                                                                               |
| `platform_app_login`        | `web`, `worker` (`DATABASE_URL`) | Created with `pnpm --filter @platform/db create-app-login`; `NOSUPERUSER NOBYPASSRLS`, member of `platform_app`, so row-level security always applies. |

Tenant isolation is enforced in application code (`authorize`, `withTenant`) **and** by RLS
(§63). Integration tests run as a non-superuser role to prove it.

## Redis

Redis holds BullMQ queues, locks and rate-limit counters (§48). Run it with `appendonly yes`
and `maxmemory-policy noeviction` (BullMQ must never have keys evicted). Redis is not a
source of truth: every job exists in `job_records` first, and the worker reconciler
re-dispatches jobs Redis has lost (D-003).

## Cloudflare R2

- One bucket per environment (§123).
- Configure **bucket lock rules** for the `tenant/` prefix with a retention period that matches
  the shortest incident-evidence retention class. Objects are written once (`If-None-Match: *`)
  with a SHA-256 checksum verified by R2.
- Use R2 API tokens scoped to the single bucket with object read/write only (no bucket admin).
- Wording: "Objects are retention-locked and cryptographically verifiable" — do not describe
  this as legally certified immutable storage (§50).

## Secrets

- `DATA_ENCRYPTION_KEYS` — AES-256-GCM key ring for secrets at rest (TOTP secrets, connector
  credentials). Rotate by prepending a new key; keep old keys until re-encryption completes.
- Signing keys for evidence manifests are handled separately (Milestone 2, §120).

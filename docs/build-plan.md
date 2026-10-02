# Build Plan and Status

Follows the dev bible build order (§90). Each milestone is delivered fully, with unreleased
capability kept behind feature states (§35, §89).

North star: the implementation acceptance test (§142).

## Milestone 0 — Repository and guardrails (§90.1)

- [x] pnpm monorepo (`apps/`, `packages/`, `connectors/`, `infrastructure/`, `docs/`)
- [x] TypeScript strict, ESLint, Prettier, Vitest (unit + integration projects)
- [x] `@platform/shared`: centralised brand config (§140), env validation, redacting structured logger (§92, §132)
- [x] `apps/web` Next.js shell with semantic design + motion tokens, health endpoint
- [x] `apps/worker` runtime entry with health endpoint and graceful shutdown
- [x] Docker images for `web` and `worker` (non-root, health checks); production and dev compose files
- [x] GitHub Actions: lint, format, typecheck, tests, dependency audit, image build, GHCR publish on `main`
- [ ] Hetzner deploy + post-deploy health check (blocked on server provisioning)

## Milestone 1 — Foundation (§90.2–10)

- [x] `packages/db`: Kysely + checksummed SQL migrations, tenant/system scoping, RLS
- [x] Tenant model (organisations, users, memberships) + provisioning
- [x] `packages/auth`: opaque sessions, scrypt passwords, lockout, TOTP MFA (encrypted secret, replay protection, hashed backup codes), step-up auth
- [x] RBAC: customer roles + permissions, enforced server-side (`authorize`)
- [x] Web auth: cookie sessions, Origin (CSRF) checks, error envelope, auth API routes, sign-in / MFA / workspace pages
- [x] CLIs: `db:migrate`, `create-app-login`, tenant `bootstrap`
- [x] Login rate limiting via Redis (per IP and per account, fail-open) on top of per-account lockout
- [x] Append-only audit log (`packages/audit`, DB-enforced)
- [x] `packages/features`: registry + feature states (ON / OFF / BETA / INTERNAL), per environment and tenant, audited changes, server guard
- [x] §101 schema: foundation, jobs/outbox and connector tables (evidence and integrity tables land with Milestone 2, D-011)
- [x] Evidence vault: write-once S3/R2 object store with SHA-256 verification, §109 key layout
- [x] Worker runtime: PostgreSQL job records → BullMQ dispatch, retries, dead-letter, reconciler for lost Redis state, transactional outbox fan-out
- [x] Connector framework: `ConnectorAdapter`, encrypted credential refs, resilient HTTP client, sync runs, cursors, health + ConnectorDegraded/Recovered events, lifecycle, scheduler, §127 test harness
- [x] Cross-tenant isolation tests (extended with every new tenant table)

## Milestone 2 — Evidence core (§90.11–18)

- [ ] Evidence capture sink: raw envelope → R2 → SHA-256 → provenance → `raw_evidence_objects`
- [ ] Register `connector.sync` in the worker once the sink exists
- [ ] Schema/transformer versioning, normalisation, reprocessing
- [ ] Evidence Explorer (UI foundation: shell, Kokonut, GSAP, themes)
- [ ] Merkle manifests, Ed25519 signing, key rotation, verification

## Milestone 3 — Microsoft first (§90.19–22), then ConnectWise PSA and NinjaOne (D-002)

## Milestone 4 — Incident core (§90.23–30)

## Milestone 5 — Blast radius (§90.31–35)

## Milestone 6 — Assurance (§90.36–41)

## Milestone 7 — Workspace Admin (§90.42–46)

## Milestone 8 — Internal Control Plane (§90.47–54)

## Milestone 9 — Intelligence (§90.55–60)

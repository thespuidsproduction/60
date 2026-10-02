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

- [ ] `packages/db`: Kysely + SQL migrations, tenant scoping, RLS
- [ ] Tenant model (organisations, users, memberships)
- [ ] `packages/auth`: opaque sessions, password hashing, TOTP MFA (encrypted secret, hashed backup codes), step-up auth
- [ ] RBAC: customer roles + permissions, enforced server-side
- [ ] Append-only audit log
- [ ] `packages/features`: feature states (ON / OFF / BETA / INTERNAL), per environment and tenant
- [ ] §101 schema skeleton
- [ ] Evidence vault (R2/S3 client, §109 layout)
- [ ] Worker runtime: BullMQ queues mirrored in PostgreSQL job records, transactional outbox
- [ ] Connector framework: `ConnectorAdapter`, credential refs, sync runs, cursors, health, test harness
- [ ] Cross-tenant isolation tests

## Milestone 2 — Evidence core (§90.11–18)

## Milestone 3 — Microsoft first (§90.19–22), then ConnectWise PSA and NinjaOne (D-002)

## Milestone 4 — Incident core (§90.23–30)

## Milestone 5 — Blast radius (§90.31–35)

## Milestone 6 — Assurance (§90.36–41)

## Milestone 7 — Workspace Admin (§90.42–46)

## Milestone 8 — Internal Control Plane (§90.47–54)

## Milestone 9 — Intelligence (§90.55–60)

# 170tarv

Cyber-resilience evidence and incident-operations platform for MSPs and regulated technology
providers.

> When something goes wrong, we reconstruct and prove what happened.

- **Canonical specification:** [`docs/dev-bible.md`](docs/dev-bible.md)
- **Build plan and status:** [`docs/build-plan.md`](docs/build-plan.md)
- **Deliberate deviations:** [`docs/deviations.md`](docs/deviations.md)
- **Local development:** [`docs/local-development.md`](docs/local-development.md)

## Layout

```text
apps/web          Next.js application (client app + internal Control Plane)
apps/worker       Background worker runtime
packages/*        Shared modules (db, auth, evidence, integrity, incidents, ...)
connectors/*      Source-system connectors
infrastructure/   Dockerfiles and compose files
docs/             Specification, plan, decisions
```

The product name lives in configuration (`BRAND_*` env vars); source packages use generic names.

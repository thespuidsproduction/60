# Local Development

Requirements: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
docker compose -f infrastructure/docker-compose.dev.yml up -d   # Postgres, Redis, SeaweedFS
cp .env.example .env   # then set DATA_ENCRYPTION_KEYS
set -a; . ./.env; set +a

# Database: migrate as owner, create the non-superuser app login, provision a tenant.
pnpm db:migrate
APP_DB_PASSWORD=change-me pnpm --filter @platform/db create-app-login
BOOTSTRAP_ADMIN_PASSWORD='a long local password' pnpm --filter @platform/auth bootstrap \
  --slug acme --name "Acme MSP" --email admin@acme.example --display-name "Admin" --reason "local dev"

pnpm dev:web       # http://localhost:3000/login
pnpm dev:worker    # health on http://localhost:8081/health
```

Checks (same as CI):

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test               # unit
pnpm test:integration   # needs the dev compose services
```

Images:

```bash
docker build -f infrastructure/docker/web.Dockerfile -t platform-web .
docker build -f infrastructure/docker/worker.Dockerfile -t platform-worker .
```

Local Postgres and SeaweedFS stand in for Supabase and Cloudflare R2 (see `docs/deviations.md`, D-001).

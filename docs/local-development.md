# Local Development

Requirements: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
docker compose -f infrastructure/docker-compose.dev.yml up -d   # Postgres, Redis, MinIO
cp .env.example .env

pnpm dev:web       # http://localhost:3000
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

Local Postgres and MinIO stand in for Supabase and Cloudflare R2 (see `docs/deviations.md`, D-001).

# syntax=docker/dockerfile:1.7
# Background worker image (dev bible §53, §104). Build from repository root:
#   docker build -f infrastructure/docker/worker.Dockerfile -t platform-worker .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @platform/worker build
RUN pnpm --filter @platform/worker --prod deploy --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production WORKER_HEALTH_PORT=8081
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /out/package.json ./package.json
COPY --from=build --chown=app:app /out/node_modules ./node_modules
COPY --from=build --chown=app:app /repo/apps/worker/dist ./dist
USER app
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health || exit 1
CMD ["node", "dist/main.js"]

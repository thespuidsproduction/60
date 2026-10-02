import "server-only"
import {
  createAuthService,
  createRedisRateLimiter,
  type AuthService,
  type RateLimiter,
} from "@platform/auth"
import { Redis } from "ioredis"
import { createDb, type Db } from "@platform/db"
import { createFeatureService, type FeatureService } from "@platform/features"
import {
  createLogger,
  createSecretBox,
  loadBrand,
  parseKeyRing,
  type Logger,
} from "@platform/shared"
import { webEnv } from "./env"

interface Services {
  db: Db
  auth: AuthService
  features: FeatureService
  rateLimiter: RateLimiter
  log: Logger
}

const globalForServices = globalThis as unknown as { __platformServices?: Services }

/** Process-wide singletons (survive Next.js dev hot reloads). */
export function services(): Services {
  if (globalForServices.__platformServices) return globalForServices.__platformServices
  const env = webEnv()
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: "web" })
  const log = createLogger({ level: env.LOG_LEVEL, base: { service: "web", env: env.APP_ENV } })
  // Commands queue briefly while connecting (so the first requests after start are
  // still limited); a short timeout makes the limiter fail open if Redis is down.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 500 })
  redis.on("error", () => {}) // surfaced via the rate limiter's onError
  const created: Services = {
    db,
    auth: createAuthService({
      db,
      secretBox: createSecretBox(parseKeyRing(env.DATA_ENCRYPTION_KEYS)),
      config: { totpIssuer: loadBrand().productName },
    }),
    features: createFeatureService({ db, environment: env.APP_ENV }),
    rateLimiter: createRedisRateLimiter(redis, {
      prefix: `${env.APP_ENV}:ratelimit`,
      onError: (error) => log.error("rate limiter unavailable; failing open", { error }),
    }),
    log,
  }
  globalForServices.__platformServices = created
  return created
}

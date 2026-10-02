import "server-only"
import { createAuthService, type AuthService } from "@platform/auth"
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
  log: Logger
}

const globalForServices = globalThis as unknown as { __platformServices?: Services }

/** Process-wide singletons (survive Next.js dev hot reloads). */
export function services(): Services {
  if (globalForServices.__platformServices) return globalForServices.__platformServices
  const env = webEnv()
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: "web" })
  const created: Services = {
    db,
    auth: createAuthService({
      db,
      secretBox: createSecretBox(parseKeyRing(env.DATA_ENCRYPTION_KEYS)),
      config: { totpIssuer: loadBrand().productName },
    }),
    features: createFeatureService({ db, environment: env.APP_ENV }),
    log: createLogger({ level: env.LOG_LEVEL, base: { service: "web", env: env.APP_ENV } }),
  }
  globalForServices.__platformServices = created
  return created
}

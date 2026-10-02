import { z } from "zod"
import { baseEnvSchema, parseEnv } from "@platform/shared"

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8081),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DATA_ENCRYPTION_KEYS: z.string().min(1),
  /** How often connectors are synced incrementally. */
  CONNECTOR_SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  /** Ed25519 manifest signing key ring (secret): id:base64(pkcs8), first = active (§120). */
  MANIFEST_SIGNING_KEYS: z.string().min(1),
  /** How often pending evidence is sealed into signed manifests. */
  INTEGRITY_SEAL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
})

export type WorkerConfig = z.infer<typeof workerEnvSchema>

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env) {
  return parseEnv(workerEnvSchema, env)
}

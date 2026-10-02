import { z } from "zod"
import { baseEnvSchema, parseEnv } from "@platform/shared"

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8081),
})

export type WorkerConfig = z.infer<typeof workerEnvSchema>

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env) {
  return parseEnv(workerEnvSchema, env)
}

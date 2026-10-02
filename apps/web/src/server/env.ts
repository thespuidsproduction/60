import "server-only"
import { z } from "zod"
import { baseEnvSchema, parseEnv } from "@platform/shared"

const webEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z.string().url(),
  /** `id:base64key[,id:base64key...]`, first key encrypts (see secret-box.ts). */
  DATA_ENCRYPTION_KEYS: z.string().min(1),
  /** Public origin, e.g. https://app.example.com — used for Origin checks. */
  APP_ORIGIN: z.string().url(),
  REDIS_URL: z.string().url(),
})

export type WebEnv = z.infer<typeof webEnvSchema>

let cached: WebEnv | undefined

/** Parsed lazily so `next build` does not require runtime secrets. */
export function webEnv(): WebEnv {
  cached ??= parseEnv(webEnvSchema)
  return cached
}

import { z } from "zod"
import { parseEnv } from "@platform/shared"
import { createS3ObjectStore, type ObjectStore } from "./object-store"

/** Object storage settings: Cloudflare R2 in staging/production (§50), SeaweedFS locally (D-001). */
export const objectStoreEnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
})

export function objectStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): ObjectStore {
  const config = parseEnv(objectStoreEnvSchema, env)
  return createS3ObjectStore({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  })
}

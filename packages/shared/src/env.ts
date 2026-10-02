import { z } from "zod"

export const appEnvironments = ["local", "test", "staging", "production"] as const
export type AppEnvironment = (typeof appEnvironments)[number]

/**
 * Parses process environment against a zod schema and fails fast with the
 * names (never the values) of missing or invalid variables.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env)
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "(root)")
    throw new Error(`Invalid environment configuration: ${[...new Set(fields)].join(", ")}`)
  }
  return result.data
}

export const baseEnvSchema = z.object({
  APP_ENV: z.enum(appEnvironments).default("local"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
})

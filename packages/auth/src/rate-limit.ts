import type { Redis } from "ioredis"

export interface RateLimitRule {
  /** Logical bucket name, e.g. "login:ip". */
  name: string
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export interface RateLimiter {
  hit(rule: RateLimitRule, key: string): Promise<RateLimitResult>
}

/**
 * Fixed-window rate limiter in Redis (dev bible §48, §66). Keys are hashed by
 * the caller where they contain personal data. Redis is not the source of
 * truth: if it is unavailable the limiter fails open and reports it, because
 * the per-account lockout in PostgreSQL still protects credentials.
 */
export function createRedisRateLimiter(
  redis: Redis,
  options: { prefix?: string; onError?: (error: unknown) => void } = {},
): RateLimiter {
  const prefix = options.prefix ?? "ratelimit"
  return {
    async hit(rule, key) {
      const window = Math.floor(Date.now() / rule.windowMs)
      const redisKey = `${prefix}:${rule.name}:${window}:${key}`
      try {
        const results = await redis.multi().incr(redisKey).pexpire(redisKey, rule.windowMs).exec()
        const count = Number(results?.[0]?.[1] ?? 0)
        const retryAfterMs = (window + 1) * rule.windowMs - Date.now()
        return {
          allowed: count <= rule.limit,
          remaining: Math.max(0, rule.limit - count),
          retryAfterMs,
        }
      } catch (error) {
        options.onError?.(error)
        return { allowed: true, remaining: rule.limit, retryAfterMs: 0 }
      }
    },
  }
}

export const loginRateLimits = {
  perIp: { name: "login:ip", limit: 30, windowMs: 60_000 },
  perAccount: { name: "login:account", limit: 10, windowMs: 15 * 60_000 },
} satisfies Record<string, RateLimitRule>

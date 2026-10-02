import { randomUUID } from "node:crypto"
import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import { createRedisRateLimiter } from "./rate-limit"

const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379")
afterAll(async () => {
  await redis.quit()
})

describe("redis rate limiter", () => {
  it("allows up to the limit within a window", async () => {
    const limiter = createRedisRateLimiter(redis, { prefix: `test-${randomUUID()}` })
    const rule = { name: "login:ip", limit: 3, windowMs: 60_000 }
    const results = []
    for (let i = 0; i < 4; i++) results.push(await limiter.hit(rule, "203.0.113.9"))
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false])
    expect(results[3]!.retryAfterMs).toBeGreaterThan(0)
    expect((await limiter.hit(rule, "198.51.100.1")).allowed).toBe(true)
  })

  it("fails open and reports when Redis is unavailable", async () => {
    const broken = new Redis({
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    })
    const errors: unknown[] = []
    const limiter = createRedisRateLimiter(broken, { onError: (e) => errors.push(e) })
    expect((await limiter.hit({ name: "x", limit: 1, windowMs: 1000 }, "k")).allowed).toBe(true)
    expect(errors).toHaveLength(1)
    broken.disconnect()
  })
})

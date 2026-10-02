import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "@platform/shared"
import {
  CredentialError,
  MalformedResponseError,
  PermissionDeniedError,
  RateLimitedError,
  UpstreamUnavailableError,
} from "./errors"
import { createHttpClient } from "./http"
import { startFakeUpstream, type FakeUpstream } from "./testing"

const lines: string[] = []
const log = createLogger({ level: "debug", write: (line) => lines.push(line) })
const sleeps: number[] = []
const client = (extra = {}) =>
  createHttpClient({ log, baseBackoffMs: 1, sleep: async (ms) => void sleeps.push(ms), ...extra })

let upstream: FakeUpstream
afterEach(async () => {
  await upstream?.close()
  sleeps.length = 0
  lines.length = 0
})

const get = (path: string) => ({
  url: `${upstream.url}${path}`,
  headers: { authorization: `Bearer ${upstream.token}` },
})

describe("connector http client", () => {
  it("honours Retry-After on 429 and then succeeds", async () => {
    upstream = await startFakeUpstream()
    upstream.failNext(2, { kind: "status", status: 429, headers: { "retry-after": "3" } })
    expect(await client().json(get("/me"))).toMatchObject({ tenantId: "upstream-tenant-1" })
    expect(sleeps).toEqual([3000, 3000])
  })

  it("surfaces rate limiting when Retry-After exceeds the bound", async () => {
    upstream = await startFakeUpstream()
    upstream.failNext(1, { kind: "status", status: 429, headers: { "retry-after": "3600" } })
    await expect(client().json(get("/me"))).rejects.toBeInstanceOf(RateLimitedError)
  })

  it("maps 401 and 403 to non-retryable errors", async () => {
    upstream = await startFakeUpstream()
    const stale = get("/me")
    upstream.expireToken()
    const error: unknown = await client()
      .json(stale)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CredentialError)
    expect((error as CredentialError).retryable).toBe(false)
    upstream.failNext(1, { kind: "status", status: 403 })
    await expect(client().json(get("/me"))).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it("retries 5xx and gives up as UpstreamUnavailable", async () => {
    upstream = await startFakeUpstream()
    upstream.failNext(10, { kind: "status", status: 503 })
    await expect(client({ maxAttempts: 3 }).json(get("/me"))).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    )
    expect(sleeps).toHaveLength(2)
  })

  it("rejects non-JSON bodies and times out hung requests", async () => {
    upstream = await startFakeUpstream()
    upstream.failNext(1, { kind: "malformed" })
    await expect(client().json(get("/me"))).rejects.toBeInstanceOf(MalformedResponseError)
    upstream.failNext(1, { kind: "hang" })
    await expect(
      client({ timeoutMs: 100, maxAttempts: 1 }).json(get("/me")),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError)
  })

  it("never logs tokens or query strings", async () => {
    upstream = await startFakeUpstream()
    upstream.failNext(1, { kind: "status", status: 500 })
    await client().json(get("/events?cursor=secret-cursor"))
    expect(lines.join("\n")).not.toContain(upstream.token)
    expect(lines.join("\n")).not.toContain("secret-cursor")
  })
})

import { describe, expect, it } from "vitest"
import { createLogger, REDACTED, redact } from "./logger"

describe("redact", () => {
  it("redacts sensitive keys at any depth", () => {
    const out = redact({
      userId: "u1",
      accessToken: "abc",
      nested: { client_secret: "s", ok: 1, list: [{ password: "p" }] },
    })
    expect(out).toEqual({
      userId: "u1",
      accessToken: REDACTED,
      nested: { client_secret: REDACTED, ok: 1, list: [{ password: REDACTED }] },
    })
  })
})

describe("createLogger", () => {
  it("writes JSON lines, respects level and merges child fields", () => {
    const lines: string[] = []
    const log = createLogger({ level: "info", write: (l) => lines.push(l) })
    log.debug("hidden")
    log.child({ correlationId: "c1" }).info("hello", { refreshToken: "x" })
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!)
    expect(record).toMatchObject({
      level: "info",
      msg: "hello",
      correlationId: "c1",
      refreshToken: REDACTED,
    })
  })
})

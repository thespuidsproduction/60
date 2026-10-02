import { z } from "zod"
import type { ConnectorAdapter, ConnectorContext, SyncBatch } from "../types"

/**
 * Reference connector against the fake upstream. It shows the contract every
 * real connector follows: read-only calls, untouched payloads in envelopes,
 * and the position *after* each page returned as the batch cursor.
 */
const config = z.object({
  baseUrl: z.string().url(),
  pageSize: z.number().int().positive().default(2),
})
const credentials = z.object({ token: z.string().min(1) })
type Config = z.infer<typeof config>
type Credentials = z.infer<typeof credentials>
type Ctx = ConnectorContext<Config, Credentials>

const auth = (ctx: Ctx) => ({ authorization: `Bearer ${ctx.credentials.token}` })

interface Page {
  items: Record<string, unknown>[]
  nextCursor: string | null
  position: number
}

async function* pages(ctx: Ctx, start: string): AsyncIterable<SyncBatch> {
  let cursor: string | null = start
  while (cursor !== null) {
    const url: string = `${ctx.config.baseUrl}/events?cursor=${encodeURIComponent(cursor)}&limit=${ctx.config.pageSize}`
    const page: Page = await ctx.http.json<Page>({ url, headers: auth(ctx) })
    if (!page || !Array.isArray(page.items)) throw new Error("Unexpected page shape")
    const capturedAt = ctx.now().toISOString()
    yield {
      stream: "events",
      cursor: String(page.position),
      envelopes: page.items.map((item) => ({
        source: "fixture",
        sourceTenant: ctx.sourceTenant ?? "unknown",
        sourceObjectId: item.id,
        sourceEventId: item.id,
        objectType: "event",
        sourceApi: "GET /events",
        capturedAt,
        sourceTimestamp: item.occurredAt ?? null,
        payload: item,
      })),
    }
    cursor = page.nextCursor
  }
}

export const fixtureAdapter: ConnectorAdapter<Config, Credentials> = {
  type: "fixture",
  source: "fixture",
  displayName: "Fixture",
  version: "1.0.0",
  declaredCapabilities: ["AUDIT_READ"],
  requiredPermissions: ["Events.Read"],
  expectedFreshnessMs: 60 * 60 * 1000,
  configSchema: config,
  credentialsSchema: credentials,

  async connect(ctx) {
    const me = await ctx.http.json<{ tenantId: string }>({
      url: `${ctx.config.baseUrl}/me`,
      headers: auth(ctx),
    })
    return { sourceTenant: me.tenantId }
  },
  async validatePermissions(ctx) {
    const me = await ctx.http.json<{ permissions: string[] }>({
      url: `${ctx.config.baseUrl}/me`,
      headers: auth(ctx),
    })
    const missing = this.requiredPermissions.filter((p) => !me.permissions.includes(p))
    return { granted: me.permissions, missing }
  },
  async discoverCapabilities() {
    return ["AUDIT_READ"]
  },
  syncBaseline(ctx) {
    return pages(ctx, "0")
  },
  syncIncremental(ctx, cursors) {
    return pages(ctx, String(cursors.get("events") ?? "0"))
  },
  async fetchObject() {
    return null
  },
  async *fetchEvidence() {},
  async healthCheck(ctx) {
    const start = Date.now()
    await ctx.http.json({ url: `${ctx.config.baseUrl}/me`, headers: auth(ctx) })
    return { ok: true, latencyMs: Date.now() - start }
  },
  async revoke(ctx) {
    await ctx.http.json({
      url: `${ctx.config.baseUrl}/revoke`,
      method: "POST",
      headers: auth(ctx),
      body: {},
    })
  },
}

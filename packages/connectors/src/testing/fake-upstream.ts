import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * Programmable fake upstream API for connector tests (dev bible §127).
 *
 * Serves fixture records with cursor pagination and lets tests inject the
 * failure modes every connector must survive: rate limiting, expired tokens,
 * malformed payloads, duplicate events, pagination, and partial outages.
 *
 *   GET /me                       → { tenantId, permissions }
 *   GET /events?cursor=N&limit=M  → { items, nextCursor }
 */
export interface FakeRecord {
  id?: string
  occurredAt?: string
  [key: string]: unknown
}

type Fault =
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "malformed" }
  | { kind: "hang" }

export interface FakeUpstream {
  url: string
  token: string
  tenantId: string
  permissions: string[]
  records: FakeRecord[]
  pageSize: number
  /** Requests served (path + query), for assertions. */
  requests: string[]
  /** Queue faults for the next N matching requests. */
  failNext(times: number, fault: Fault, path?: string): void
  /** Fail every request to `path` once `page` (0-based) is reached, until cleared. */
  outageFromPage(page: number | null): void
  expireToken(): void
  rotateToken(token: string): void
  close(): Promise<void>
}

export async function startFakeUpstream(
  options: {
    records?: FakeRecord[]
    pageSize?: number
    token?: string
    tenantId?: string
    permissions?: string[]
  } = {},
): Promise<FakeUpstream> {
  const faults: { fault: Fault; path?: string }[] = []
  let outagePage: number | null = null
  const state = {
    token: options.token ?? "valid-token",
    tenantId: options.tenantId ?? "upstream-tenant-1",
    permissions: options.permissions ?? ["Events.Read"],
    records: options.records ?? [],
    pageSize: options.pageSize ?? 2,
    requests: [] as string[],
  }

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(typeof body === "string" ? body : JSON.stringify(body))
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    state.requests.push(url.pathname + url.search)

    const index = faults.findIndex((f) => !f.path || f.path === url.pathname)
    if (index >= 0) {
      const [{ fault }] = faults.splice(index, 1) as [{ fault: Fault }]
      if (fault.kind === "status")
        return send(res, fault.status, { error: "injected" }, fault.headers)
      if (fault.kind === "malformed") return send(res, 200, "{not json")
      if (fault.kind === "hang") return // never respond; client timeout applies
    }

    if (req.headers.authorization !== `Bearer ${state.token}`) {
      return send(res, 401, { error: "invalid_token" })
    }

    if (url.pathname === "/me") {
      return send(res, 200, { tenantId: state.tenantId, permissions: state.permissions })
    }
    if (url.pathname === "/events") {
      const cursor = Number(url.searchParams.get("cursor") ?? "0")
      const limit = Number(url.searchParams.get("limit") ?? state.pageSize)
      if (outagePage !== null && Math.floor(cursor / limit) >= outagePage) {
        return send(res, 503, { error: "outage" })
      }
      const items = state.records.slice(cursor, cursor + limit)
      const next = cursor + items.length
      return send(res, 200, {
        items,
        nextCursor: next < state.records.length ? String(next) : null,
        position: next,
      })
    }
    if (url.pathname === "/revoke") return send(res, 200, { revoked: true })
    return send(res, 404, { error: "not_found" })
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    get token() {
      return state.token
    },
    get tenantId() {
      return state.tenantId
    },
    get permissions() {
      return state.permissions
    },
    set permissions(value) {
      state.permissions = value
    },
    get records() {
      return state.records
    },
    set records(value) {
      state.records = value
    },
    get pageSize() {
      return state.pageSize
    },
    set pageSize(value) {
      state.pageSize = value
    },
    requests: state.requests,
    failNext(times, fault, path) {
      for (let i = 0; i < times; i++) faults.push({ fault, ...(path ? { path } : {}) })
    },
    outageFromPage(page) {
      outagePage = page
    },
    expireToken() {
      state.token = `expired-${Date.now()}`
    },
    rotateToken(token) {
      state.token = token
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

import type { Logger } from "@platform/shared"
import {
  CredentialError,
  MalformedResponseError,
  PermissionDeniedError,
  RateLimitedError,
  UpstreamUnavailableError,
} from "./errors"

export interface HttpRequest {
  url: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  /** JSON body (read-only query APIs such as KQL use POST). */
  body?: unknown
}

export interface ConnectorHttpClient {
  json<T = unknown>(request: HttpRequest): Promise<T>
}

export interface HttpClientOptions {
  log: Logger
  fetch?: typeof fetch
  timeoutMs?: number
  /** Attempts for 429/5xx/network failures before surfacing the error. */
  maxAttempts?: number
  /** Upper bound on any single wait, including Retry-After. */
  maxBackoffMs?: number
  baseBackoffMs?: number
  sleep?: (ms: number) => Promise<void>
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function retryAfterMs(header: string | null, fallback: number): number {
  if (!header) return fallback
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? fallback : Math.max(0, date - Date.now())
}

/**
 * HTTP client for connectors: timeouts, bounded retries honouring Retry-After,
 * and status codes mapped to classified errors. Logs method, host and status
 * only — never headers, tokens, query strings or bodies (§132).
 */
export function createHttpClient(options: HttpClientOptions): ConnectorHttpClient {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxAttempts = options.maxAttempts ?? 4
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  const baseBackoffMs = options.baseBackoffMs ?? 500
  const sleep = options.sleep ?? sleepDefault

  return {
    async json<T>(request: HttpRequest): Promise<T> {
      const url = new URL(request.url)
      const where = { method: request.method ?? "GET", host: url.host, path: url.pathname }
      let lastError: Error | undefined
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response: Response
        try {
          response = await doFetch(url, {
            method: request.method ?? "GET",
            headers: {
              accept: "application/json",
              ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
              ...request.headers,
            },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: AbortSignal.timeout(timeoutMs),
          })
        } catch (error) {
          lastError = new UpstreamUnavailableError(
            `Network failure calling ${url.host}: ${(error as Error).name}`,
          )
          options.log.warn("connector http network failure", { ...where, attempt })
          if (attempt < maxAttempts)
            await sleep(Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs))
          continue
        }

        if (response.ok) {
          const text = await response.text()
          try {
            return (text ? JSON.parse(text) : null) as T
          } catch {
            throw new MalformedResponseError(`Non-JSON response from ${url.host}${url.pathname}`)
          }
        }

        // Drain the body without retaining it.
        await response.body?.cancel().catch(() => {})
        options.log.warn("connector http error status", {
          ...where,
          status: response.status,
          attempt,
        })

        if (response.status === 401)
          throw new CredentialError(`Credentials rejected by ${url.host}`)
        if (response.status === 403)
          throw new PermissionDeniedError(`Permission denied by ${url.host}${url.pathname}`)
        if (response.status === 429) {
          const wait = retryAfterMs(
            response.headers.get("retry-after"),
            baseBackoffMs * 2 ** (attempt - 1),
          )
          lastError = new RateLimitedError(`Rate limited by ${url.host}`, wait)
          if (wait > maxBackoffMs || attempt === maxAttempts) throw lastError
          await sleep(wait)
          continue
        }
        if (response.status >= 500) {
          lastError = new UpstreamUnavailableError(`${url.host} returned ${response.status}`)
          if (attempt < maxAttempts)
            await sleep(Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs))
          continue
        }
        throw new MalformedResponseError(
          `${url.host}${url.pathname} returned unexpected status ${response.status}`,
        )
      }
      throw lastError ?? new UpstreamUnavailableError(`Request to ${url.host} failed`)
    },
  }
}

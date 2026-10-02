/** Classified connector failures; the sync orchestrator maps these to health and retries. */
export class ConnectorError extends Error {
  readonly retryable: boolean = true
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Credential rejected or expired (HTTP 401). Needs reauthorisation; not retryable. */
export class CredentialError extends ConnectorError {
  override readonly retryable = false
}

/** Missing upstream permission (HTTP 403). Not retryable until permissions change. */
export class PermissionDeniedError extends ConnectorError {
  override readonly retryable = false
}

/** Upstream throttling (HTTP 429). Retry after the given delay. */
export class RateLimitedError extends ConnectorError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message)
  }
}

/** Upstream 5xx, timeout or network failure. */
export class UpstreamUnavailableError extends ConnectorError {}

/** Upstream returned something we cannot parse as a page (not a single bad object). */
export class MalformedResponseError extends ConnectorError {}

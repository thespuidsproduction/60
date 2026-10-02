import "server-only"
import { AuthError } from "@platform/auth"
import { FeatureUnavailableError } from "@platform/features"
import { z } from "zod"
import { webEnv } from "./env"
import { services } from "./services"

/** Consistent error envelope (dev bible §118). */
export function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

const authStatus: Record<AuthError["code"], number> = {
  INVALID_CREDENTIALS: 401,
  INVALID_PASSWORD_POLICY: 400,
  MFA_REQUIRED: 401,
  MFA_INVALID: 401,
  MFA_ENROLLMENT_REQUIRED: 403,
  MFA_ALREADY_ENROLLED: 409,
  SESSION_INVALID: 401,
  STEP_UP_REQUIRED: 403,
  NO_TENANT_SELECTED: 409,
  FORBIDDEN: 403,
}

/**
 * Wraps a route handler: CSRF origin check for state-changing methods, typed
 * errors mapped to the envelope, and no internal error detail leaked to clients.
 */
export function handler(fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") assertSameOrigin(request)
      return await fn(request)
    } catch (error) {
      if (error instanceof AuthError)
        return errorResponse(authStatus[error.code], error.code, error.message)
      if (error instanceof FeatureUnavailableError)
        return errorResponse(404, "FEATURE_UNAVAILABLE", error.message)
      if (error instanceof OriginError)
        return errorResponse(403, "BAD_ORIGIN", "Cross-origin request rejected.")
      if (error instanceof z.ZodError)
        return errorResponse(400, "VALIDATION_FAILED", "Request validation failed.")
      services().log.error("unhandled route error", { error, path: new URL(request.url).pathname })
      return errorResponse(500, "INTERNAL", "An unexpected error occurred.")
    }
  }
}

class OriginError extends Error {}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin || origin !== new URL(webEnv().APP_ORIGIN).origin) throw new OriginError()
}

export async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const body: unknown = await request.json().catch(() => ({}))
  return schema.parse(body)
}

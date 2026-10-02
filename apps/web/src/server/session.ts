import "server-only"
import { cookies, headers } from "next/headers"
import type { AuditRequestContext } from "@platform/audit"
import type { AuthContext } from "@platform/auth"
import { webEnv } from "./env"
import { services } from "./services"

/**
 * Session cookie: opaque random token, HTTP-only, SameSite=Lax. Uses the
 * `__Host-` prefix (Secure, host-only, Path=/) everywhere except local HTTP dev.
 */
export function sessionCookieName(): string {
  return webEnv().APP_ENV === "local" ? "session" : "__Host-session"
}

export async function setSessionCookie(token: string) {
  const local = webEnv().APP_ENV === "local"
  ;(await cookies()).set(sessionCookieName(), token, {
    httpOnly: true,
    secure: !local,
    sameSite: "lax",
    path: "/",
    // Server-side expiry is authoritative; the cookie never outlives the absolute TTL.
    maxAge: Math.floor(services().auth.config.sessionTtlMs / 1000),
  })
}

export async function clearSessionCookie() {
  ;(await cookies()).delete(sessionCookieName())
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(sessionCookieName())?.value
}

/** Resolves the current request's identity server-side. Null when signed out. */
export async function currentAuth(): Promise<AuthContext | null> {
  return services().auth.resolveSession(await sessionToken())
}

export async function requestContext(sessionId?: string | null): Promise<AuditRequestContext> {
  const h = await headers()
  return {
    sessionId: sessionId ?? null,
    // Cloudflare sets CF-Connecting-IP; fall back to the first X-Forwarded-For hop.
    ip: h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
    correlationId: h.get("cf-ray") ?? h.get("x-request-id"),
  }
}

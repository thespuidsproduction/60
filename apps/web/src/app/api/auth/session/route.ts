import { handler } from "@/server/http"
import { currentAuth } from "@/server/session"

export const dynamic = "force-dynamic"

/** Minimal identity for the client shell. Authorisation is always re-checked server-side. */
export const GET = handler(async () => {
  const ctx = await currentAuth()
  if (!ctx) return Response.json({ authenticated: false })
  return Response.json({
    authenticated: true,
    state: ctx.state,
    user: { id: ctx.userId, email: ctx.email, displayName: ctx.displayName },
    mfaEnrolled: ctx.mfaEnrolled,
    tenantId: ctx.tenantId,
    role: ctx.role,
    permissions: [...ctx.permissions],
  })
})

import { z } from "zod"
import { AuthError } from "@platform/auth"
import { handler, parseJson } from "@/server/http"
import { services } from "@/server/services"
import { currentAuth, requestContext } from "@/server/session"

const body = z.object({ tenantId: z.string().uuid() })

export const GET = handler(async () => {
  const ctx = await currentAuth()
  if (!ctx) throw new AuthError("SESSION_INVALID")
  const workspaces = await services().auth.listWorkspaces(ctx)
  return Response.json({
    workspaces: workspaces.map((w) => ({
      id: w.tenant_id,
      name: w.name,
      slug: w.slug,
      role: w.role,
    })),
  })
})

export const POST = handler(async (request) => {
  const { tenantId } = await parseJson(request, body)
  const ctx = await currentAuth()
  if (!ctx) throw new AuthError("SESSION_INVALID")
  await services().auth.selectTenant(ctx, tenantId, await requestContext(ctx.sessionId))
  return new Response(null, { status: 204 })
})

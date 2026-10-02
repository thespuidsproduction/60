import { z } from "zod"
import { AuthError } from "@platform/auth"
import { handler, parseJson } from "@/server/http"
import { services } from "@/server/services"
import { requestContext, sessionToken } from "@/server/session"

const body = z.object({ code: z.string().trim().min(6).max(32) })

export const POST = handler(async (request) => {
  const { code } = await parseJson(request, body)
  const token = await sessionToken()
  if (!token) throw new AuthError("SESSION_INVALID")
  await services().auth.verifyMfa(token, code, await requestContext())
  const ctx = await services().auth.resolveSession(token)
  return Response.json({ tenantSelected: Boolean(ctx?.tenantId) })
})

import { z } from "zod"
import { handler, parseJson } from "@/server/http"
import { services } from "@/server/services"
import { requestContext, setSessionCookie } from "@/server/session"

const body = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
})

export const POST = handler(async (request) => {
  const { email, password } = await parseJson(request, body)
  const result = await services().auth.login(email, password, await requestContext())
  await setSessionCookie(result.token)
  return Response.json({
    mfaRequired: result.mfaRequired,
    tenantSelected: result.tenantId !== null,
  })
})

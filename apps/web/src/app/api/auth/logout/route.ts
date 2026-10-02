import { handler } from "@/server/http"
import { services } from "@/server/services"
import { clearSessionCookie, requestContext, sessionToken } from "@/server/session"

export const POST = handler(async () => {
  const token = await sessionToken()
  if (token) await services().auth.logout(token, await requestContext())
  await clearSessionCookie()
  return new Response(null, { status: 204 })
})

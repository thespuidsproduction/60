import { createHash } from "node:crypto"
import { z } from "zod"
import { loginRateLimits } from "@platform/auth"
import { errorResponse, handler, parseJson } from "@/server/http"
import { services } from "@/server/services"
import { requestContext, setSessionCookie } from "@/server/session"

const body = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
})

export const POST = handler(async (request) => {
  const { email, password } = await parseJson(request, body)
  const context = await requestContext()
  const { rateLimiter } = services()
  const accountKey = createHash("sha256").update(email.toLowerCase()).digest("hex")
  const [byIp, byAccount] = await Promise.all([
    rateLimiter.hit(loginRateLimits.perIp, context.ip ?? "unknown"),
    rateLimiter.hit(loginRateLimits.perAccount, accountKey),
  ])
  if (!byIp.allowed || !byAccount.allowed) {
    const retryAfter = Math.ceil(Math.max(byIp.retryAfterMs, byAccount.retryAfterMs) / 1000)
    const response = errorResponse(
      429,
      "RATE_LIMITED",
      "Too many sign-in attempts. Try again later.",
    )
    response.headers.set("retry-after", String(retryAfter))
    return response
  }
  const result = await services().auth.login(email, password, context)
  await setSessionCookie(result.token)
  return Response.json({
    mfaRequired: result.mfaRequired,
    tenantSelected: result.tenantId !== null,
  })
})

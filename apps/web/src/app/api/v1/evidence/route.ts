import { withTenant } from "@platform/db"
import { parseEvidenceQuery, searchEvidence } from "@platform/evidence"
import { requirePermission } from "@/server/authz"
import { handler } from "@/server/http"
import { services } from "@/server/services"

export const dynamic = "force-dynamic"

/** GET /api/v1/evidence?q=&cursor=&limit= — Evidence Explorer search (§19, §118). */
export const GET = handler(async (request) => {
  const { ctx, tenantId } = await requirePermission("evidence:view")
  const url = new URL(request.url)
  const { query, errors } = parseEvidenceQuery(url.searchParams.get("q") ?? "")
  if (errors.length) {
    return Response.json(
      { error: { code: "INVALID_QUERY", message: errors.join(" "), details: errors } },
      { status: 400 },
    )
  }
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const page = await withTenant(services().db, { tenantId, userId: ctx.userId }, (trx) =>
    searchEvidence(trx, query, {
      limit: Number.isFinite(limit) ? limit : 50,
      cursor: url.searchParams.get("cursor"),
    }),
  )
  return Response.json(page)
})

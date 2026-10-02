import { z } from "zod"
import { withTenant } from "@platform/db"
import { getEvidenceDetail } from "@platform/evidence"
import { requirePermission } from "@/server/authz"
import { handler, NotFoundError } from "@/server/http"
import { services } from "@/server/services"

export const dynamic = "force-dynamic"

export const GET = handler(async (request) => {
  const { ctx, tenantId } = await requirePermission("evidence:view")
  const id = z.string().uuid().parse(new URL(request.url).pathname.split("/").at(-1))
  const detail = await withTenant(services().db, { tenantId, userId: ctx.userId }, (trx) =>
    getEvidenceDetail(trx, id),
  )
  if (!detail) throw new NotFoundError()
  return Response.json(detail)
})

import { z } from "zod"
import { EvidenceNotFoundError, verifyEvidence } from "@platform/integrity"
import { requirePermission } from "@/server/authz"
import { handler, NotFoundError } from "@/server/http"
import { services } from "@/server/services"

/** POST /api/v1/evidence/{id}/verify — runs the §15 verification sequence now. */
export const POST = handler(async (request) => {
  const { ctx, tenantId } = await requirePermission("evidence:verify")
  const id = z.string().uuid().parse(new URL(request.url).pathname.split("/").at(-2))
  const result = await verifyEvidence(
    { db: services().db, store: services().store },
    { tenantId, evidenceId: id, verifiedBy: `user:${ctx.userId}` },
  ).catch((error: unknown) => {
    throw error instanceof EvidenceNotFoundError ? new NotFoundError() : error
  })
  return Response.json(result)
})

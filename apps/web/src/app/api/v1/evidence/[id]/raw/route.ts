import { z } from "zod"
import { withTenant } from "@platform/db"
import { keyBelongsToTenant, readRawEvidence } from "@platform/evidence"
import { requirePermission } from "@/server/authz"
import { handler, NotFoundError } from "@/server/http"
import { services } from "@/server/services"

export const dynamic = "force-dynamic"

/**
 * Raw source object, lazy-loaded (§134). The bytes are re-hashed and compared
 * with the recorded SHA-256 before anything is returned.
 */
export const GET = handler(async (request) => {
  const { ctx, tenantId } = await requirePermission("evidence:view")
  const id = z.string().uuid().parse(new URL(request.url).pathname.split("/").at(-2))
  const row = await withTenant(services().db, { tenantId, userId: ctx.userId }, (trx) =>
    trx
      .selectFrom("raw_evidence_objects")
      .select(["storage_object_key", "raw_sha256", "size_bytes", "media_type"])
      .where("id", "=", id)
      .executeTakeFirst(),
  )
  if (!row || !keyBelongsToTenant(row.storage_object_key, tenantId)) throw new NotFoundError()
  const { envelope } = await readRawEvidence(services().store, row)
  return Response.json({
    sha256: row.raw_sha256,
    sizeBytes: row.size_bytes,
    mediaType: row.media_type,
    hashVerified: true,
    envelope,
  })
})

export const dynamic = "force-dynamic"

/** Liveness probe for deploy health checks (§52, §124). */
export function GET() {
  return Response.json({ status: "ok", service: "web" })
}

import { Lock } from "lucide-react"
import { withTenant } from "@platform/db"
import { evidenceSummary, parseEvidenceQuery, searchEvidence } from "@platform/evidence"
import { AssuranceNav } from "@/components/assurance-nav"
import { EvidenceExplorer } from "@/components/evidence/explorer"
import { Card, SectionLabel } from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"
import { formatUtc } from "@/lib/format"
import { hasPermission, requirePermission } from "@/server/authz"
import { services } from "@/server/services"

export const dynamic = "force-dynamic"

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <SectionLabel>{label}</SectionLabel>
      <p className="mt-2 font-mono text-2xl tabular-nums">{value}</p>
      {hint ? <p className="mt-1 font-mono text-[11px] text-muted">{hint}</p> : null}
    </Card>
  )
}

export default async function EvidenceExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  if (!(await hasPermission("evidence:view"))) {
    return (
      <div className="max-w-3xl">
        <AssuranceNav active="evidence" />
        <Notice icon={Lock} title="You do not have access to evidence.">
          Evidence is visible to CISO, SecOps, GRC and Auditor roles. Ask a workspace administrator
          if you need access.
        </Notice>
      </div>
    )
  }
  const { ctx, tenantId } = await requirePermission("evidence:view")
  const q = (await searchParams).q ?? ""
  const parsed = parseEvidenceQuery(q)
  const { page, summary } = await withTenant(
    services().db,
    { tenantId, userId: ctx.userId },
    async (trx) => ({
      // An invalid query shows no results rather than unfiltered ones that could be misread as matches.
      page: parsed.errors.length
        ? { items: [], nextCursor: null }
        : await searchEvidence(trx, parsed.query),
      summary: await evidenceSummary(trx),
    }),
  )
  const sealedPct = summary.objects ? ((summary.sealed / summary.objects) * 100).toFixed(1) : "0.0"

  return (
    <div className="mx-auto max-w-[1480px]">
      <SectionLabel>Assurance</SectionLabel>
      <h1 className="mt-2 mb-6 text-2xl font-semibold">Can we prove it?</h1>
      <AssuranceNav active="evidence" />

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Metric
          label="Evidence objects"
          value={summary.objects.toLocaleString("en-GB")}
          hint={`${summary.sources} source(s)`}
        />
        <Metric
          label="Sealed & signed"
          value={`${sealedPct}%`}
          hint={`${summary.manifests} manifest(s)`}
        />
        <Metric
          label="Integrity failures"
          value={String(summary.integrityFailures)}
          hint={summary.integrityFailures ? "Investigate immediately" : "None detected"}
        />
        <Metric
          label="Quarantined"
          value={String(summary.quarantined)}
          hint="Preserved, not normalised"
        />
        <Metric
          label="Latest capture"
          value={summary.latestIngestedAt ? formatUtc(summary.latestIngestedAt).slice(11, 16) : "—"}
          hint={
            summary.latestIngestedAt
              ? formatUtc(summary.latestIngestedAt).slice(0, 10) + " UTC"
              : "No evidence yet"
          }
        />
      </div>

      <EvidenceExplorer
        initialQuery={q}
        initialPage={page}
        errors={parsed.errors}
        canVerify={ctx.permissions.has("evidence:verify")}
      />
    </div>
  )
}

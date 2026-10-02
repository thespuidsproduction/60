"use client"

import { ShieldCheck } from "lucide-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { SectionLabel } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/ui/status-badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatBytes, formatUtc } from "@/lib/format"
import { severityTone, trustLevels } from "./labels"
import { VerificationSequence, type VerificationView } from "./verification-sequence"

interface Detail {
  raw: {
    id: string
    reference: string
    source: string
    source_api: string
    source_tenant: string
    source_object_id: string
    source_event_id: string | null
    object_type: string
    occurred_at: string | null
    observed_at: string
    ingested_at: string
    raw_sha256: string
    size_bytes: number
    trust_level: string
    classification: string
    retention_class: string
    storage_object_key: string
  }
  events: {
    id: string
    event_type: string
    category: string
    severity: string
    description: string
    subject_type: string | null
    subject_id: string | null
    asset_type: string | null
    asset_id: string | null
    time_confidence: string
    normalized_payload: unknown
    normalized_sha256: string
    schema_version: string
    transformer: string
    transformer_version: string
    created_at: string
  }[]
  verifications: { id: string; result: string; verified_by: string; verified_at: string }[]
  manifest: {
    id: string
    sequence: string
    merkle_root: string
    manifest_sha256: string
    signing_key_id: string
    period_start: string
    period_end: string
    item_count: number
    leaf_index: number
  } | null
  connector: { display_name: string; connector_type: string; connector_version: string } | null
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message ?? "Request failed.")
  return body as T
}

function Row({
  label,
  children,
  mono = true,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 border-b border-border-subtle/60 py-2 text-sm last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-[12.5px] break-all" : ""}>{children}</dd>
    </div>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[420px] overflow-auto rounded-md border border-border-subtle bg-app p-4 font-mono text-[12px] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function EvidencePanel({
  evidenceId,
  canVerify,
  onVerified,
}: {
  evidenceId: string
  canVerify: boolean
  onVerified?: (result: VerificationView["result"]) => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [raw, setRaw] = useState<{ envelope: unknown; sha256: string } | null>(null)
  const [rawError, setRawError] = useState<string | null>(null)
  const [verification, setVerification] = useState<VerificationView | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [animateKey, setAnimateKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    getJson<Detail>(`/api/v1/evidence/${evidenceId}`)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [evidenceId])

  const loadRaw = useCallback(() => {
    if (raw || rawError) return
    getJson<{ envelope: unknown; sha256: string }>(`/api/v1/evidence/${evidenceId}/raw`)
      .then(setRaw)
      .catch((e: Error) => setRawError(e.message))
  }, [evidenceId, raw, rawError])

  async function verify() {
    setVerifying(true)
    try {
      const result = await getJson<VerificationView>(`/api/v1/evidence/${evidenceId}/verify`, {
        method: "POST",
      })
      setVerification(result)
      setAnimateKey((k) => k + 1)
      onVerified?.(result.result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setVerifying(false)
    }
  }

  if (error) return <p className="px-6 py-5 text-sm text-critical">{error}</p>
  if (!detail) {
    return (
      <div className="space-y-3 px-6 py-6">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    )
  }

  const { raw: r, events, manifest } = detail
  const event = events[0]
  return (
    <Tabs defaultValue="overview" onValueChange={(tab) => tab === "raw" && loadRaw()}>
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="normalised">Normalised</TabsTrigger>
        <TabsTrigger value="raw">Raw source</TabsTrigger>
        <TabsTrigger value="integrity">Integrity</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        {event ? (
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-2">
              <StatusBadge
                tone={severityTone[event.severity] ?? "unknown"}
                label={event.severity}
              />
              <span className="font-mono text-xs text-muted">{event.event_type}</span>
            </div>
            <p className="text-base">{event.description}</p>
          </div>
        ) : null}
        <SectionLabel className="mb-2">Provenance</SectionLabel>
        <dl>
          <Row label="Evidence ID">{r.reference}</Row>
          <Row label="Source">{r.source}</Row>
          <Row label="Collected via">
            {detail.connector
              ? `${detail.connector.display_name} · ${detail.connector.connector_type} ${detail.connector.connector_version}`
              : "—"}
          </Row>
          <Row label="Source API">{r.source_api}</Row>
          <Row label="Source tenant">{r.source_tenant}</Row>
          <Row label="Source event ID">{r.source_event_id ?? "—"}</Row>
          <Row label="Source object ID">{r.source_object_id}</Row>
          <Row label="Object type">{r.object_type}</Row>
        </dl>
        <SectionLabel className="mt-6 mb-2">Time</SectionLabel>
        <dl>
          <Row label="Occurred">{formatUtc(r.occurred_at)}</Row>
          <Row label="Observed">{formatUtc(r.observed_at)}</Row>
          <Row label="Ingested">{formatUtc(r.ingested_at)}</Row>
          <Row label="Time confidence">{event?.time_confidence ?? "—"}</Row>
        </dl>
        <SectionLabel className="mt-6 mb-2">Object</SectionLabel>
        <dl>
          <Row label="SHA-256">{r.raw_sha256}</Row>
          <Row label="Size">{formatBytes(r.size_bytes)}</Row>
          <Row label="Trust level" mono={false}>
            <span className="font-mono">{r.trust_level}</span> · {trustLevels[r.trust_level]}
          </Row>
          <Row label="Classification">{r.classification}</Row>
          <Row label="Retention class">{r.retention_class}</Row>
        </dl>
        <SectionLabel className="mt-6 mb-2">Related</SectionLabel>
        <dl>
          <Row label="Identity">{event?.subject_id ?? "—"}</Row>
          <Row label="Asset">{event?.asset_id ?? "—"}</Row>
          <Row label="Manifest">
            {manifest ? `#${manifest.sequence} · leaf ${manifest.leaf_index}` : "Pending seal"}
          </Row>
        </dl>
      </TabsContent>

      <TabsContent value="normalised">
        {events.length === 0 ? (
          <p className="text-sm text-muted">
            No transformer is registered for this object type. The raw object is preserved and can
            be reprocessed when one is added.
          </p>
        ) : (
          events.map((e, index) => (
            <div key={e.id} className="mb-6">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusBadge
                  tone={index === 0 ? "accent" : "unknown"}
                  label={index === 0 ? "Current" : "Historical"}
                />
                <span className="font-mono text-xs">
                  {e.schema_version} · {e.transformer} {e.transformer_version}
                </span>
              </div>
              <dl className="mb-3">
                <Row label="Normalised SHA-256">{e.normalized_sha256}</Row>
                <Row label="Produced">{formatUtc(e.created_at)}</Row>
              </dl>
              <JsonBlock value={e.normalized_payload} />
            </div>
          ))
        )}
      </TabsContent>

      <TabsContent value="raw">
        {rawError ? (
          <p className="text-sm text-critical">{rawError}</p>
        ) : raw ? (
          <>
            <p className="mb-3 flex items-center gap-2 text-sm text-muted">
              <ShieldCheck className="size-4 text-[#8fd1b4]" aria-hidden />
              Bytes re-hashed and matched SHA-256{" "}
              <span className="font-mono text-xs">{raw.sha256.slice(0, 16)}…</span> before display.
            </p>
            <JsonBlock value={raw.envelope} />
          </>
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </TabsContent>

      <TabsContent value="integrity">
        <div className="mb-5 flex items-center justify-between gap-4">
          <p className="text-sm text-muted">
            Proves this artifact is unchanged since capture. It does not prove the upstream source
            was truthful.
          </p>
          {canVerify ? (
            <Button variant="primary" size="sm" onClick={verify} disabled={verifying}>
              {verifying ? "Verifying…" : "Run verification"}
            </Button>
          ) : null}
        </div>
        <VerificationSequence
          verification={verification}
          running={verifying}
          animateKey={animateKey}
        />
        {manifest ? (
          <>
            <SectionLabel className="mt-8 mb-2">Manifest</SectionLabel>
            <dl>
              <Row label="Sequence">#{manifest.sequence}</Row>
              <Row label="Period">
                {formatUtc(manifest.period_start, { seconds: false })} →{" "}
                {formatUtc(manifest.period_end, { seconds: false })}
              </Row>
              <Row label="Items">{manifest.item_count}</Row>
              <Row label="Merkle root">{manifest.merkle_root}</Row>
              <Row label="Manifest SHA-256">{manifest.manifest_sha256}</Row>
              <Row label="Signing key">{manifest.signing_key_id} · Ed25519</Row>
            </dl>
          </>
        ) : null}
        {detail.verifications.length ? (
          <>
            <SectionLabel className="mt-8 mb-2">Verification history</SectionLabel>
            <ul className="space-y-1 font-mono text-[12px]">
              {detail.verifications.map((v) => (
                <li key={v.id} className="flex justify-between gap-4 text-muted">
                  <span>{formatUtc(v.verified_at)}</span>
                  <span className="uppercase">{v.result}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </TabsContent>
    </Tabs>
  )
}

"use client"

import gsap from "gsap"
import { Search } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { useLayoutEffect, useRef, useState, type FormEvent } from "react"
import type { EvidenceListItem, SearchPage } from "@platform/evidence"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { StatusBadge } from "@/components/ui/status-badge"
import { Tooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import { formatUtc, shortHash } from "@/lib/format"
import { motion, prefersReducedMotion } from "@/lib/motion"
import { EvidencePanel } from "./evidence-panel"
import { integrityDisplay, severityTone, trustLevels } from "./labels"

const examples = [
  "identity:alice",
  "type:privilege_change",
  "severity:high between:02:00..03:00",
  "integrity:verified",
  "asset:SRV-ACME-DC01",
]

/**
 * Evidence Explorer (dev bible §19): power-user search over preserved evidence
 * with provenance, three timestamps, hash, integrity and trust on every row.
 */
export function EvidenceExplorer({
  initialQuery,
  initialPage,
  errors,
  canVerify,
}: {
  initialQuery: string
  initialPage: SearchPage
  errors: string[]
  canVerify: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [query, setQuery] = useState(initialQuery)
  const [items, setItems] = useState<EvidenceListItem[]>(initialPage.items)
  const [cursor, setCursor] = useState(initialPage.nextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<EvidenceListItem | null>(null)
  const table = useRef<HTMLTableSectionElement>(null)

  // Results stagger in softly; no flashing (§80).
  useLayoutEffect(() => {
    setItems(initialPage.items)
    setCursor(initialPage.nextCursor)
    if (!table.current || prefersReducedMotion()) return
    const context = gsap.context(() => {
      gsap.from("tr", {
        opacity: 0,
        y: 4,
        duration: motion.panel,
        stagger: 0.025,
        ease: "power2.out",
      })
    }, table)
    return () => context.revert()
  }, [initialPage])

  function submit(event: FormEvent) {
    event.preventDefault()
    router.push(query.trim() ? `${pathname}?q=${encodeURIComponent(query.trim())}` : pathname)
  }

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    const params = new URLSearchParams({ cursor })
    if (initialQuery) params.set("q", initialQuery)
    const response = await fetch(`/api/v1/evidence?${params}`)
    const page = (await response.json()) as SearchPage
    setItems((current) => [...current, ...page.items])
    setCursor(page.nextCursor)
    setLoadingMore(false)
  }

  return (
    <>
      <form onSubmit={submit} className="mb-3">
        <label htmlFor="evidence-query" className="sr-only">
          Evidence query
        </label>
        <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface px-4 transition-colors duration-[var(--motion-control)] focus-within:border-border-active">
          <Search className="size-4 shrink-0 text-muted" aria-hidden />
          <input
            id="evidence-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="identity:alice source:fixture type:privilege_change between:02:00..04:00"
            className="h-11 w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted/70"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted sm:block">
            ENTER
          </kbd>
        </div>
      </form>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => router.push(`${pathname}?q=${encodeURIComponent(example)}`)}
            className="rounded border border-border-subtle px-2 py-1 font-mono text-[11px] text-muted transition-colors duration-[var(--motion-control)] hover:border-border-active hover:text-fg"
          >
            {example}
          </button>
        ))}
      </div>

      {errors.length ? (
        <div role="alert" className="mb-6 rounded-md border border-warning/60 px-4 py-3 text-sm">
          <span className="font-mono text-xs tracking-wider text-warning uppercase">Query</span>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface shadow-[inset_0_1px_0_var(--highlight-inner)]">
        <table className="w-full min-w-[1080px] text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">
              <th className="px-4 py-3 font-normal">Evidence</th>
              <th className="px-4 py-3 font-normal">Occurred</th>
              <th className="px-4 py-3 font-normal">Event</th>
              <th className="px-4 py-3 font-normal">Identity / asset</th>
              <th className="px-4 py-3 font-normal">Source</th>
              <th className="px-4 py-3 font-normal">Trust</th>
              <th className="px-4 py-3 font-normal">SHA-256</th>
              <th className="px-4 py-3 font-normal">Integrity</th>
            </tr>
          </thead>
          <tbody ref={table}>
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted">
                  {errors.length
                    ? "Correct the query to see results."
                    : initialQuery
                      ? "No evidence matches this query."
                      : "No evidence has been captured yet. Evidence appears here once an integration completes its first sync."}
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const integrity = integrityDisplay[item.integrity]!
                return (
                  <tr
                    key={item.id}
                    tabIndex={0}
                    onClick={() => setSelected(item)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(item)}
                    className={cn(
                      "cursor-pointer border-b border-border-subtle/60 align-top transition-colors duration-[var(--motion-micro)] last:border-0 hover:bg-elevated/70 focus-visible:bg-elevated focus-visible:outline-none",
                      selected?.id === item.id && "bg-elevated",
                    )}
                  >
                    <td className="px-4 py-3 font-mono text-[12.5px] whitespace-nowrap">
                      {item.reference}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] whitespace-nowrap text-muted">
                      {formatUtc(item.occurredAt ?? item.observedAt)}
                    </td>
                    <td className="max-w-[380px] px-4 py-3">
                      <div className="flex items-center gap-2">
                        {item.severity ? (
                          <StatusBadge
                            tone={severityTone[item.severity] ?? "unknown"}
                            label={item.severity}
                          />
                        ) : null}
                        <span className="truncate font-mono text-[11px] text-muted">
                          {item.eventType ?? item.objectType}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px]">
                        {item.description ?? "Not normalised"}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px]">
                      <div className="truncate">{item.subjectId ?? "—"}</div>
                      {item.assetId ? (
                        <div className="truncate text-muted">{item.assetId}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-muted">{item.source}</td>
                    <td className="px-4 py-3">
                      <Tooltip content={trustLevels[item.trustLevel]}>
                        <span className="cursor-help rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[11px]">
                          {item.trustLevel}
                        </span>
                      </Tooltip>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-muted">
                      {shortHash(item.rawSha256, 10)}
                    </td>
                    <td className="px-4 py-3">
                      <Tooltip content={integrity.help}>
                        <span>
                          <StatusBadge tone={integrity.tone} label={integrity.label} />
                        </span>
                      </Tooltip>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div className="mt-4 flex justify-center">
          <Button onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.reference ?? ""}
        description={
          selected ? `${selected.source} · ${selected.eventType ?? selected.objectType}` : undefined
        }
      >
        {selected ? (
          <EvidencePanel
            key={selected.id}
            evidenceId={selected.id}
            canVerify={canVerify}
            onVerified={(result) => {
              // "pending" means not yet sealed: the list state is unchanged.
              if (result === "pending") return
              setItems((current) =>
                current.map((i) => (i.id === selected.id ? { ...i, integrity: result } : i)),
              )
            }}
          />
        ) : null}
      </Sheet>
    </>
  )
}

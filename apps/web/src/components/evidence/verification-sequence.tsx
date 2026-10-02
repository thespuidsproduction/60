"use client"

import gsap from "gsap"
import { Check, Clock3, Minus, X } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import { cn } from "@/lib/cn"
import { motion, prefersReducedMotion } from "@/lib/motion"
import { checkLabels } from "./labels"

export interface VerificationCheckView {
  check: string
  status: "passed" | "failed" | "pending" | "skipped"
  detail: string
}

export interface VerificationView {
  result: "verified" | "pending" | "failed"
  checks: VerificationCheckView[]
  verifiedAt: string
}

const order = [
  "SOURCE",
  "ORIGINAL_OBJECT",
  "RAW_HASH",
  "TIMESTAMP",
  "MANIFEST",
  "SIGNATURE",
  "CHAIN",
]

const glyph = {
  passed: <Check className="size-3.5" aria-hidden />,
  failed: <X className="size-3.5" aria-hidden />,
  pending: <Clock3 className="size-3.5" aria-hidden />,
  skipped: <Minus className="size-3.5" aria-hidden />,
}

const statusText = { passed: "✓", failed: "FAILED", pending: "PENDING", skipped: "—" }

/**
 * Verification chain (§15). Checks resolve sequentially while a thin warm-gold
 * line travels through the chain; passed checks settle into British Racing
 * Green, and the verdict appears last. Reduced motion renders the end state.
 */
export function VerificationSequence({
  verification,
  running,
  animateKey,
}: {
  verification: VerificationView | null
  running: boolean
  animateKey: number
}) {
  const root = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!root.current || !verification || animateKey === 0 || prefersReducedMotion()) return
    const context = gsap.context(() => {
      const rows = gsap.utils.toArray<HTMLElement>("[data-check]")
      const timeline = gsap.timeline()
      timeline.set(rows, { opacity: 0.25 })
      timeline.set("[data-verdict]", { opacity: 0, y: 6 })
      timeline.fromTo(
        "[data-line]",
        { scaleY: 0 },
        { scaleY: 1, duration: motion.graph, ease: "none", transformOrigin: "top" },
        0,
      )
      rows.forEach((row, index) => {
        timeline.to(
          row,
          { opacity: 1, duration: motion.micro },
          (index + 1) * (motion.graph / rows.length) - 0.05,
        )
      })
      timeline.to(
        "[data-verdict]",
        { opacity: 1, y: 0, duration: motion.panel, ease: "power2.out" },
        ">",
      )
    }, root)
    return () => context.revert()
  }, [animateKey, verification])

  const checks = order.map(
    (name) =>
      verification?.checks.find((c) => c.check === name) ?? {
        check: name,
        status: "skipped" as const,
        detail: running ? "Checking…" : "Not yet run",
      },
  )

  return (
    <div ref={root} className="relative">
      <div className="relative pl-6">
        <div aria-hidden className="absolute top-2 bottom-2 left-[7px] w-px bg-border-subtle" />
        <div
          aria-hidden
          data-line
          className={cn(
            "absolute top-2 bottom-2 left-[7px] w-px origin-top bg-accent",
            verification ? "opacity-100" : "opacity-0",
          )}
        />
        <ol className="space-y-1" aria-live="polite">
          {checks.map((check) => (
            <li key={check.check} data-check className="relative flex items-start gap-3 py-1.5">
              <span
                aria-hidden
                className={cn(
                  "absolute top-[11px] -left-6 grid size-[15px] place-items-center rounded-full border text-on-fill",
                  check.status === "passed" && "border-healthy-strong bg-healthy",
                  check.status === "failed" && "border-critical bg-critical",
                  check.status === "pending" && "border-border-subtle bg-elevated text-muted",
                  check.status === "skipped" && "border-border-subtle bg-app text-muted",
                )}
              >
                <span className="scale-75">{glyph[check.status]}</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 font-mono text-xs tracking-wider uppercase">
                  <span>{checkLabels[check.check] ?? check.check}</span>
                  <span
                    aria-hidden
                    className="mb-1 flex-1 border-b border-dotted border-border-subtle"
                  />
                  <span
                    className={cn(
                      check.status === "passed" && "text-[#8fd1b4]",
                      check.status === "failed" && "text-critical",
                      (check.status === "pending" || check.status === "skipped") && "text-muted",
                    )}
                  >
                    {statusText[check.status]}
                  </span>
                </div>
                <p
                  className="mt-0.5 truncate font-mono text-[11px] text-muted"
                  title={check.detail}
                >
                  {check.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {verification ? (
        <div
          data-verdict
          className={cn(
            "mt-4 flex items-center justify-between rounded-md border px-4 py-3",
            verification.result === "verified" && "border-healthy-strong bg-healthy text-on-fill",
            verification.result === "failed" && "border-critical bg-critical/15",
            verification.result === "pending" && "border-border-subtle bg-elevated",
          )}
        >
          <span className="font-mono text-sm tracking-[0.25em] uppercase">
            {verification.result === "pending" ? "Pending seal" : verification.result}
          </span>
          <span className="font-mono text-[11px] opacity-80">
            {new Date(verification.verifiedAt).toISOString().replace("T", " ").slice(0, 19)} UTC
          </span>
        </div>
      ) : null}
    </div>
  )
}

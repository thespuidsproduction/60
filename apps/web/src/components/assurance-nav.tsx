import Link from "next/link"
import { cn } from "@/lib/cn"

const items = [
  { key: "controls", label: "Controls" },
  { key: "evidence", label: "Evidence" },
  { key: "frameworks", label: "Frameworks" },
  { key: "attestations", label: "Attestations" },
  { key: "reports", label: "Reports" },
]

/** Assurance sub-navigation (§102). Unreleased areas are visible but not actionable (§89). */
export function AssuranceNav({ active }: { active: string }) {
  return (
    <nav aria-label="Assurance" className="mb-8 flex gap-1 border-b border-border-subtle">
      {items.map((item) =>
        item.key === active ? (
          <Link
            key={item.key}
            href={`/assurance/${item.key}`}
            aria-current="page"
            className="-mb-px border-b-2 border-accent px-3 py-2.5 text-sm text-fg"
          >
            {item.label}
          </Link>
        ) : (
          <span
            key={item.key}
            title="Functionality is currently in development."
            className={cn(
              "-mb-px cursor-not-allowed border-b-2 border-transparent px-3 py-2.5 text-sm text-muted/60",
            )}
          >
            {item.label}
          </span>
        ),
      )}
    </nav>
  )
}

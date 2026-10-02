import type { HTMLAttributes } from "react"
import { cn } from "@/lib/cn"

/** Matte surface, 1px subtle border, small inner highlight (§82). Not clickable by default. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border-subtle bg-surface shadow-[inset_0_1px_0_var(--highlight-inner)]",
        className,
      )}
      {...props}
    />
  )
}

export function SectionLabel({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("font-mono text-[11px] tracking-[0.18em] text-muted uppercase", className)}
      {...props}
    />
  )
}

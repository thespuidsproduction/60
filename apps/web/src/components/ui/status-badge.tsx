import { cn } from "@/lib/cn"

export type StatusTone = "healthy" | "warning" | "critical" | "unknown" | "accent" | "neutral"

const tones: Record<StatusTone, string> = {
  healthy: "border-healthy-strong bg-healthy text-on-fill",
  warning: "border-warning/60 text-warning",
  critical: "border-critical bg-critical/15 text-fg",
  unknown: "border-border-subtle text-muted",
  accent: "border-accent/60 text-accent",
  neutral: "border-border-subtle text-fg",
}

const dots: Record<StatusTone, string> = {
  healthy: "bg-[#8fd1b4]",
  warning: "bg-warning",
  critical: "bg-critical",
  unknown: "bg-unknown",
  accent: "bg-accent",
  neutral: "bg-muted",
}

/**
 * Status is never colour alone (§85): every badge carries its label, e.g. "● VERIFIED".
 */
export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone
  label: string
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10.5px] leading-none tracking-wider uppercase",
        tones[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", dots[tone])} />
      {label}
    </span>
  )
}

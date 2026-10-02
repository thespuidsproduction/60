import { cn } from "@/lib/cn"

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded bg-elevated motion-reduce:animate-none", className)}
    />
  )
}

import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Card } from "./card"

/** Professional empty / unavailable / error states (§137, §138). */
export function Notice({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
}) {
  return (
    <Card className="flex items-start gap-4 p-6">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      </div>
    </Card>
  )
}

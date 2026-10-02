import { Hammer } from "lucide-react"
import { FEATURE_UNAVAILABLE_MESSAGE } from "@platform/features"
import { SectionLabel } from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"

/** Standard surface for capability that is not yet exposed (§35, §89). */
export function InDevelopment({
  section,
  title,
  summary,
}: {
  section: string
  title: string
  summary: string
}) {
  return (
    <div className="max-w-3xl">
      <SectionLabel>{section}</SectionLabel>
      <h1 className="mt-2 mb-6 text-2xl font-semibold">{title}</h1>
      <Notice icon={Hammer} title={FEATURE_UNAVAILABLE_MESSAGE}>
        {summary}
      </Notice>
    </div>
  )
}

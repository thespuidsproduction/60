import { InDevelopment } from "@/components/in-development"

export default function AdminPage() {
  return (
    <InDevelopment
      section="Admin"
      title="Workspace Admin"
      summary="Integrations, connector health, customer mapping, users and retention. Connector health and failed jobs are already recorded and will surface here."
    />
  )
}

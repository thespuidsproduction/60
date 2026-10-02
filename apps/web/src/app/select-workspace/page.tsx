import { redirect } from "next/navigation"
import { AuthCard } from "@/components/auth-card"
import { services } from "@/server/services"
import { currentAuth } from "@/server/session"
import { WorkspaceList } from "./workspace-list"

export const dynamic = "force-dynamic"

export default async function SelectWorkspacePage() {
  const ctx = await currentAuth()
  if (!ctx) redirect("/login")
  if (ctx.state === "mfa_pending") redirect("/login/mfa")
  const workspaces = await services().auth.listWorkspaces(ctx)
  return (
    <AuthCard title="Select workspace">
      {workspaces.length === 0 ? (
        <p className="text-sm text-muted">
          Your account is not a member of any active workspace. Contact your administrator.
        </p>
      ) : (
        <WorkspaceList
          workspaces={workspaces.map((w) => ({ id: w.tenant_id, name: w.name, role: w.role }))}
        />
      )}
    </AuthCard>
  )
}

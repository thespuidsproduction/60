import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import type { ReactNode } from "react"
import { AppShell } from "@/components/shell/app-shell"
import { isThemeName, THEME_COOKIE } from "@/lib/themes"
import { workspaceName } from "@/server/authz"
import { currentAuth } from "@/server/session"

export const dynamic = "force-dynamic"

/**
 * Authenticated client-application shell. This redirect is navigation only;
 * every data access re-checks authorisation server-side (dev bible §64).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await currentAuth()
  if (!ctx) redirect("/login")
  if (ctx.state === "mfa_pending") redirect("/login/mfa")
  if (!ctx.tenantId) redirect("/select-workspace")
  const stored = (await cookies()).get(THEME_COOKIE)?.value
  return (
    <AppShell
      workspace={await workspaceName(ctx)}
      user={{ name: ctx.displayName, role: ctx.role ?? "" }}
      theme={isThemeName(stored) ? stored : "midnight"}
    >
      {children}
    </AppShell>
  )
}

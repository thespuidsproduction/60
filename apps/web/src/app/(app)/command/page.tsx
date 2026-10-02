import { currentAuth } from "@/server/session"
import { SignOutButton } from "./sign-out"

export default async function CommandPage() {
  const ctx = (await currentAuth())!
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Command</p>
      <h1 className="mt-2 text-2xl font-semibold">Signed in as {ctx.displayName}</h1>
      <p className="mt-2 text-muted">
        Role <span className="font-mono">{ctx.role}</span>. Dashboards are not yet exposed in this
        workspace.
      </p>
      <SignOutButton />
    </main>
  )
}

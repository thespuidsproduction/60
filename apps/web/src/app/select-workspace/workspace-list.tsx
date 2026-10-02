"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { FormError, postJson } from "@/components/form"

export function WorkspaceList({
  workspaces,
}: {
  workspaces: { id: string; name: string; role: string }[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function choose(tenantId: string) {
    try {
      await postJson("/api/auth/tenant", { tenantId })
      router.push("/command")
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <FormError message={error} />
      <ul className="space-y-2">
        {workspaces.map((w) => (
          <li key={w.id}>
            <button
              onClick={() => choose(w.id)}
              className="flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left transition-colors duration-[var(--motion-control)] hover:border-border-active"
            >
              <span>{w.name}</span>
              <span className="font-mono text-xs text-muted">{w.role}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

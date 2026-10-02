"use client"

import { LogOut } from "lucide-react"
import { useRouter } from "next/navigation"
import { postJson } from "@/components/form"

export function UserMenu({ name, role }: { name: string; role: string }) {
  const router = useRouter()
  return (
    <div className="flex items-center gap-3">
      <div className="text-right leading-tight">
        <p className="text-sm">{name}</p>
        <p className="font-mono text-[10.5px] tracking-wider text-muted">{role}</p>
      </div>
      <button
        type="button"
        onClick={async () => {
          await postJson("/api/auth/logout")
          router.push("/login")
        }}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-[var(--motion-control)] hover:bg-elevated hover:text-fg"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="size-4" />
      </button>
    </div>
  )
}

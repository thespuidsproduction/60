"use client"

import { useRouter } from "next/navigation"
import { postJson } from "@/components/form"

export function SignOutButton() {
  const router = useRouter()
  return (
    <button
      onClick={async () => {
        await postJson("/api/auth/logout")
        router.push("/login")
      }}
      className="mt-6 rounded-md border border-border-subtle px-3 py-2 text-sm transition-colors duration-[var(--motion-control)] hover:border-border-active"
    >
      Sign out
    </button>
  )
}

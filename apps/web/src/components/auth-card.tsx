import type { ReactNode } from "react"
import { loadBrand } from "@platform/shared"

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const brand = loadBrand()
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 shadow-[inset_0_1px_0_var(--highlight-inner)]">
        <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">
          {brand.productName}
        </p>
        <h1 className="mt-2 mb-6 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  )
}

import type { ReactNode } from "react"
import { loadBrand } from "@platform/shared"
import type { ThemeName } from "@/lib/themes"
import { Nav } from "./nav"
import { ThemeToggle } from "./theme-toggle"
import { UserMenu } from "./user-menu"

export function AppShell({
  workspace,
  user,
  theme,
  children,
}: {
  workspace: string
  user: { name: string; role: string }
  theme: ThemeName
  children: ReactNode
}) {
  const brand = loadBrand()
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-border-subtle bg-app max-lg:hidden">
        <div className="px-6 pt-6 pb-8">
          <p className="font-mono text-xs tracking-[0.3em] text-fg uppercase">
            {brand.productName}
          </p>
          <p className="mt-1 truncate text-xs text-muted" title={workspace}>
            {workspace}
          </p>
        </div>
        <Nav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-2 border-b border-border-subtle bg-app/85 px-6 backdrop-blur">
          <ThemeToggle initial={theme} />
          <div className="mx-2 h-6 w-px bg-border-subtle" />
          <UserMenu name={user.name} role={user.role} />
        </header>
        <main className="min-w-0 flex-1 px-8 py-8 max-md:px-4">{children}</main>
      </div>
    </div>
  )
}

"use client"

import { Activity, Gauge, ShieldCheck, Siren, Settings2, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/cn"

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  match: string
}

/** Client navigation (§87). Visibility is navigation only — every page re-authorises server-side. */
const product: NavItem[] = [
  { href: "/command", label: "Command", icon: Gauge, match: "/command" },
  { href: "/incidents", label: "Incidents", icon: Siren, match: "/incidents" },
  { href: "/assurance/evidence", label: "Assurance", icon: ShieldCheck, match: "/assurance" },
]
const admin: NavItem[] = [{ href: "/admin", label: "Admin", icon: Settings2, match: "/admin" }]

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname()
  const active = pathname === item.match || pathname.startsWith(`${item.match}/`)
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm tracking-wide transition-colors duration-[var(--motion-control)]",
        active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/60 hover:text-fg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1.5 left-0 w-0.5 rounded-full transition-colors duration-[var(--motion-control)]",
          active ? "bg-accent" : "bg-transparent",
        )}
      />
      <item.icon className={cn("size-4", active ? "text-accent" : "")} aria-hidden />
      <span className="uppercase">{item.label}</span>
    </Link>
  )
}

export function Nav() {
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 px-3">
      {product.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}
      <div className="my-3 border-t border-border-subtle" />
      {admin.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}
      <div className="mt-auto flex items-center gap-2 px-3 pb-4 font-mono text-[10.5px] text-muted">
        <Activity className="size-3.5" aria-hidden />
        <span>Read-only evidence witness</span>
      </div>
    </nav>
  )
}

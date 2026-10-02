import type { Metadata } from "next"
import { cookies } from "next/headers"
import type { ReactNode } from "react"
import { loadBrand } from "@platform/shared"
import "@fontsource-variable/manrope"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "../styles/globals.css"
import { isThemeName, THEME_COOKIE } from "@/lib/themes"

const brand = loadBrand()

export const metadata: Metadata = {
  title: brand.productName,
  description: "Cyber-resilience evidence and incident operations.",
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const stored = (await cookies()).get(THEME_COOKIE)?.value
  const theme = isThemeName(stored) ? stored : "midnight"
  return (
    <html lang="en-GB" data-theme={theme}>
      <body className="min-h-screen">{children}</body>
    </html>
  )
}

import type { Metadata } from "next"
import type { ReactNode } from "react"
import { loadBrand } from "@platform/shared"
import "@fontsource-variable/manrope"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "../styles/globals.css"

const brand = loadBrand()

export const metadata: Metadata = {
  title: brand.productName,
  description: "Cyber-resilience evidence and incident operations.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" data-theme="midnight">
      <body className="min-h-screen">{children}</body>
    </html>
  )
}

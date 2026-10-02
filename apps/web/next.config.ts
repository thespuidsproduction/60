import type { NextConfig } from "next"

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@platform/shared",
    "@platform/db",
    "@platform/auth",
    "@platform/audit",
    "@platform/features",
  ],
  serverExternalPackages: ["pg"],
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ]
  },
}

export default config

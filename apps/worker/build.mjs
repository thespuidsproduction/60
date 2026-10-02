import { build } from "esbuild"

// Bundles workspace TypeScript (@platform/*) into a single ESM file. Third-party npm
// dependencies stay external and are installed in the runtime image.
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [
    {
      name: "externalise-npm-dependencies",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@platform/")) return undefined
          return { path: args.path, external: true }
        })
      },
    },
  ],
})

import { build } from "esbuild"

// Bundles the worker and all of its dependencies into one ESM file so the
// runtime image needs no node_modules. Optional native add-ons stay external
// (their libraries fall back to pure JavaScript when absent).
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "linked",
  external: ["pg-native", "msgpackr-extract"],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_ } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_(__filename);",
    ].join("\n"),
  },
})

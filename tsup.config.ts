import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

// One package, every host adapter. Each module is its own entry so subpath
// imports (`@demlik/tea/react`, `@demlik/tea/do`, …) tree-shake independently.
// Output mirrors src/ structure; the entry KEY is the dist path.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "testing/index": "src/testing/index.ts",
    "do/index": "src/do/index.ts",
    "mem/index": "src/mem/index.ts",
    "react/index": "src/react/index.ts",
    "devtools/index": "src/devtools/index.ts",
    "extension/index": "src/extension/index.ts",
    "node/index": "src/node/index.ts",
    "pbt/index": "src/pbt/index.ts",
    "retry-backoff/index": "src/retry-backoff/index.ts",
    "machine-viz/index": "src/machine-viz/index.ts",
    "agent/index": "src/agent/index.ts",
    "parity/index": "src/parity/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true, // dedupe the shared core into a chunk across entries
  treeshake: true,
  clean: true,
  sourcemap: true,
  platform: "neutral", // mixed targets (browser / Workers / Node) — keep imports external
  target: "es2022",
  // Host runtime + node builtins are provided by the host, never bundled.
  external: [/^cloudflare:/, /^node:/],
  onSuccess: async () => {
    // devtools ships a standalone stylesheet consumers import directly.
    mkdirSync("dist/devtools", { recursive: true });
    copyFileSync("src/devtools/styles.css", "dist/devtools/styles.css");
  },
});

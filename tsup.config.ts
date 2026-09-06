import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

// One package, every host adapter. Each module is its own entry so subpath
// imports (`@demlik/tea/react`, `@demlik/tea/do`, …) tree-shake independently.
// Output mirrors src/ structure; the entry KEY is the dist path.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "subs/index": "src/subs/index.ts",
    "testing/index": "src/testing/index.ts",
    "do/index": "src/do/index.ts",
    "mem/index": "src/mem/index.ts",
    "react/index": "src/react/index.ts",
    "devtools/index": "src/devtools/index.ts",
    "extension/index": "src/extension/index.ts",
    "extension/react": "src/extension/react.tsx",
    "extension/subs/index": "src/extension/subs/index.ts",
    "extension/test-utils": "src/extension/test-utils.ts",
    "node/index": "src/node/index.ts",
    "pbt/index": "src/pbt/index.ts",
    "pbt/arbitraries/index": "src/pbt/arbitraries/index.ts",
    "pbt/runners/index": "src/pbt/runners/index.ts",
    "retry-backoff/index": "src/retry-backoff/index.ts",
    "machine-viz/index": "src/machine-viz/index.ts",
    "agent/index": "src/agent/index.ts",
    "pure/index": "src/pure/index.ts",
    "parity/index": "src/parity/index.ts",
    "chart/index": "src/chart/index.ts",
    "chart/inspect/index": "src/chart/inspect/index.ts",
    "chart/inspect/react": "src/chart/inspect/react.tsx",
    "chart/report/index": "src/chart/report/index.ts",
    "chart/lane/index": "src/chart/lane/index.ts",
    "chart/lane/react": "src/chart/lane/react.tsx",
    "chart/lane/server": "src/chart/lane/server.ts",
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
    // chart/inspect ships its own companion stylesheet, same contract.
    mkdirSync("dist/chart/inspect", { recursive: true });
    copyFileSync(
      "src/chart/inspect/styles.css",
      "dist/chart/inspect/styles.css",
    );
    // chart/lane's page ships its own, standalone — it renders no devtools
    // component, so it is not a companion to anything.
    mkdirSync("dist/chart/lane", { recursive: true });
    copyFileSync("src/chart/lane/styles.css", "dist/chart/lane/styles.css");
  },
});

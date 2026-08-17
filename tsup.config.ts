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
    "work-queue/index": "src/work-queue/index.ts",
    "work-queue/ops": "src/work-queue/ops.ts",
    "work-queue/adapter": "src/work-queue/adapter.ts",
    "node/index": "src/node/index.ts",
    "pbt/index": "src/pbt/index.ts",
    "pbt/arbitraries/index": "src/pbt/arbitraries/index.ts",
    "pbt/runners/index": "src/pbt/runners/index.ts",
    "retry-backoff/index": "src/retry-backoff/index.ts",
    "rate-limit/index": "src/rate-limit/index.ts",
    "idempotency/index": "src/idempotency/index.ts",
    "idempotency/adapter": "src/idempotency/adapter.ts",
    "circuit-breaker/index": "src/circuit-breaker/index.ts",
    "cache/index": "src/cache/index.ts",
    "deadline/index": "src/deadline/index.ts",
    "await-terminal/index": "src/await-terminal/index.ts",
    "retry-to-success/index": "src/retry-to-success/index.ts",
    "machine-viz/index": "src/machine-viz/index.ts",
    "debounce/index": "src/debounce/index.ts",
    "throttle/index": "src/throttle/index.ts",
    "recorder/index": "src/recorder/index.ts",
    "trace-replay/index": "src/trace-replay/index.ts",
    "paginator/index": "src/paginator/index.ts",
    "snapshot/index": "src/snapshot/index.ts",
    "token-refresh/index": "src/token-refresh/index.ts",
    "resilient-call/index": "src/resilient-call/index.ts",
    "with-telemetry/index": "src/with-telemetry/index.ts",
    "fan-out/index": "src/fan-out/index.ts",
    "idempotent-intake/index": "src/idempotent-intake/index.ts",
    "poller/index": "src/poller/index.ts",
    "batch-window/index": "src/batch-window/index.ts",
    "saga/index": "src/saga/index.ts",
    "workflow/index": "src/workflow/index.ts",
    "throttled-input/index": "src/throttled-input/index.ts",
    "monitored-run/index": "src/monitored-run/index.ts",
    "llm-call/index": "src/llm-call/index.ts",
    "paginated-walk/index": "src/paginated-walk/index.ts",
    "authed-call/index": "src/authed-call/index.ts",
    "reconciler/index": "src/reconciler/index.ts",
    "agent/index": "src/agent/index.ts",
    "with-deadline/index": "src/with-deadline/index.ts",
    "with-resilience/index": "src/with-resilience/index.ts",
    "prediction/index": "src/prediction/index.ts",
    "pure/index": "src/pure/index.ts",
    "parity/index": "src/parity/index.ts",
    "chart/index": "src/chart/index.ts",
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

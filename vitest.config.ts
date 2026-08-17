import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string =>
  fileURLToPath(new URL(`./src/${p}`, import.meta.url));

// Pure-module test runner. New behavior modules (retry-backoff, rate-limit,
// circuit-breaker, idempotency, deadline, cache, debounce, throttle,
// recorder, trace-replay, machine-viz) are host-agnostic and test in plain
// node — no happy-dom, no Workers pool. Test files are excluded from the
// published tarball (package.json `files: ["dist"]`) and from `tsc`/`tsup`.
export default defineConfig({
  // `src/chart/equiv-*.test.ts` drive the REAL `examples/*.ts` machines against
  // their chart ports, and those examples import the PUBLISHED specifier. Point
  // it at `src/` so the suite needs no prior `pnpm build` — and so both sides of
  // the equivalence run on the same substrate rather than one on dist and one
  // on source. Nothing under `src/` imports `@demlik/tea`, so no other test is
  // affected.
  resolve: {
    alias: [
      { find: /^@demlik\/tea$/, replacement: src("index.ts") },
      { find: /^@demlik\/tea\/(.*)$/, replacement: src("$1/index.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Pin fast-check's seed + raise numRuns so the property suite is
    // reproducible and deeper — no random-seed intermittent reds. See
    // `src/test-setup.ts`.
    setupFiles: ["./src/test-setup.ts"],
  },
});

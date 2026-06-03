import { defineConfig } from "vitest/config";

// Pure-module test runner. New behavior modules (retry-backoff, rate-limit,
// circuit-breaker, idempotency, deadline, cache, debounce, throttle,
// recorder, trace-replay, machine-viz) are host-agnostic and test in plain
// node — no happy-dom, no Workers pool. Test files are excluded from the
// published tarball (package.json `files: ["dist"]`) and from `tsc`/`tsup`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});

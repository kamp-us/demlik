import { defineConfig } from "vitest/config";

// One run over every package, each under its own `vitest.config.ts`, so CI's
// JUnit report and fabrika's run-evidence cover the whole workspace at once.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});

import { defineConfig } from "vitest/config";

// One run over every package, each under its own `vitest.config.ts`, so CI's
// JUnit report and fabrika's run-evidence cover the whole workspace at once.
// `scripts` is the root's own tooling (publish-pending, #372), tested here so a
// release-path script is exercised on every PR rather than first on main.
export default defineConfig({
  test: {
    projects: [
      "packages/*",
      { test: { name: "scripts", include: ["scripts/**/*.test.mjs"] } },
    ],
  },
});

import { defineConfig } from "vitest/config";

// The example carries its own runner: the repo root config scopes itself to
// `src/**`, and this project is deliberately outside that tree.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

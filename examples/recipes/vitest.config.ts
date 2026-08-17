import { defineConfig } from "vitest/config";

// The recipes carry their own runner: the repo root config scopes itself to
// `src/**`, and these examples are deliberately outside that tree.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
  },
});

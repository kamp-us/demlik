import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});

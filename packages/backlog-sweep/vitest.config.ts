import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The same source mapping tsconfig.json's `paths` makes: CI tests before it builds.
  resolve: {
    alias: {
      "@demlik/tea/jev": source("../tea/src/jev/index.ts"),
      "@demlik/tea/retry-backoff": source("../tea/src/retry-backoff/index.ts"),
    },
  },
  test: {
    globals: false,
    include: ["test/**/*.test.ts"],
  },
});

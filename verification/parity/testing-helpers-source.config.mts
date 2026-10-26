import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: "target/parity/testing-helpers-vite-cache",
  test: {
    include: ["verification/parity/testing-helpers-source.test.mts"],
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
  },
});

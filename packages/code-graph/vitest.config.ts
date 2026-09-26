import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // The parity fixture is source code the CLI reads, not tests to run.
    exclude: [...configDefaults.exclude, "test/parity/fixture/**"],
  },
});

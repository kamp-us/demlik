import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    resolve: "src/resolve.ts",
    project: "src/project.ts",
    boundaries: "src/boundaries/ledger.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});

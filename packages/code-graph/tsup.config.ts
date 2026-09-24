import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", resolve: "src/resolve.ts", project: "src/extract/project.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});

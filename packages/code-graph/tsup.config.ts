import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    resolve: "src/resolve.ts",
    project: "src/project.ts",
    scc: "src/scc.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});

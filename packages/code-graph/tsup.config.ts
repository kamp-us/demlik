import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/resolve.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});

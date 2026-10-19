import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

if (!process.argv[2])
  throw new Error(
    "Usage: node packages/tea/examples/retained-case/run.mjs CASE_DIRECTORY",
  );
const root = fileURLToPath(new URL("../..", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "tea-retained-example-"));
try {
  await build({
    configFile: join(root, "vitest.config.ts"),
    root,
    logLevel: "error",
    ssr: { noExternal: true },
    build: {
      ssr: join(root, "examples/agent-retained-case.ts"),
      outDir: output,
      rollupOptions: { output: { entryFileNames: "case.mjs", format: "es" } },
    },
  });
  await import(pathToFileURL(join(output, "case.mjs")).href);
} finally {
  await rm(output, { recursive: true, force: true });
}

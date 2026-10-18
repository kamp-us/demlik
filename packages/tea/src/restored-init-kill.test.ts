import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("restored init with a fast Sub", () => {
  let work: string;
  let entry: string;
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "tea-restored-init-"));
    await build({
      configFile: false,
      logLevel: "error",
      ssr: { noExternal: true },
      build: {
        ssr: fileURLToPath(
          new URL("./effect/fixtures/restored-init-child.ts", import.meta.url),
        ),
        outDir: join(work, "bundle"),
        rollupOptions: { output: { entryFileNames: "child.mjs" } },
      },
    });
    entry = join(work, "bundle/child.mjs");
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it.each([
    "promise",
    "effect",
  ])("%s writes once in each of three SIGKILLed and restored lives without a host latch", async (engine) => {
    const dir = join(work, engine);
    await mkdir(dir);
    const stateFile = join(dir, "state.json");
    const writesFile = join(dir, "writes.log");
    await writeFile(
      stateFile,
      JSON.stringify({ type: "pending", life: 0, pulses: 0 }),
    );
    for (let life = 1; life <= 3; life++) {
      let output = "";
      const child = spawn(
        process.execPath,
        [entry, engine, String(life), stateFile, writesFile],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.on("exit", (_code, signal) => resolve(signal));
      });
      const ready = new Promise<unknown>((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`child exited ${code}: ${output}`)),
        );
      });
      try {
        const state = { type: "working", life, pulses: 1 };
        expect(await ready).toEqual({ type: "settled", state });
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(state);
        expect((await readFile(writesFile, "utf8")).trim().split("\n")).toEqual(
          Array.from({ length: life }, (_, i) => String(i + 1)),
        );
      } finally {
        child.kill("SIGKILL");
        expect(await exited).toBe("SIGKILL");
      }
    }
  });
});

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Checkpoint, Handshake } from "./fixtures/interrupted-tool-recovery";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/interrupted-tool-recovery.ts", import.meta.url),
);
type Kind = "append" | "keyed";
type Cut = "before_execution" | "after_acceptance" | "before_settlement";

interface ProcessRun {
  readonly child: ChildProcess;
  readonly checkpoint: Promise<string>;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  readonly output: () => string;
}

async function lines(path: string) {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  });
  return raw === "" ? [] : raw.trimEnd().split("\n");
}

describe(
  "interrupted tool acceptance — controlled consumer proof (#594)",
  { timeout: 60_000 },
  () => {
    let work: string;
    let entry: string;
    const children = new Set<ProcessRun>();

    function launch(
      directory: string,
      kind: Kind,
      cut: Cut | "finish",
      callId = "c1",
      text = "one note",
    ): ProcessRun {
      const child = spawn(
        process.execPath,
        [entry, directory, kind, cut, callId, "operation-1", text],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      let output = "";
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const checkpoint = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`checkpoint deadline: ${output}`));
        }, 20_000);
        child.on("message", (raw: unknown) => {
          const parsed = Handshake.safeParse(raw);
          if (!parsed.success) return;
          clearTimeout(timeout);
          resolve(parsed.data.point);
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `exited before checkpoint (${code}, ${signal}): ${output}`,
            ),
          );
        });
      });
      const launched = { child, checkpoint, exited, output: () => output };
      children.add(launched);
      void exited.then(() => children.delete(launched));
      return launched;
    }

    beforeAll(async () => {
      work = await mkdtemp(join(tmpdir(), "tea-interrupted-tool-"));
      const cache = join(work, "bundle");
      await build({
        configFile: join(repo, "vitest.config.ts"),
        root: repo,
        logLevel: "error",
        ssr: { noExternal: ["zod"] },
        build: {
          ssr: fixture,
          outDir: cache,
          emptyOutDir: true,
          minify: false,
          rollupOptions: {
            output: { entryFileNames: "fixture.mjs", format: "es" },
          },
        },
      });
      entry = join(cache, "fixture.mjs");
    }, 60_000);

    afterAll(async () => {
      const live = [...children];
      for (const running of live) running.child.kill("SIGKILL");
      await Promise.all(live.map((running) => running.exited));
      if (work !== undefined) await rm(work, { recursive: true, force: true });
    });

    it.each<readonly [Kind, Cut, number]>([
      ["append", "before_execution", 1],
      ["append", "after_acceptance", 4],
      ["append", "before_settlement", 4],
      ["keyed", "before_execution", 1],
      ["keyed", "after_acceptance", 1],
      ["keyed", "before_settlement", 1],
    ])("%s / %s: three recoveries leave %i accepted notes", async (kind, cut, count) => {
      const directory = join(work, `${kind}-${cut}`);
      await mkdir(directory);
      for (let cycle = 0; cycle < 3; cycle++) {
        const running = launch(directory, kind, cut);
        expect(await running.checkpoint, running.output()).toBe(cut);
        const saved = Checkpoint.parse(
          JSON.parse(await readFile(join(directory, "c1.state.json"), "utf8")),
        );
        expect(saved).toEqual({
          type: "Pending",
          intent: {
            callId: "c1",
            args: { operationId: "operation-1", text: "one note" },
          },
        });
        const accepted =
          kind === "append"
            ? (await lines(join(directory, "notes.txt"))).length
            : (await readdir(directory)).filter((p) =>
                p.endsWith(".receipt.json"),
              ).length;
        expect(accepted).toBe(
          cut === "before_execution" ? 0 : kind === "append" ? cycle + 1 : 1,
        );
        running.child.kill("SIGKILL");
        expect(await running.exited).toEqual({ code: null, signal: "SIGKILL" });
      }
      const recovered = launch(directory, kind, "finish");
      expect(await recovered.checkpoint, recovered.output()).toBe("done");
      expect(await recovered.exited).toEqual({ code: 0, signal: null });
      expect(await lines(join(directory, "calls.log"))).toEqual([
        "c1",
        "c1",
        "c1",
        "c1",
      ]);
      const saved = Checkpoint.parse(
        JSON.parse(await readFile(join(directory, "c1.state.json"), "utf8")),
      );
      expect(saved.type).toBe("Settled");
      if (kind === "append") {
        expect(await lines(join(directory, "notes.txt"))).toEqual(
          Array(count).fill("one note"),
        );
      } else {
        expect(
          (await readdir(directory)).filter((p) => p.endsWith(".receipt.json")),
        ).toEqual(["operation-1.receipt.json"]);
        expect(
          JSON.parse(
            await readFile(join(directory, "operation-1.receipt.json"), "utf8"),
          ),
        ).toEqual({ operationId: "operation-1", text: "one note" });
      }
      const settled = launch(directory, kind, "finish");
      expect(await settled.checkpoint, settled.output()).toBe("done");
      expect(await settled.exited).toEqual({ code: 0, signal: null });
      expect(await lines(join(directory, "calls.log"))).toHaveLength(4);
    });

    it("a business key survives new callIds and refuses a conflicting payload", async () => {
      const directory = join(work, "business-identity");
      await mkdir(directory);
      for (const [callId, text] of [
        ["c1", "one note"],
        ["c2", "one note"],
        ["c3", "a different note"],
      ]) {
        const running = launch(directory, "keyed", "finish", callId, text);
        expect(await running.checkpoint, running.output()).toBe("done");
        expect(await running.exited).toEqual({ code: 0, signal: null });
        const saved = Checkpoint.parse(
          JSON.parse(
            await readFile(join(directory, `${callId}.state.json`), "utf8"),
          ),
        );
        expect(saved.type).toBe(callId === "c3" ? "Failed" : "Settled");
        if (saved.type === "Failed") {
          expect(saved.failure).toEqual({
            _tag: "key_conflict",
            operationId: "operation-1",
          });
        }
      }
      expect(
        JSON.parse(
          await readFile(join(directory, "operation-1.receipt.json"), "utf8"),
        ),
      ).toEqual({ operationId: "operation-1", text: "one note" });
      expect(await lines(join(directory, "calls.log"))).toEqual([
        "c1",
        "c2",
        "c3",
      ]);
    });
  },
);

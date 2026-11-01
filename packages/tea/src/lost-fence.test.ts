/**
 * What one run's failure does to the process it shares (#728, ADR 0031). Only a
 * real process can show this: the default sink's rethrow ends the process, so
 * the fixture runs in children and the test reads how each one exited.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Message = { readonly type: string } & Record<string, unknown>;

interface Child {
  readonly process: ChildProcess;
  readonly messages: Message[];
  readonly stderr: () => string;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly next: (type: string) => Promise<Message>;
}

let work: string;
let entry: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "tea-lost-fence-"));
  await build({
    configFile: false,
    logLevel: "error",
    ssr: { noExternal: true },
    build: {
      ssr: fileURLToPath(
        new URL("./effect/fixtures/lost-fence-child.ts", import.meta.url),
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

function launch(engine: string, mode: string, dir: string): Child {
  const child = spawn(process.execPath, [entry, engine, mode, dir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  child.on("message", (message) => messages.push(message as Message));
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const next = (type: string) =>
    new Promise<Message>((resolve, reject) => {
      const seen = messages.find((message) => message.type === type);
      if (seen !== undefined) return resolve(seen);
      child.on("message", (message) => {
        if ((message as Message).type === type) resolve(message as Message);
      });
      void exited.then(({ code }) =>
        reject(new Error(`child exited ${code} before "${type}": ${stderr}`)),
      );
    });
  return { process: child, messages, stderr: () => stderr, exited, next };
}

const countIn = async (dir: string, name: string): Promise<number> =>
  JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")).count;

describe.each(["promise", "effect"] as const)("on the %s engine", (engine) => {
  it("three fenced runs in one process: losing one to a second process leaves the process and the other two running", async () => {
    const dir = join(work, `${engine}-host`);
    await mkdir(dir);
    const host = launch(engine, "host", dir);
    try {
      await host.next("ready");

      const second = launch(engine, "takeover", dir);
      expect(await second.exited).toEqual({ code: 0, signal: null });
      const takenAt = await countIn(dir, "b");
      expect(takenAt).toBe(2);

      host.process.send({ type: "taken" });
      const result = await host.next("result");

      // The two other runs folded and saved before and after the loss.
      expect(result.before).toEqual(["ok", "ok"]);
      expect(result.after).toEqual(["ok", "ok"]);
      expect(result.counts).toEqual({ a: 3, c: 3 });

      // The lost run: a Msg before `stop()` is refused, one after it is too, and
      // both failures with no caller to reject at reach the sink.
      expect(result.msgBeforeStop).toBe("store_conflict");
      expect(result.msgAfterStop).not.toBe("ok");
      expect(result.reports).toEqual(
        expect.arrayContaining([
          { phase: "follow-up", error: "store_conflict" },
          { phase: "stop-save", error: "store_conflict" },
        ]),
      );

      // The process outlived all of it and ended on its own.
      expect(await host.exited).toEqual({ code: 0, signal: null });
      expect(host.stderr()).toBe("");

      // What is on disk: the others' saves landed, and the taker's stands.
      expect(await countIn(dir, "a")).toBe(3);
      expect(await countIn(dir, "c")).toBe(3);
      expect(await countIn(dir, "b")).toBe(takenAt);
    } finally {
      host.process.kill("SIGKILL");
    }
  });

  it('a failing Sub with no `onError` ends the process: the default sink rethrows `"sub"`', async () => {
    const dir = join(work, `${engine}-sub`);
    await mkdir(dir);
    const child = launch(engine, "failing-sub", dir);

    expect(await child.exited).toMatchObject({ code: 1, signal: null });
    expect(child.stderr()).toContain("the sub failed");
    expect(child.messages).toEqual([]);
  });

  it('a failing Sub with an `onError` reaches it under `"sub"`, and the process stays up', async () => {
    const dir = join(work, `${engine}-sub-sink`);
    await mkdir(dir);
    const child = launch(engine, "failing-sub-with-sink", dir);

    expect(await child.next("alive")).toEqual({ type: "alive" });
    expect(await child.exited).toEqual({ code: 0, signal: null });
    expect(child.messages[0]).toEqual({
      type: "heard",
      phase: "sub",
      message: "the sub failed",
    });
  });
});

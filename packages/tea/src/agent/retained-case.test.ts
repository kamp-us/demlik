import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileJournal } from "@demlik/tea/node";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  committedView,
  fixturePorts,
  runFixture,
  verifyCase,
} from "../../examples/retained-case/fixture";
import {
  type CaseJournal,
  caseResponse,
  MAX_PENDING_VIEWS,
  openCase,
} from "../../examples/retained-case/host";
import { parseRecord } from "../../examples/retained-case/source";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function messageFrom(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const collect = (bytes: Buffer) => {
      stderr += bytes.toString();
    };
    const cleanup = () => {
      child.stderr?.off("data", collect);
      child.off("error", failed);
      child.off("exit", exited);
      child.off("message", received);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      failed(
        new Error(
          `fixture exited before its message (${code ?? signal}): ${stderr}`,
        ),
      );
    };
    const received = (message: unknown) => {
      cleanup();
      resolve(message);
    };
    child.stderr?.on("data", collect);
    child.once("error", failed);
    child.once("exit", exited);
    child.once("message", received);
  });
}

describe("the retained investigation case", { timeout: 30_000 }, () => {
  let work: string;
  let entry: string;
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "tea-retained-case-"));
    const root = fileURLToPath(new URL("../..", import.meta.url));
    await build({
      configFile: join(root, "vitest.config.ts"),
      root,
      logLevel: "error",
      ssr: { noExternal: true },
      build: {
        ssr: fileURLToPath(
          new URL(
            "../../examples/retained-case/kill-fixture.ts",
            import.meta.url,
          ),
        ),
        outDir: join(work, "bundle"),
        rollupOptions: {
          output: { entryFileNames: "child.mjs", format: "es" },
        },
      },
    });
    entry = join(work, "bundle/child.mjs");
  }, 60_000);
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("reopens 14 turns, two compactions and three failures after completion and three reconnects", async () => {
    const directory = join(work, "completed");
    const view = await runFixture(directory);
    expect(
      view.history
        .filter((row) => row.event.type === "ToolFailed")
        .map((row) =>
          row.event.type === "ToolFailed" ? row.event.failure.reason : "",
        ),
    ).toEqual(["Lookup 3 failed", "Lookup 7 failed", "Lookup 11 failed"]);
    expect(view.history[0]?.event).toMatchObject({
      type: "TurnSettled",
      turn: { content: "Settled reasoning 1" },
    });
    expect(view.history.at(-1)?.event).toMatchObject({
      type: "RunDone",
      status: { kind: "done" },
    });
    expect(await runFixture(directory)).toEqual(view);
  });

  it("keeps publication behind a pending source append and surfaces a failed save", async () => {
    const backing = fileJournal(join(work, "failed-save"), parseRecord);
    const reached = gate();
    const release = gate();
    const journal: CaseJournal = {
      ...backing,
      async append(stream, record) {
        if (record.msg.type === "resilient_run_ok") {
          reached.resolve();
          await release.promise;
          throw new Error("source append failed: disk full");
        }
        return backing.append(stream, record);
      },
    };
    const host = await openCase(journal, "save-failure", fixturePorts());
    const client = await host.connect();
    await client.next();
    const running = host.start();
    const rejected = expect(running).rejects.toThrow("disk full");
    await reached.promise;
    expect(committedView(host).revision).toBe(1);
    expect(await backing.list("save-failure")).toHaveLength(1);
    expect((await client.next()).value?.view.revision).toBe(1);
    expect(client.backlog().pending).toBe(0);
    const waiting = client.next();
    const unavailable = expect(waiting).rejects.toThrow("disk full");
    release.resolve();
    await rejected;
    await unavailable;
    expect(host.read()).toMatchObject({
      kind: "unavailable",
      lastCommitted: { view: { revision: 1, history: [] } },
    });
    await expect(host.connect()).rejects.toThrow("disk full");
    await host.stop();
    const reopened = await openCase(backing, "save-failure", fixturePorts());
    await reopened.resume();
    verifyCase(reopened);
    await reopened.stop();
  });

  it("observes an update during attachment once, under the snapshot's own lock", async () => {
    const backing = fileJournal(join(work, "attach"), parseRecord);
    const modelEntered = gate();
    const releaseModel = gate();
    const ports = fixturePorts();
    let attach = false;
    let duringAttach: () => Promise<void> = async () => {};
    const journal: CaseJournal = {
      ...backing,
      async withLock(stream, fx) {
        const intercept = attach;
        attach = false;
        const result = await backing.withLock(stream, fx);
        if (intercept) await duringAttach();
        return result;
      },
    };
    const host = await openCase(journal, "attach", {
      ...ports,
      model: async (turn) => {
        modelEntered.resolve();
        await releaseModel.promise;
        return ports.model(turn);
      },
    });
    let running: Promise<void> = Promise.resolve();
    duringAttach = async () => {
      running = host.start();
      await modelEntered.promise;
    };
    attach = true;
    const client = await host.connect();
    expect((await client.next()).value?.view.revision).toBe(0);
    expect((await client.next()).value?.view.revision).toBe(1);
    expect(client.backlog().pending).toBe(0);
    releaseModel.resolve();
    await running;
    client.close();
    await host.stop();
  });

  it("bounds lagging output, converges with full views, and cancels the SSE connection", async () => {
    const host = await openCase(
      fileJournal(join(work, "overflow"), parseRecord),
      "overflow",
      fixturePorts(),
    );
    const client = await host.connect();
    const response = caseResponse(client);
    await host.start();
    expect(client.backlog().pending).toBeLessThanOrEqual(MAX_PENDING_VIEWS);
    expect(client.backlog().dropped).toBeGreaterThan(0);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    let last: unknown;
    while (client.backlog().pending > 0) {
      const frame = await reader.read();
      const text = new TextDecoder().decode(frame.value);
      expect(text).toContain("event: case\n");
      last = JSON.parse(text.split("data: ")[1]?.trim() ?? "null");
    }
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(last).toMatchObject({
      view: { outcome: { kind: "done" }, compactions: 2 },
    });
    expect(last).toMatchObject({ view: verifyCase(host) });
    await reader.cancel();
    expect(host.connections()).toBe(0);
    const reconnected = await host.connect();
    expect((await reconnected.next()).value?.view).toEqual(committedView(host));
    reconnected.close();
    await host.stop();
  });

  it.each([
    [
      "shape",
      '{"seq":1,"record":{"version":1,"msg":{"type":"agent_start","runId":42,"at":1}}}\n',
    ],
    [
      "sequence",
      '{"seq":2,"record":{"version":1,"msg":{"type":"agent_start","runId":"corrupt","at":1}}}\n',
    ],
    [
      "owner",
      '{"seq":1,"record":{"version":1,"msg":{"type":"agent_start","runId":"foreign","at":1}}}\n',
    ],
  ])("refuses a corrupt persisted %s without overwriting it", async (name, bytes) => {
    const journal = fileJournal(join(work, `corrupt-${name}`), parseRecord);
    await journal.append("corrupt", {
      version: 1,
      msg: { type: "agent_start", runId: "corrupt", at: 1 },
    });
    const path = join(work, `corrupt-${name}`, "corrupt.jsonl");
    await writeFile(path, bytes);
    await expect(
      openCase(
        fileJournal(join(work, `corrupt-${name}`), parseRecord),
        "corrupt",
        fixturePorts(),
      ),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("repairs the view in a fresh process after SIGKILL between source commit and publication", async () => {
    const directory = join(work, "killed");
    const children: ChildProcess[] = [];
    const launch = (mode: string) => {
      const child = spawn(process.execPath, [entry, directory, mode], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      return child;
    };
    try {
      const first = launch("crash");
      const exited = once(first, "exit");
      const boundary = await messageFrom(first);
      expect(boundary).toEqual({ kind: "committed", seq: 2, published: 1 });
      expect(
        await fileJournal(directory, parseRecord).list("investigation-593"),
      ).toHaveLength(2);
      first.kill("SIGKILL");
      await exited;
      const second = launch("resume");
      const finished = once(second, "exit");
      const recovered = await messageFrom(second);
      expect(recovered).toMatchObject({
        kind: "recovered",
        view: { outcome: { kind: "done" }, compactions: 2 },
      });
      expect((await finished)[0]).toBe(0);
      const fresh = await openCase(
        fileJournal(directory, parseRecord),
        "investigation-593",
        fixturePorts(),
      );
      const view = verifyCase(fresh);
      expect(recovered).toMatchObject({ view });
      expect(
        view.history.filter(
          (row) =>
            row.event.type === "TurnSettled" &&
            row.event.turn.content === "Settled reasoning 1",
        ),
      ).toHaveLength(1);
      for (let cycle = 0; cycle < 3; cycle++) {
        const client = await fresh.connect();
        expect((await client.next()).value?.view).toEqual(view);
        client.close();
      }
      await fresh.stop();
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
    }
  });
});

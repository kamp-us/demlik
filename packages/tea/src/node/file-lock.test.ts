// ───────────────────────────────────────────────────────────────────────────
// A leftover file lock (#689). The first block is the user's job end to end: a
// folder restored from another machine never hangs. The ones after it pin each
// case the lock judges, with short limits so they do not wait out the real one.
// ───────────────────────────────────────────────────────────────────────────
import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineMachine, type Reducer, StoreConflictError } from "../index";
import { run } from "../promise";
import { FileLockTimeoutError, withFileLock } from "./file-lock";
import { fileJournal, fileStore } from "./index";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_PID = 2147483647;
const REAL_LIMIT_MS = 10_000;
const SHORT = { waitMs: 150, graceMs: 50 };

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tea-file-lock-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const bootedAtMs = (): number => Date.now() - uptime() * 1000;
const stamped = (host: string, booted: number, pid: number): string =>
  JSON.stringify({ host, bootedAtMs: booted, pid });
const fromAnotherHost = (): string =>
  stamped("the-old-box", bootedAtMs(), process.pid);

type Notes = { readonly notes: readonly string[] };
const parseNotes = (raw: unknown): Notes => raw as Notes;
const parseRecord = (raw: unknown): { readonly tag: string } =>
  raw as { readonly tag: string };

const update: Reducer<Notes, { type: "note" }, never> = {
  note: (state) => [{ notes: [...state.notes, "note"] }, []],
};
const noteMachine = defineMachine({
  types: {
    model: {} as Notes,
    msg: {} as { type: "note" },
    ctx: undefined,
  },
  init: (loaded) => [loaded ?? { notes: [] }, []],
  update,
});

/** Takes the lock with a no-op; resolves once it was taken and released. */
const take = (lockPath: string, dir: string): Promise<string> =>
  withFileLock(dir, lockPath, async () => "held", SHORT);

describe("a folder restored from another machine", { timeout: 30_000 }, () => {
  it.concurrent("every first write ends in a typed error naming its lock, and clears after the host deletes it", async () => {
    const dir = freshDir();
    const stores = ["a", "b", "c"].map((name) => {
      const path = join(dir, `${name}.json`);
      const lockPath = `${path}.fence.lock`;
      writeFileSync(lockPath, fromAnotherHost());
      return {
        lockPath,
        store: fileStore(path, parseNotes, { fenced: true }),
      };
    });
    const journalLock = join(dir, "s.jsonl.lock");
    writeFileSync(journalLock, fromAnotherHost());
    const journal = fileJournal(dir, parseRecord);
    const leftovers = [...stores.map((s) => s.lockPath), journalLock];
    const before = leftovers.map((p) => readFileSync(p, "utf8"));

    const startedAt = performance.now();
    const writes = await Promise.allSettled([
      ...stores.map((s) => s.store.saveFenced({ notes: [] }, 0)),
      journal.append("s", { tag: "a" }),
    ]);
    const elapsedMs = performance.now() - startedAt;

    const errors = writes.map((write) => {
      if (write.status !== "rejected") throw new Error("the write landed");
      return write.reason as FileLockTimeoutError;
    });
    for (const [i, error] of errors.entries()) {
      expect(error).toBeInstanceOf(FileLockTimeoutError);
      expect(error.lockPath).toBe(leftovers[i]);
      expect(error.message).toContain(leftovers[i]);
      expect(error.blockedBy).toBe("another-host");
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(REAL_LIMIT_MS);
    expect(elapsedMs).toBeLessThan(REAL_LIMIT_MS + 5_000);
    // Not stolen: every leftover is still there, byte for byte.
    expect(leftovers.map((p) => readFileSync(p, "utf8"))).toEqual(before);

    // The clear step the error asks for is all it takes.
    for (const lockPath of leftovers) rmSync(lockPath);
    await expect(
      stores[0]?.store.saveFenced({ notes: ["back"] }, 0),
    ).resolves.toBe(1);
    expect(await journal.append("s", { tag: "a" })).toEqual({ seq: 1 });
  });

  it.concurrent("a run's final save over a held lock reaches onError with the typed error", async () => {
    const dir = freshDir();
    const path = join(dir, "run.json");
    const seen: { error: unknown; phase: string }[] = [];
    const runtime = await run(noteMachine, {
      ctx: undefined,
      store: fileStore(path, parseNotes, { fenced: true }),
      // Past the lock's limit, so the save ends before stop() gives up on it.
      disposeTimeoutMs: 60_000,
      onError: (error, context) => {
        seen.push({ error, phase: context.phase });
      },
    }).ready;
    await runtime.dispatch({ type: "note" });

    // A live process on this machine and boot holds it past the limit.
    writeFileSync(
      `${path}.fence.lock`,
      stamped(hostname(), bootedAtMs(), process.pid),
    );
    await runtime.stop();

    expect(seen.map((s) => s.phase)).toEqual(["stop-save"]);
    const error = seen[0]?.error as FileLockTimeoutError;
    expect(error).toBeInstanceOf(FileLockTimeoutError);
    expect(error.blockedBy).toBe("live-holder");
    expect(error.lockPath).toBe(`${path}.fence.lock`);
  });

  it.concurrent("a dispatch whose save meets a held lock rejects with the typed error", async () => {
    const dir = freshDir();
    const path = join(dir, "run.json");
    const runtime = await run(noteMachine, {
      ctx: undefined,
      store: fileStore(path, parseNotes, { fenced: true }),
      onError: () => {},
    }).ready;
    writeFileSync(`${path}.fence.lock`, fromAnotherHost());
    await expect(runtime.dispatch({ type: "note" })).rejects.toBeInstanceOf(
      FileLockTimeoutError,
    );
    rmSync(`${path}.fence.lock`);
    await runtime.stop();
  });
});

describe("what the lock steals", () => {
  const leftOver = (body: string, ageMs = 0): [string, string] => {
    const dir = freshDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, body);
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      utimesSync(lockPath, then, then);
    }
    return [lockPath, dir];
  };

  const refused = async (lockPath: string, dir: string) => {
    const before = readFileSync(lockPath, "utf8");
    const error = (await take(lockPath, dir).catch(
      (e: unknown) => e,
    )) as FileLockTimeoutError;
    expect(error).toBeInstanceOf(FileLockTimeoutError);
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    return error.blockedBy;
  };

  it("an empty lock older than the grace period, through a store", async () => {
    const dir = freshDir();
    const path = join(dir, "state.json");
    const lockPath = `${path}.fence.lock`;
    writeFileSync(lockPath, "");
    const then = new Date(Date.now() - DAY_MS);
    utimesSync(lockPath, then, then);
    const store = fileStore(path, parseNotes, { fenced: true });
    await expect(store.saveFenced({ notes: ["landed"] }, 0)).resolves.toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      notes: ["landed"],
    });
  });

  it("not an empty lock younger than the grace period", async () => {
    const [lockPath, dir] = leftOver("");
    const error = await withFileLock(dir, lockPath, async () => "held", {
      waitMs: 100,
      graceMs: 60_000,
    }).catch((e: unknown) => e);
    expect((error as FileLockTimeoutError).blockedBy).toBe("unwritten");
    expect(readFileSync(lockPath, "utf8")).toBe("");
  });

  it("an empty lock once it ages past the grace period while waited on", async () => {
    const [lockPath, dir] = leftOver("");
    await expect(take(lockPath, dir)).resolves.toBe("held");
  });

  it.each([
    ["this process's id", process.pid],
    ["another live process's id", process.ppid],
    ["a dead id", DEAD_PID],
  ])("a lock from an earlier boot of this machine holding %s", async (_name, pid) => {
    const [lockPath, dir] = leftOver(
      stamped(hostname(), bootedAtMs() - DAY_MS, pid),
    );
    await expect(take(lockPath, dir)).resolves.toBe("held");
  });

  it.each([
    ["a live id", process.pid],
    ["a dead id", DEAD_PID],
  ])("not a lock from another host holding %s", async (_name, pid) => {
    const [lockPath, dir] = leftOver(stamped("the-old-box", bootedAtMs(), pid));
    expect(await refused(lockPath, dir)).toBe("another-host");
  });

  it("a dead holder on this machine and boot", async () => {
    const [lockPath, dir] = leftOver(
      stamped(hostname(), bootedAtMs(), DEAD_PID),
    );
    await expect(take(lockPath, dir)).resolves.toBe("held");
  });

  it("not a live holder on this machine and boot", async () => {
    const [lockPath, dir] = leftOver(
      stamped(hostname(), bootedAtMs(), process.ppid),
    );
    expect(await refused(lockPath, dir)).toBe("live-holder");
  });

  it("an old-format lock with a dead id", async () => {
    const [lockPath, dir] = leftOver(String(DEAD_PID));
    await expect(take(lockPath, dir)).resolves.toBe("held");
  });

  it("not an old-format lock with a live id", async () => {
    const [lockPath, dir] = leftOver(String(process.pid));
    expect(await refused(lockPath, dir)).toBe("live-holder");
  });

  it.each([
    "not a lock",
    "0",
    "{}",
    '{"host":"h","bootedAtMs":1,"pid":-1}',
  ])("not a lock it cannot read: %s", async (body) => {
    const [lockPath, dir] = leftOver(body, DAY_MS);
    expect(await refused(lockPath, dir)).toBe("unreadable");
  });

  it("clears a steal guard a crash left behind", async () => {
    const [lockPath, dir] = leftOver(String(DEAD_PID));
    writeFileSync(`${lockPath}.steal`, "");
    await expect(take(lockPath, dir)).resolves.toBe("held");
  });
});

describe("writers taking turns", () => {
  it("two stores in one process on one path: one saves, one is refused", async () => {
    const path = join(freshDir(), "state.json");
    const one = fileStore(path, parseNotes, { fenced: true });
    const two = fileStore(path, parseNotes, { fenced: true });
    const saves = await Promise.allSettled([
      one.saveFenced({ notes: ["one"] }, 0),
      two.saveFenced({ notes: ["two"] }, 0),
    ]);
    const rejected = saves.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    expect(saves.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StoreConflictError);
  });

  describe("processes racing a dead holder", { timeout: 60_000 }, () => {
    let work: string;
    let entry: string;
    beforeAll(async () => {
      work = freshDir();
      await build({
        configFile: false,
        logLevel: "error",
        ssr: { noExternal: true },
        build: {
          ssr: fileURLToPath(
            new URL("./fixtures/lock-racer-child.ts", import.meta.url),
          ),
          outDir: join(work, "bundle"),
          rollupOptions: { output: { entryFileNames: "child.mjs" } },
        },
      });
      entry = join(work, "bundle/child.mjs");
    });

    const racer = (lockPath: string, holderPath: string) => {
      const child: ChildProcess = spawn(
        process.execPath,
        [entry, lockPath, holderPath],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return {
        child,
        up: new Promise<void>((resolve) => {
          child.once("message", () => resolve());
        }),
        exited: new Promise<{ code: number | null; stderr: string }>(
          (resolve) => {
            child.once("exit", (code) => resolve({ code, stderr }));
          },
        ),
      };
    };

    it("six processes over five rounds: never two holders at once", async () => {
      for (let round = 0; round < 5; round++) {
        const dir = join(work, `round-${round}`);
        const lockPath = join(dir, "x.lock");
        const holderPath = join(dir, "holder");
        mkdirSync(dir, { recursive: true });
        writeFileSync(lockPath, String(DEAD_PID));
        const racers = Array.from({ length: 6 }, () =>
          racer(lockPath, holderPath),
        );
        await Promise.all(racers.map((r) => r.up));
        for (const r of racers) r.child.send("go");
        const results = await Promise.all(racers.map((r) => r.exited));
        expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
      }
    });
  });
});

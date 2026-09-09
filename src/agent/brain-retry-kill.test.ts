/**
 * #146 — the durability half of the lid's brain-call retry ladder, proved the
 * only way it can be: a real child process, SIGKILLed while an attempt is OWED,
 * restarted over the same `fileStore`, and asked to account for every model
 * call.
 *
 * The claim under test is the one that makes this a lid option rather than a
 * `for` loop around the caller's `model`: the ladder is DATA on the Model, so
 * the attempt count survives the kill. A ladder that lived inside the effect
 * boundary would come back at attempt 0, and this fixture — whose model always
 * throws, under a 3-attempt budget — would call the model more than three times
 * across the two processes and settle on a budget that had been silently
 * refilled.
 *
 * The harness is `./tool-retry-kill.test.ts`'s, which is the tutorial's
 * kill-and-resume harness.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/brain-retry-kill.ts", import.meta.url),
);

/** The budget the fixture's lid declares — the number this test is about. */
const MAX_ATTEMPTS = 3;

interface Run {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly exited: Promise<number | null>;
}

function launch(entry: string, cwd: string): Run {
  let out = "";
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      TEA_ATTEMPTS_LOG: join(cwd, "attempts.log"),
      TEA_STATE: join(cwd, "agent.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    out += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return { child, stdout: () => out, exited };
}

async function until<T>(
  probe: () => Promise<T | null>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const got = await probe();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The brain call's one phase as the persisted Model has it, or `null`. */
async function parkedPhase(cwd: string): Promise<{
  readonly phase: string;
  readonly attempt: number;
} | null> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "agent.json"), "utf8");
  } catch {
    return null;
  }
  let model: {
    resilience?: {
      calls: Record<string, { phase: string }>;
      retry: Record<string, { attempt: number }>;
    };
  };
  try {
    model = JSON.parse(raw);
  } catch {
    // The store renames atomically, so a torn read is not possible — but a read
    // that lands before the first save is, and it is a "not yet", not a failure.
    return null;
  }
  const slice = model.resilience;
  if (slice === undefined) return null;
  const [key] = Object.keys(slice.calls);
  if (key === undefined) return null;
  const phase = slice.calls[key]?.phase ?? "";
  if (phase !== "waiting_retry") return null;
  return { phase, attempt: slice.retry[key]?.attempt ?? 0 };
}

/** How many times the model actually ran, across every process. */
async function attempts(cwd: string): Promise<number> {
  const log = await readFile(join(cwd, "attempts.log"), "utf8").catch(() => "");
  return log.trimEnd() === "" ? 0 : log.trimEnd().split("\n").length;
}

describe("a lid brain-call retry ladder survives SIGKILL between two attempts", () => {
  let work: string;
  let cache: string;
  let entry: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "tea-brain-retry-"));
    cache = join(
      repo,
      "node_modules/.cache/tea-brain-retry",
      work.split("-").at(-1) ?? "x",
    );
    await mkdir(cache, { recursive: true });
    await build({
      configFile: join(repo, "vitest.config.ts"),
      root: repo,
      logLevel: "error",
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
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("resumes at the attempt it was on and calls the model no more than the budget", async () => {
    const cwd = join(work, "run");
    await mkdir(cwd, { recursive: true });

    // Run 1: park it the moment the Model says an attempt is OWED — the phase
    // is the handshake, not a sleep, so the kill lands in the window by
    // construction rather than by timing luck.
    const first = launch(entry, cwd);
    const parked = await until(() => parkedPhase(cwd), "the armed retry");
    first.child.kill("SIGKILL");
    await first.exited;

    // One attempt spent, one owed. This is the number that has to survive.
    expect(parked.attempt).toBe(1);
    expect(await attempts(cwd)).toBe(1);

    // Run 2: the same program over the same directory, nothing else changed.
    const second = launch(entry, cwd);
    expect(await second.exited).toBe(0);

    // The whole claim, in two facts: the model ran the budget's worth of times
    // ACROSS the two processes — not the budget's worth in each — and the run
    // settled on the agent's own exhausted-brain-call annotation rather than
    // starting a fresh ladder.
    expect(await attempts(cwd)).toBe(MAX_ATTEMPTS);
    expect(second.stdout()).toContain("failure: llm");
    expect(second.stdout()).toContain("done");
  }, 60_000);
});

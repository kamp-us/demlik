/**
 * #117 — the durability half of the per-tool retry ladder, proved the only way
 * it can be: a real child process, SIGKILLed while an attempt is OWED, restarted
 * over the same `fileStore`, and asked to account for every handler call.
 *
 * The claim under test is the one that makes this knob worth building rather
 * than telling a user to write a `for` loop in the handler: the ladder is DATA
 * on the Model, so the attempt count survives the kill. A ladder that lived
 * inside the effect boundary would come back at attempt 0, and this fixture —
 * whose tool always fails, under a 3-attempt budget — would call the handler
 * more than three times across the two processes and settle on a budget that
 * had been silently refilled.
 *
 * The harness (bundle the fixture with vite, spawn it against a temp cwd) is the
 * one the tutorial's kill-and-resume test established; see
 * `../docs/tutorial/build-a-durable-agent.test.ts`.
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
  new URL("./fixtures/tool-retry-kill.ts", import.meta.url),
);

/** The budget the fixture's tool declares — the number this test is about. */
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

/** The `flaky` ladder's one call phase as the persisted Model has it, or `null`. */
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
    toolResilience?: Record<
      string,
      {
        calls: Record<string, { phase: string }>;
        retry: Record<string, { attempt: number }>;
      }
    >;
  };
  try {
    model = JSON.parse(raw);
  } catch {
    // The store renames atomically, so a torn read is not possible — but a read
    // that lands before the first save is, and it is a "not yet", not a failure.
    return null;
  }
  const slice = model.toolResilience?.flaky;
  if (slice === undefined) return null;
  const [key] = Object.keys(slice.calls);
  if (key === undefined) return null;
  const phase = slice.calls[key]?.phase ?? "";
  if (phase !== "waiting_retry") return null;
  return { phase, attempt: slice.retry[key]?.attempt ?? 0 };
}

/** How many times the tool's handler actually ran, across every process. */
async function attempts(cwd: string): Promise<number> {
  const log = await readFile(join(cwd, "attempts.log"), "utf8").catch(() => "");
  return log.trimEnd() === "" ? 0 : log.trimEnd().split("\n").length;
}

describe("a per-tool retry ladder survives SIGKILL between two attempts", () => {
  let work: string;
  let cache: string;
  let entry: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "tea-tool-retry-"));
    // Bundled inside the repo so the fixture's bare `zod` import resolves from
    // the repo's node_modules for both the bundler and the child.
    cache = join(
      repo,
      "node_modules/.cache/tea-tool-retry",
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

  it("resumes at the attempt it was on and calls the handler no more than the budget", async () => {
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

    // The whole claim, in two numbers: the handler ran the budget's worth of
    // times ACROSS the two processes — not the budget's worth in each — and the
    // outcome the model was shown says the original budget is what ran out.
    expect(await attempts(cwd)).toBe(MAX_ATTEMPTS);
    expect(second.stdout()).toContain(
      `outcome: retry_exhausted ${JSON.stringify({
        attempts: MAX_ATTEMPTS,
        last: "upstream",
      })}`,
    );
    expect(second.stdout()).toContain("done");
  }, 60_000);
});

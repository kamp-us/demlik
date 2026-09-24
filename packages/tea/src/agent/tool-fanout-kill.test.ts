/**
 * #179 — the durability half of tool fan-out, proved the only way it can be: a
 * real child process at `toolConcurrency: 2`, SIGKILLed with one of a turn's two
 * overlapping calls already SETTLED and its sibling still RUNNING, restarted
 * over the same `fileStore`, and asked to account for every handler call.
 *
 * The claim under test is that overlapping inside the Cmd handler did not widen
 * the at-least-once window. That window is documented and unchanged: `boot`
 * re-fires the effect of every call the Model still has `running`, and nothing
 * else — so a call whose settle was folded and saved before the kill is NOT
 * re-run, however many of its siblings were in flight beside it. A fan-out that
 * settled outside the Model (or that lost a settle to completion-order racing)
 * would show up here as the quick tool running twice.
 *
 * The harness (bundle the fixture with vite, spawn it against a temp cwd) is the
 * one `./tool-retry-kill.test.ts` established.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/tool-fanout-kill.ts", import.meta.url),
);

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
      TEA_CALLS_LOG: join(cwd, "calls.log"),
      TEA_STATE: join(cwd, "agent.json"),
      TEA_RELEASE: join(cwd, "release"),
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

/**
 * The mid-fan-out window as the persisted Model has it — `q` settled into the
 * conversation while `s` is still in the fan-out's `running` list — or `null`
 * for "not yet". A handshake, not a sleep: the kill lands in the window by
 * construction rather than by timing luck.
 */
async function midFanOut(cwd: string): Promise<readonly string[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "agent.json"), "utf8");
  } catch {
    return null;
  }
  let model: {
    tools?: { running?: readonly { callId?: string }[] };
    conversation?: {
      toolRecords?: readonly { call?: { callId?: string } }[];
    } | null;
  };
  try {
    model = JSON.parse(raw);
  } catch {
    // The store renames atomically, so a torn read is not possible — but a read
    // that lands before the first save is, and it is a "not yet", not a failure.
    return null;
  }
  const running = (model.tools?.running ?? []).flatMap((c) =>
    c.callId === undefined ? [] : [c.callId],
  );
  const settled = (model.conversation?.toolRecords ?? []).flatMap((r) =>
    r.call?.callId === undefined ? [] : [r.call.callId],
  );
  if (settled.includes("q") && running.includes("s")) return settled;
  return null;
}

/** Every handler invocation, across every process, in the order they happened. */
async function calls(cwd: string): Promise<string[]> {
  const log = await readFile(join(cwd, "calls.log"), "utf8").catch(() => "");
  return log.trimEnd() === "" ? [] : log.trimEnd().split("\n");
}

describe("a fanned turn survives SIGKILL without re-running a settled call", () => {
  let work: string;
  let cache: string;
  let entry: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "tea-tool-fanout-"));
    // Bundled inside the repo so the fixture's bare `zod` import resolves from
    // the repo's node_modules for both the bundler and the child.
    cache = join(
      repo,
      "node_modules/.cache/tea-tool-fanout",
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

  it("re-runs only the call that was still in flight", async () => {
    const cwd = join(work, "run");
    await mkdir(cwd, { recursive: true });

    // Run 1: park it the moment the Model says one call is folded and the other
    // is still running — which is only reachable at all because the two
    // overlapped. Serially, `q` could not have settled while `s` was running.
    const first = launch(entry, cwd);
    const settled = await until(() => midFanOut(cwd), "the mid-fan-out window");
    first.child.kill("SIGKILL");
    await first.exited;

    expect(settled).toEqual(["q"]);
    expect(await calls(cwd)).toEqual(["quick", "slow"]);

    // Run 2: the same program over the same directory, with `slow` released so
    // it can finish this time. Nothing else changed.
    await writeFile(join(cwd, "release"), "go");
    const second = launch(entry, cwd);
    expect(await second.exited).toBe(0);

    // The whole claim, in one list: `quick` ran ONCE across the two processes —
    // its settle was durable, so the resume did not buy it again — and `slow`
    // ran twice, which is the documented at-least-once window for the one call
    // that was still in flight.
    expect(await calls(cwd)).toEqual(["quick", "slow", "slow"]);
    // And the model was shown both outcomes, in Cmd-emission order.
    expect(second.stdout()).toContain("outcomes: q:ok,s:ok");
    expect(second.stdout()).toContain("done");
  }, 60_000);
});

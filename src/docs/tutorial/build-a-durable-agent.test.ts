/**
 * The tutorial runs in CI (#60). `docs/tutorial/build-a-durable-agent.md` is
 * read, its TypeScript blocks are reassembled into the two files they name,
 * bundled against `src/` and run as a real child process against the recorded
 * model fixture — killed after the first tool call, then run again. What the
 * page promises the reader is what is asserted: the second process resumes the
 * first run (same `runId`), writes the remaining notes and never repeats the
 * first one, and the program the reader types is short.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const page = join(repo, "docs/tutorial/build-a-durable-agent.md");
const fixture = fileURLToPath(
  new URL("./fixtures/anthropic-notebook.json", import.meta.url),
);
const preload = new URL("./fixtures/anthropic-fixture.mjs", import.meta.url);

/** The user-code ceiling the issue names for the file the lesson is about. */
const MAX_AGENT_LINES = 35;

/**
 * Every ```ts block on the page, keyed by the `// <file>` marker on its first
 * line; a file spread over several blocks is their concatenation in page order.
 */
function programOf(markdown: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const m of markdown.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const block = m[1] ?? "";
    const marker = /^\/\/ (\S+\.ts)\n/.exec(block);
    const name = marker?.[1] ?? [...files.keys()].at(-1);
    if (name === undefined)
      throw new Error("a ts block precedes any file marker");
    const body = marker ? block.slice(marker[0].length) : block;
    files.set(name, `${files.get(name) ?? ""}${body}`);
  }
  return files;
}

/** Bundle `agent.ts` against `src/`; deps stay external and resolve from the repo. */
async function bundle(srcDir: string, outDir: string): Promise<string> {
  await build({
    configFile: join(repo, "vitest.config.ts"),
    root: repo,
    logLevel: "error",
    build: {
      ssr: join(srcDir, "agent.ts"),
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: "agent.mjs", format: "es" } },
    },
  });
  return join(outDir, "agent.mjs");
}

interface Run {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly exited: Promise<number | null>;
}

function launch(entry: string, cwd: string, env: Record<string, string>): Run {
  let out = "";
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ...env,
      ANTHROPIC_API_KEY: "fixture-key",
      TEA_TUTORIAL_FIXTURE: fixture,
      NODE_OPTIONS: `--import=${preload.href}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return { child, stdout: () => out, exited };
}

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function runId(cwd: string): Promise<string> {
  const model = JSON.parse(await readFile(join(cwd, "agent.json"), "utf8")) as {
    run: { runId?: string };
  };
  return model.run.runId ?? "";
}

describe("docs/tutorial/build-a-durable-agent.md runs, dies mid-run, and resumes", () => {
  let work: string;
  let cache: string;
  let entry: string;
  let program: Map<string, string>;

  beforeAll(async () => {
    program = programOf(await readFile(page, "utf8"));
    work = await mkdtemp(join(tmpdir(), "tea-tutorial-"));
    // The program is written and bundled INSIDE the repo so its bare imports
    // (`@anthropic-ai/sdk`, `zod`, `better-result`) resolve from the repo's
    // `node_modules`, both for the bundler and for the child that runs the
    // bundle; the run itself gets the empty temp directory as its cwd.
    cache = join(
      repo,
      "node_modules/.cache/tea-tutorial",
      work.split("-").at(-1) ?? "x",
    );
    const srcDir = join(cache, "src");
    await mkdir(srcDir, { recursive: true });
    for (const [name, body] of program)
      await writeFile(join(srcDir, name), body);
    entry = await bundle(srcDir, join(cache, "out"));
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("the lesson's own file stays under the user-code ceiling", () => {
    const agent = program.get("agent.ts") ?? "";
    expect(program.has("model.ts")).toBe(true);
    expect(agent.trimEnd().split("\n").length).toBeLessThanOrEqual(
      MAX_AGENT_LINES,
    );
  });

  it("killed after the first tool call, the next run resumes the same run and skips that tool", async () => {
    const cwd = join(work, "run");
    await mkdir(cwd);

    // Run 1: the fixture holds the model call that follows the first tool
    // call, so the process is parked with the tool's outcome already saved.
    const first = launch(entry, cwd, { TEA_TUTORIAL_HOLD_TURN: "1" });
    await until(
      () => first.stdout().includes("fixture: holding turn 1"),
      "the hold",
    );
    first.child.kill("SIGKILL");
    await first.exited;
    expect(first.stdout()).toContain("note: red");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("red\n");
    const parkedRunId = await runId(cwd);
    expect(parkedRunId).not.toBe("");

    // Run 2: the same program over the same directory, nothing else changed.
    const second = launch(entry, cwd, {});
    expect(await second.exited).toBe(0);
    const out = second.stdout();
    expect(out).not.toContain("note: red");
    expect(out).toContain("note: yellow");
    expect(out).toContain("note: blue");
    expect(out).toContain(
      "done: Done — red, yellow and blue are in the notebook.",
    );
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe(
      "red\nyellow\nblue\n",
    );
    expect(await runId(cwd)).toBe(parkedRunId);
  }, 60_000);
});

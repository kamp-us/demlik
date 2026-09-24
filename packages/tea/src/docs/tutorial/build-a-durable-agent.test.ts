/**
 * The tutorial runs in CI (#60). `docs/tutorial/build-a-durable-agent.md` is
 * read, its TypeScript blocks are reassembled into the two files they name,
 * bundled against `src/` and run as a real child process against the recorded
 * model fixture — killed after the first tool call, then run again. What the
 * page promises the reader is what is asserted: the second process resumes the
 * first run (same `runId`), writes the remaining notes and never repeats the
 * first one, every request replays the previous turn's signed thinking block
 * (#102), and the program the reader types is short.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The sole consumer of the `vite` devDependency: it bundles the reassembled
// tutorial program below. Prune `vite` only when this import goes with it.
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage, ContentPart } from "../../agent";

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

/** Bundle one page file against `src/`; deps stay external and resolve from the repo. */
async function bundle(
  srcDir: string,
  outDir: string,
  file = "agent",
): Promise<string> {
  await build({
    configFile: join(repo, "vitest.config.ts"),
    root: repo,
    logLevel: "error",
    build: {
      ssr: join(srcDir, `${file}.ts`),
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        output: { entryFileNames: `${file}.mjs`, format: "es" },
      },
    },
  });
  return join(outDir, `${file}.mjs`);
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
      TEA_TUTORIAL_REQUEST_LOG: join(cwd, "requests.jsonl"),
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

interface Block {
  readonly type: string;
}

interface Request {
  readonly turn: number;
  readonly body: {
    readonly messages: readonly { role: string; content: Block[] | string }[];
  };
}

/** Every Messages request the preload saw, in the order both processes sent them. */
async function requests(cwd: string): Promise<Request[]> {
  const log = await readFile(join(cwd, "requests.jsonl"), "utf8");
  return log
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Request);
}

/** The recorded `thinking` block the fixture's reply for `turn` opens with. */
async function recordedThinking(turn: number): Promise<Block> {
  const recorded = JSON.parse(await readFile(fixture, "utf8")) as {
    turns: { content: Block[] }[];
  };
  const block = recorded.turns[turn]?.content.find(
    (b) => b.type === "thinking",
  );
  if (block === undefined)
    throw new Error(`fixture turn ${turn} has no thinking`);
  return block;
}

describe("docs/tutorial/build-a-durable-agent.md runs, dies mid-run, and resumes", () => {
  let work: string;
  let cache: string;
  let entry: string;
  let modelEntry: string;
  let program: Map<string, string>;

  beforeAll(async () => {
    program = programOf(await readFile(page, "utf8"));
    work = await mkdtemp(join(tmpdir(), "tea-tutorial-"));
    // The program is written and bundled INSIDE the repo so its bare imports
    // (`@anthropic-ai/sdk`, `zod`) resolve from the repo's
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
    modelEntry = await bundle(srcDir, join(cache, "model-out"), "model");
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  // #330 — the page's `toParam` maps content parts to Anthropic blocks: a
  // user message's parts and a tool's `parts` go as `image` / `document`
  // blocks with a base64 or url source, and a string is one text block.
  it("toParam maps content parts to Anthropic image and document blocks", async () => {
    const { toParam } = (await import(pathToFileURL(modelEntry).href)) as {
      toParam: (m: AgentMessage) => unknown[];
    };
    const jpeg: ContentPart = {
      type: "image",
      mediaType: "image/jpeg",
      source: { type: "base64", data: "/9j/4AAQ" },
    };
    const png: ContentPart = {
      type: "image",
      mediaType: "image/png",
      source: { type: "url", url: "https://example.com/a.png" },
    };
    const pdf: ContentPart = {
      type: "file",
      mediaType: "application/pdf",
      source: { type: "bytes", data: new Uint8Array([37, 80, 68, 70]) },
    };

    expect(toParam({ role: "user", content: "hi" })).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(
      toParam({
        role: "user",
        content: [{ type: "text", text: "look" }, png, pdf],
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/a.png" },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERg==",
            },
          },
        ],
      },
    ]);
    const outcome = { kind: "ok" as const, result: { jpeg: "/9j/4AAQ" } };
    expect(
      toParam({
        role: "tool",
        callId: "s1",
        name: "screenshot",
        outcome,
        parts: [jpeg],
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "s1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "/9j/4AAQ",
                },
              },
            ],
            is_error: false,
          },
        ],
      },
    ]);
    // No parts → the outcome is the payload, as before.
    expect(
      toParam({ role: "tool", callId: "n1", name: "note", outcome }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "n1",
            content: JSON.stringify(outcome),
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("the lesson's own file stays under the user-code ceiling", () => {
    const agent = program.get("agent.ts") ?? "";
    expect(program.has("model.ts")).toBe(true);
    expect(agent.trimEnd().split("\n").length).toBeLessThanOrEqual(
      MAX_AGENT_LINES,
    );
  });

  // #94 — the handler settles through the `{ ok, fail }` tea hands it, so the
  // reader installs nothing past the three packages the page names.
  it("the reader's code and install line name no result library of tea's", async () => {
    for (const [, body] of program) expect(body).not.toContain("better-result");
    expect(await readFile(page, "utf8")).not.toContain("better-result");
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

    // #332 — the adapter mapped the recorded `usage`, and the parked Model
    // already carries the first turn's cost as the run's running total.
    const parked = JSON.parse(await readFile(join(cwd, "agent.json"), "utf8"));
    const firstCost = {
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 0,
    };
    expect(parked.conversation.turns[0].usage).toEqual(firstCost);
    expect(parked.conversation.usage).toEqual(firstCost);
    expect(parked.conversation.contextTokens).toBe(150);

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

    // #102 — thinking is on, so every request for turn n ≥ 1 must replay turn
    // n−1's signed `thinking` block verbatim in the last assistant message;
    // the turn-1 request appears twice, once from each process, and the
    // resumed one replays a block it only ever read back from `agent.json`.
    const sent = await requests(cwd);
    expect(sent.map((r) => r.turn)).toEqual([0, 1, 1, 2, 3]);
    for (const { turn, body } of sent.filter((r) => r.turn >= 1)) {
      const assistant = body.messages.filter((m) => m.role === "assistant");
      const last = assistant[turn - 1]?.content;
      expect(Array.isArray(last) ? last[0] : undefined).toEqual(
        await recordedThinking(turn - 1),
      );
    }
  }, 60_000);
});

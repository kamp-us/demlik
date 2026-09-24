/**
 * The delegate-to-a-sub-agent recipe's compile-and-run gate (#333).
 *
 * `docs/how-to/delegate-to-a-sub-agent.md` hands the reader a tester agent that
 * delegates a barrier to an unblocker agent through `agentTool`, on the Promise
 * engine and inside a Durable Object. Its claim is that the child run lives
 * under its own key beside the parent's, so that a resumed parent resumes its
 * child. A page nothing runs cannot keep that claim.
 *
 * So the recipe lives HERE, as real TypeScript in the test program, and the
 * tests below assert the page's `ts` blocks are this file's `#region` bodies
 * verbatim. The page cannot drift from a compiling artifact, because the page
 * IS the artifact. The Promise wiring is then run over real files, and the
 * Durable Object recipe over an in-memory `DurableObjectStorage`.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin an import block the page reproduces verbatim; sorting the harness's
// imports into it would move a marker and break the assertions this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the recipe is the artifact
// under test, and it is exported because the reader pastes it as a module.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #region child
import type { Store } from "@demlik/tea";
import {
  type AgentMessage,
  type AgentTurn,
  agentTool,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "@demlik/tea/agent";
import { z } from "zod";

/** A brain in tea's plain port shape: your provider adapter goes here. */
export type Brain = (messages: readonly AgentMessage[]) => Promise<AgentTurn>;

/** The unblocker's own tool. The tester never sees it. */
export const dismiss = tool(
  "dismiss",
  {
    description: "Dismiss the overlay the selector names.",
    input: z.object({ selector: z.string() }),
    ok: z.object({ dismissed: z.boolean() }),
    err: [],
  },
  async ({ selector }, _ctx, { ok }) => ok({ dismissed: selector !== "" }),
);

/** The child: its own instructions, its own tools, its own bounds. */
export const unblocker = (model: Brain) =>
  defineAgent({
    model,
    tools: [dismiss],
    instructions:
      "Clear the one barrier you are given, then answer only with JSON: " +
      '{ "outcome": "cleared" | "not_cleared" | "unclearable", "summary": string }.',
    maxTurns: 12,
  });
// #endregion child

// #region tool
/** What the tester gets back, parsed at the edge like any tool's `ok`. */
export const Verdict = z.object({
  outcome: z.enum(["cleared", "not_cleared", "unclearable"]),
  summary: z.string(),
});

/** The child run's Model, which is what its Store holds. */
export type UnblockState = DefinedAgentState<typeof dismiss>;

/** What the tester's host hands `run`: the journey, and where child runs live. */
export type TesterCtx = {
  readonly journeyId: string;
  readonly childStore: (key: string) => Store<UnblockState>;
};

export const requestUnblock = (model: Brain) =>
  agentTool("request_unblock", {
    description:
      "Hand a barrier you cannot operate to the unblocker and wait for its verdict.",
    input: z.object({ description: z.string() }),
    ok: Verdict,
    agent: unblocker(model),
    prompt: ({ description }) => `Barrier: ${description}`,
    result: (output) => Verdict.parse(JSON.parse(output.content)),
    namespace: (ctx: TesterCtx) => ctx.journeyId,
    store: (key, ctx) => ctx.childStore(key),
  });

/** The parent: `request_unblock` sits in its tools like any other tool. */
export const tester = (brains: { tester: Brain; unblocker: Brain }) =>
  defineAgent({
    model: brains.tester,
    tools: [requestUnblock(brains.unblocker)],
    instructions:
      "Walk the journey with the screen reader. At a barrier you cannot " +
      "operate, call request_unblock with a description of it.",
  });

/** The tester's Model. */
export type TesterState = DefinedAgentState<ReturnType<typeof requestUnblock>>;
// #endregion tool

// #region promise
import { join } from "node:path";
import { fileStore } from "@demlik/tea/node";

/** One JSON file per run, the parent's and every child's, in one directory. */
export async function testJourney(
  dir: string,
  journeyId: string,
  brains: { tester: Brain; unblocker: Brain },
) {
  const file = (key: string) => join(dir, `${encodeURIComponent(key)}.json`);
  return tester(brains).run(`Test journey ${journeyId}.`, {
    runId: journeyId,
    store: fileStore(file(journeyId), (raw) => raw as TesterState),
    ctx: {
      journeyId,
      childStore: (key) =>
        fileStore(file(`unblock:${key}`), (raw) => raw as UnblockState),
    },
  });
}
// #endregion promise

// #region durable-object
import { doStore } from "@demlik/tea/do";

/**
 * The same tester inside a Durable Object: the parent's Model under the
 * default key, and each child's under `unblock:<journey>/<callId>`, all in the
 * DO's own storage. Call this from the DO's `fetch`.
 */
export function testJourneyInDo(
  storage: DurableObjectStorage,
  journeyId: string,
  brains: { tester: Brain; unblocker: Brain },
) {
  return tester(brains).run(`Test journey ${journeyId}.`, {
    runId: journeyId,
    store: doStore(storage, (raw) => raw as TesterState),
    ctx: {
      journeyId,
      childStore: (key) =>
        doStore(storage, (raw) => raw as UnblockState, `unblock:${key}`),
    },
  });
}
// #endregion durable-object

// ---------------------------------------------------------------------------
// It runs.
// ---------------------------------------------------------------------------

const BARRIER = "a cookie banner that traps focus";

/** A tester that asks for help once, then finishes. Reads the transcript. */
function testerBrain(seen: AgentMessage[][]): Brain {
  return async (messages) => {
    seen.push([...messages]);
    return messages.some((m) => m.role === "tool")
      ? { content: "journey done", toolCalls: [] }
      : {
          content: "stuck",
          toolCalls: [
            {
              callId: "c1",
              name: "request_unblock",
              args: { description: BARRIER },
            },
          ],
        };
  };
}

/** An unblocker that dismisses once, then reports. */
function unblockerBrain(seen: AgentMessage[][]): Brain {
  return async (messages) => {
    seen.push([...messages]);
    return messages.some((m) => m.role === "tool")
      ? {
          content: JSON.stringify({ outcome: "cleared", summary: "dismissed" }),
          toolCalls: [],
        }
      : {
          content: "dismissing",
          toolCalls: [
            { callId: "d1", name: "dismiss", args: { selector: "#banner" } },
          ],
        };
  };
}

describe("docs/how-to/delegate-to-a-sub-agent.md (#333) — the Promise engine", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tea-delegate-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the tester reads the unblocker's verdict, and each run has its own file", async () => {
    const testerSeen: AgentMessage[][] = [];
    const childSeen: AgentMessage[][] = [];
    const final = await testJourney(dir, "j1", {
      tester: testerBrain(testerSeen),
      unblocker: unblockerBrain(childSeen),
    });

    expect(final.output?.content).toBe("journey done");
    expect(testerSeen[1]?.at(-1)).toEqual({
      role: "tool",
      callId: "c1",
      name: "request_unblock",
      outcome: {
        kind: "ok",
        result: { outcome: "cleared", summary: "dismissed" },
      },
    });
    // The child was told the barrier and nothing of the tester's conversation.
    expect(childSeen[0]?.at(-1)).toEqual({
      role: "user",
      content: `Barrier: ${BARRIER}`,
    });
    expect((await readdir(dir)).sort()).toEqual([
      "j1.json",
      `${encodeURIComponent("unblock:j1/c1")}.json`,
    ]);
    const child = JSON.parse(
      await readFile(
        join(dir, `${encodeURIComponent("unblock:j1/c1")}.json`),
        "utf8",
      ),
    ) as UnblockState;
    expect(child.run.phase === "done" && child.run.runId).toBe("j1/c1");
  });

  it("a second run of the finished journey calls no model at all", async () => {
    const testerSeen: AgentMessage[][] = [];
    const childSeen: AgentMessage[][] = [];
    const again = await testJourney(dir, "j1", {
      tester: testerBrain(testerSeen),
      unblocker: unblockerBrain(childSeen),
    });
    expect(again.output?.content).toBe("journey done");
    expect(testerSeen).toEqual([]);
    expect(childSeen).toEqual([]);
  });
});

/** An in-memory `DurableObjectStorage`: the two methods `doStore` calls. */
function fakeStorage(backing: Map<string, unknown>): DurableObjectStorage {
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return backing.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      backing.set(key, value);
    },
  };
  return storage as unknown as DurableObjectStorage;
}

describe("docs/how-to/delegate-to-a-sub-agent.md (#333) — the Durable Object", () => {
  it("keeps the child's Model under its prefix in the parent's own storage", async () => {
    const backing = new Map<string, unknown>();
    const final = await testJourneyInDo(fakeStorage(backing), "j2", {
      tester: testerBrain([]),
      unblocker: unblockerBrain([]),
    });
    expect(final.output?.content).toBe("journey done");
    const keys = [...backing.keys()].filter((k) => !k.endsWith("@@version"));
    expect(keys.sort()).toEqual(["@@state", "unblock:j2/c1"]);
  });
});

// ---------------------------------------------------------------------------
// It cannot rot.
// ---------------------------------------------------------------------------

const page = fileURLToPath(
  new URL("../../../docs/how-to/delegate-to-a-sub-agent.md", import.meta.url),
);
const self = fileURLToPath(import.meta.url);

/** The text between one region's markers, which is what the page shows. */
async function region(name: string): Promise<string> {
  const source = await readFile(self, "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone`);
  return body.trimEnd();
}

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await readFile(page, "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

describe("docs/how-to/delegate-to-a-sub-agent.md (#333) — it cannot rot", () => {
  it.each([
    "child",
    "tool",
    "promise",
    "durable-object",
  ])("shows the compiled `%s` block verbatim", async (name) => {
    expect(await tsBlocks()).toContain(await region(name));
  });
});

/**
 * The keep-domain-state recipe's compile-and-run gate.
 *
 * `docs/how-to/keep-domain-state-in-the-model.md` gives a `defineAgent` agent a
 * `domain` slice. The page's blocks are this file's `#region` bodies
 * (`page-mirrors.ts` holds the row), and the tests run them against what the
 * page says of each: `continueWhen` and `stopWhen` read the slice the event
 * just produced, the slice ends in the Model `run` resolves with, and a run
 * resumed from a saved Model ends on the same slice.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentDomainEvent,
  type AgentMessage,
  type AgentTurn,
  type DefinedAgentState,
  defineAgent,
  type ToolResult,
  tool,
} from "../../agent";
import type { Store } from "../../index";
import { memoryStore } from "../../mem";

const lookup = tool(
  "lookup",
  {
    description: "Look one ticket up",
    input: z.object({ id: z.string() }),
    ok: z.object({ open: z.boolean() }),
    err: ["not_found"],
  },
  async ({ id }, _ctx, { ok, fail }) =>
    id === "missing" ? fail({ _tag: "not_found" }) : ok({ open: id !== "t3" }),
);

const IDS = ["t1", "t2", "missing", "t3"];

/** Looks one ticket up per turn, then answers. */
async function model(messages: readonly AgentMessage[]): Promise<AgentTurn> {
  const done = messages.filter((m) => m.role === "tool").length;
  const id = IDS[done];
  return id === undefined
    ? { content: "Triaged.", toolCalls: [] }
    : {
        content: `Looking up ${id}.`,
        toolCalls: [{ callId: `call-${id}`, name: "lookup", args: { id } }],
      };
}

// #region slice
interface Triage {
  readonly stage: "reading" | "closing";
  readonly open: readonly string[];
  readonly missing: number;
}

function step(
  slice: Triage,
  event: AgentDomainEvent<ToolResult<typeof lookup>>,
): Triage {
  if (event._tag !== "tool") return slice;
  const { call, outcome } = event;
  if (outcome.kind === "error") {
    return { ...slice, missing: slice.missing + 1 };
  }
  if (!outcome.result.open) return { ...slice, stage: "closing" };
  return { ...slice, open: [...slice.open, String(call.args.id)] };
}
// #endregion slice

// #region agent
const agent = defineAgent({
  model,
  tools: [lookup],
  instructions: "Triage the open tickets.",
  domain: {
    init: (): Triage => ({ stage: "reading", open: [], missing: 0 }),
    step,
  },
  stopWhen: (state) => state.domain.stage === "closing",
  continueWhen: (state) =>
    state.domain.open.length < 2 ? "Look up another ticket." : null,
});
// #endregion agent

describe("docs/how-to/keep-domain-state-in-the-model.md — it runs", () => {
  it("stops on the slice a tool outcome produced, with the slice on the resolved Model", async () => {
    // #region run
    const final = await agent.run("Triage t1 to t3.");

    final.domain; // { stage: "closing", open: ["t1", "t2"], missing: 1 }
    // #endregion run
    expect(final.run.phase).toBe("cancelled");
    expect(final.domain).toEqual({
      stage: "closing",
      open: ["t1", "t2"],
      missing: 1,
    });
  });

  it("ends a resumed run on the slice the uninterrupted one ended on", async () => {
    type S = DefinedAgentState<typeof lookup, Triage>;
    const live = memoryStore<S>();
    let parked: S | undefined;
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        if (parked === undefined && state.domain.missing === 1) {
          parked = JSON.parse(JSON.stringify(state)) as S;
        }
      },
    };
    const whole = await agent.run("Triage t1 to t3.", { store });
    const resumed = await agent.run("Triage t1 to t3.", {
      store: memoryStore(parked),
    });
    expect(parked?.run.phase).toBe("running");
    expect(resumed.domain).toEqual(whole.domain);
  });
});

/**
 * The typed tool-failure channel, worked end to end — the source the how-to
 * guide `docs/how-to/handle-a-tool-failure.md` quotes.
 *
 * Story: one `lookup` tool over a tiny in-memory table. It declares ONE failure
 * tag, `not_found`, and the handler names it with `fail`. The model is a scripted
 * lookup table — no keys, no network — that prints every `tool` message it is
 * handed before answering, so what you see on stdout is literally the content the
 * next brain call carries.
 *
 * The four failures it walks, in order:
 *   1. a declared failure   — `fail({ _tag: "not_found", key })`
 *   2. an undeclared throw  — arrives as `{ _tag: "thrown", message }`
 *   3. a hallucinated name  — the router mints `unknown_tool`
 *   4. args off the schema  — the router mints `malformed_args`
 *
 * Only the first is declared anywhere. The other three are why `err: []` never
 * means "this tool cannot fail".
 *
 * Run it:  node --experimental-strip-types examples/agent-tool-failure.ts
 */

import {
  type AgentMessage,
  type AgentTurn,
  defineAgent,
  tool,
} from "@demlik/tea/agent";
import { z } from "zod";

// ===========================================================================
// One tool that can fail. `err` is a list of `_tag` NAME string literals — not
// schemas — and each one is a failure the handler's `fail` may name.
// ===========================================================================

const TABLE: Record<string, string> = { blue: "#2563eb", red: "#dc2626" };

const lookup = tool(
  "lookup",
  {
    description: "Look up the hex code for a colour name",
    input: z.object({ key: z.string() }),
    ok: z.object({ hex: z.string() }),
    err: ["not_found"],
  },
  async ({ key }, _ctx, { ok, fail }) => {
    if (key === "boom") throw new Error("the table went away");
    const hex = TABLE[key];
    // `fail` takes the tagged value itself: `_tag` must be one of the literals
    // in `err`, and every other field rides along as detail.
    if (hex === undefined) return fail({ _tag: "not_found", key });
    return ok({ hex });
  },
);

// ===========================================================================
// The FAKE model — a script, plus a printer for the tool messages it receives.
// ===========================================================================

const SCRIPT: readonly AgentTurn[] = [
  {
    content: "Looking up two colours.",
    toolCalls: [
      { callId: "c1", name: "lookup", args: { key: "blue" } },
      { callId: "c2", name: "lookup", args: { key: "green" } },
    ],
  },
  {
    content: "Trying the one that breaks the table.",
    toolCalls: [{ callId: "c3", name: "lookup", args: { key: "boom" } }],
  },
  {
    content: "Trying a tool I invented.",
    toolCalls: [{ callId: "c4", name: "lookyp", args: { key: "blue" } }],
  },
  {
    content: "Trying the right tool with the wrong argument type.",
    toolCalls: [{ callId: "c5", name: "lookup", args: { key: 42 } }],
  },
  { content: "Blue is #2563eb; everything else failed.", toolCalls: [] },
];

let turn = 0;

async function model(messages: readonly AgentMessage[]): Promise<AgentTurn> {
  for (const m of messages) {
    if (m.role === "tool" && !printed.has(m.callId)) {
      printed.add(m.callId);
      console.log(`${m.callId} ${m.name} → ${JSON.stringify(m.outcome)}`);
    }
  }
  const next = SCRIPT[turn];
  turn += 1;
  return next ?? { content: "done", toolCalls: [] };
}

const printed = new Set<string>();

const agent = defineAgent({
  model,
  tools: [lookup],
  instructions: "You look colours up.",
});

const final = await agent.run("Find the hex code for blue and for green.");
console.log("done:", final.output?.content);

/*
 * What it prints — the `outcome` half of each line is exactly the `ToolOutcome`
 * the adapter renders into the provider's `tool_result` block:
 *
 *   c1 lookup → {"kind":"ok","result":{"hex":"#2563eb"}}
 *   c2 lookup → {"kind":"error","reason":"not_found {\"key\":\"green\"}"}
 *   c3 lookup → {"kind":"error","reason":"thrown {\"message\":\"the table went away\"}"}
 *   c4 lookyp → {"kind":"error","reason":"unknown_tool {\"name\":\"lookyp\"}"}
 *   c5 lookup → {"kind":"error","reason":"malformed_args {\"name\":\"lookup\",\"issues\":[{\"path\":\"key\",\"message\":\"Invalid input: expected string, received number\"}]}"}
 *   done: Blue is #2563eb; everything else failed.
 */

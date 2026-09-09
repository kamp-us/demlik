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
 * Each one reaches the model as a `reason` string AND the host's `onToolError`
 * as `{ _tag, …payload }` — two readers, one failure, neither lossy.
 *
 * Only the first is declared anywhere. The other three are why `err: []` never
 * means "this tool cannot fail".
 *
 * Then a fifth and a sixth, from the `timeoutMs` / `retry` knob on the spec:
 * `timeout` when a call outlives its budget, and `retry_exhausted` when it spends
 * one. Both settle as the SAME `{ kind: "error", reason }` the other four do.
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
// A tool that is SLOW rather than wrong. `timeoutMs` caps one call and `retry`
// gives a failed attempt a ladder to climb — both run in the reducer, so the
// wait is on the Model and a crash mid-ladder resumes at the attempt it was on.
// ===========================================================================

let rateAttempts = 0;

const fetchRate = tool(
  "fetch_rate",
  {
    description: "Fetch today's exchange rate from the upstream service",
    input: z.object({ pair: z.string() }),
    ok: z.object({ rate: z.number() }),
    err: ["upstream"],
    // One call gets 50ms, first attempt to last — a retry does not restart it.
    timeoutMs: 50,
    // …and a failed attempt is retried twice more, 10ms apart.
    retry: { baseMs: 10, factor: 1, capMs: 10, jitter: "none", maxAttempts: 3 },
  },
  async ({ pair }, _ctx, { ok, fail }) => {
    rateAttempts += 1;
    // `usd_eur` is down for good — it burns the ladder and settles exhausted.
    if (pair === "usd_eur") return fail({ _tag: "upstream" });
    // `usd_jpy` is not down, just far too slow — the budget ends the call and
    // the loop moves on without waiting for the attempt still in flight.
    await new Promise((r) => setTimeout(r, 500));
    return ok({ rate: 1 });
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
  {
    content: "Trying an upstream that is down, and one that is merely slow.",
    toolCalls: [
      { callId: "c6", name: "fetch_rate", args: { pair: "usd_eur" } },
      { callId: "c7", name: "fetch_rate", args: { pair: "usd_jpy" } },
    ],
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

// `onToolError` is the HOST's channel onto the same failure the model reads:
// the outcome carries `_tag` and its payload structurally, so this switch is
// exhaustive and a failure mode nobody handled is a compile error.
const agent = defineAgent({
  model,
  tools: [lookup, fetchRate],
  instructions: "You look colours up.",
  onToolError: (outcome, { name }) => {
    switch (outcome._tag) {
      case "not_found":
        return console.log(`hook: ${name} missed the key ${outcome.key}`);
      case "unknown_tool":
        return console.log(`hook: no tool called ${name}`);
      default:
        return console.log(`hook: ${name} failed with ${outcome._tag}`);
    }
  },
});

const final = await agent.run("Find the hex code for blue and for green.");
console.log("done:", final.output?.content);

/*
 * What it prints. Each `outcome` is exactly what the adapter renders into the
 * provider's `tool_result` block — the tag and its payload beside the `reason`
 * the model reads. `kind` and `reason` are written LAST, so a payload field of
 * either name can never shadow them:
 *
 *   hook: lookup missed the key green
 *   c1 lookup → {"kind":"ok","result":{"hex":"#2563eb"}}
 *   c2 lookup → {"_tag":"not_found","key":"green","reason":"not_found {\"key\":\"green\"}","kind":"error"}
 *   hook: lookup failed with thrown
 *   c3 lookup → {"_tag":"thrown","message":"the table went away","reason":"thrown {\"message\":\"the table went away\"}","kind":"error"}
 *   hook: no tool called lookyp
 *   c4 lookyp → {"_tag":"unknown_tool","name":"lookyp","reason":"unknown_tool {\"name\":\"lookyp\"}","kind":"error"}
 *   hook: lookup failed with malformed_args
 *   c5 lookup → {"_tag":"malformed_args","name":"lookup",…,"kind":"error"}
 *   hook: fetch_rate failed with upstream
 *   hook: fetch_rate failed with upstream
 *   hook: fetch_rate failed with upstream
 *   hook: fetch_rate failed with retry_exhausted
 *   c6 fetch_rate → {"_tag":"retry_exhausted","attempts":3,"last":"upstream","reason":"retry_exhausted {\"attempts\":3,\"last\":\"upstream\"}","kind":"error"}
 *   c7 fetch_rate → {"_tag":"timeout","reason":"timeout","kind":"error"}
 *   hook: fetch_rate failed with timeout
 *   done: Blue is #2563eb; everything else failed.
 *
 * `c6` ran the handler three times and the model is told so; `c7` ran it once
 * and was over at 50ms, while that attempt was still sleeping out its 500ms.
 *
 * Read the `fetch_rate` lines against the two seams the hook has (#115 + #117).
 * The three bare `upstream` ones are ATTEMPTS, announced from the interpret
 * boundary as each handler settles — the model is told about none of them,
 * because the ladder absorbed them. `retry_exhausted` and `timeout` are the
 * CALLS ending, and the reducer mints those, so they are announced off the fold
 * instead: which is why `timeout` prints after `c7`'s record rather than before.
 */
